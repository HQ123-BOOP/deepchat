import * as db from '../db.js'
import { BackupError, fail } from './errors.js'
import type { Session } from '../types.js'
import { INDEX_PATH, MANIFEST_PATH, parseSessionPath, sessionFilesDir, USER_PATH } from './paths.js'
import { selectInRange, type BackupOptions } from './range.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession, type LocalSession } from './toLocal.js'
import {
  ArchiveError,
  isZipFile,
  listArchivePaths,
  readArchiveEntry,
  readSelectedArchive,
  type ArchiveEntry,
} from './zipReader.js'

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  return ''
}

const readEntryBlob = async (entry: ArchiveEntry): Promise<Blob> => {
  const parts: Uint8Array[] = []
  for await (const chunk of entry.stream) {
    parts.push(chunk)
  }
  // 保留字节块交给 Blob 构造器一次性组装，避免上千个小对象。
  return new Blob(parts as BlobPart[])
}

/**
 * 丢弃条目内容但读完并校验 CRC：readSelectedArchive 要求每个选中的条目都被消费，
 * 未消费就请求下一条会被判定为归档损坏。
 */
const drainEntry = async (entry: ArchiveEntry): Promise<void> => {
  const reader = entry.stream[Symbol.asyncIterator]()
  while (!(await reader.next()).done) {
    // 丢弃数据，只为完成 CRC 校验。
  }
}

/**
 * 条目分类校验（基于中央目录文件名，不解压）：
 * 只允许 manifest、user、index、会话 JSON 与会话图片目录，其余一律视为归档不完整。
 */
const validateEntryPaths = (paths: string[]): void => {
  for (const path of paths) {
    if (
      path !== MANIFEST_PATH &&
      path !== USER_PATH &&
      path !== INDEX_PATH &&
      parseSessionPath(path) === null &&
      !/^chat_sessions\/[^/]+_files\//.test(path)
    ) {
      fail('backupIncomplete')
    }
  }
}

/**
 * 确认 ZIP 格式与版本：manifest 必须存在（不解压其余条目），版本校验沿用原规则。
 */
export const checkArchiveFormat = async (file: File): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    const paths = await listArchivePaths(file)
    if (!paths.includes(MANIFEST_PATH)) {
      fail('backupUnrecognized')
    }
    checkManifest(JSON.parse(await (await readArchiveEntry(file, MANIFEST_PATH)).text()))
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
}

/**
 * 选择性导入：先读中央目录与 index（两个小条目），按范围算出保留会话，
 * 再只解压保留会话的 JSON 与对应图片——跳过的条目完全不读取，耗时与所选范围成正比。
 * CRC 与大小校验只覆盖实际解压的条目。
 */
export const importArchive = async (file: File, options: BackupOptions): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const paths = await listArchivePaths(file)
  if (!paths.includes(MANIFEST_PATH)) {
    fail('backupUnrecognized')
  }
  validateEntryPaths(paths)
  if (!paths.includes(INDEX_PATH)) {
    fail('backupIncomplete')
  }

  try {
    checkManifest(JSON.parse(await (await readArchiveEntry(file, MANIFEST_PATH)).text()))
    const index = readSessionIndex(
      JSON.parse(await (await readArchiveEntry(file, INDEX_PATH)).text())
    )
    // index 自带每会话的 updated_at（ISO 时间），范围筛选不解压任何会话 JSON
    const keepIds = new Set(
      selectInRange(
        index.map((entry) => ({ id: entry.id, updatedAt: Date.parse(entry.updated_at) })),
        (item) => item.updatedAt,
        options.range,
        Date.now()
      ).map((item) => item.id)
    )
    // index 只列出成功写出的会话，与目录中的会话 JSON 文件一一对应。
    const listed = new Set(index.map((entry) => entry.id))
    const onDisk = new Set(paths.map(parseSessionPath).filter((id): id is string => id !== null))
    if (
      listed.size !== index.length ||
      listed.size !== onDisk.size ||
      [...listed].some((id) => !onDisk.has(id))
    ) {
      fail('backupIncomplete')
    }
    if (options.range.kind !== 'all' && keepIds.size === 0) {
      fail('backupEmptyRange')
    }

    const keepFiles = new Set([...keepIds].map((id) => `chat_sessions/${id}.json`))
    const keepDirs = new Set([...keepIds].map(sessionFilesDir))
    const keep = (path: string) =>
      keepFiles.has(path) || keepDirs.has(path.slice(0, path.lastIndexOf('/') + 1))

    const imported = new Set<string>()
    const images = new Map<string, string>()
    /** 已保存的原件：文件 ID → MIME。同一图片出现在多个会话目录时只保存一次。 */
    const stored = new Map<string, string>()
    const sessionBuffer: Session[] = []
    const fileBuffer: { id: string; blob: Blob }[] = []
    // 移动端 IPC 对单次 payload 很敏感：会话每批 16 条；
    // 图片按累计 3MB 或 8 张切批，小图少往返、大图不超限。
    const SESSION_BATCH = 16
    const FILE_BATCH = 8
    const FILE_BATCH_BYTES = 3 * 1024 * 1024
    let fileBytes = 0
    let kept = 0

    const flushBuffers = async () => {
      if (sessionBuffer.length > 0) {
        const batch = sessionBuffer.splice(0)
        await db.addStagingSessions(batch)
        kept += batch.length
      }
      if (fileBuffer.length > 0) {
        const batch = fileBuffer.splice(0)
        fileBytes = 0
        await db.saveStagingFiles(batch)
      }
    }

    const commitSession = (local: LocalSession) => {
      for (const [imagePath, id] of local.images) {
        images.set(imagePath, id)
      }
      sessionBuffer.push(local.session)
      if (sessionBuffer.length >= SESSION_BATCH) {
        void flushBuffers()
      }
    }

    const saveImage = async (entry: ArchiveEntry) => {
      const id = images.get(entry.path)
      // 未登记（未保留会话）或已保存过的图片：读完丢弃，保证条目被完整消费
      if (id === undefined || stored.has(id)) {
        await drainEntry(entry)
        return
      }
      const data = await readEntryBlob(entry)
      const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
      fileBuffer.push({ id, blob: new Blob([data as BlobPart], { type }) })
      stored.set(id, type)
      fileBytes += data.size
      if (fileBuffer.length >= FILE_BATCH || fileBytes >= FILE_BATCH_BYTES) {
        await flushBuffers()
      }
    }

    // 解压按 64KB 回调一次；直接转发会让设置页每 64KB 重渲染一次，
    // 二十来条会话就能堆出上千次渲染。这里按 120ms 节流。
    let lastProgress = 0
    const reportProgress = (done: number, total: number, force = false) => {
      const now = Date.now()
      if (!force && now - lastProgress < 120) {
        return
      }
      lastProgress = now
      options.onProgress?.({ done, total })
    }

    for await (const entry of readSelectedArchive(file, keep, (done, total) =>
      reportProgress(done, total)
    )) {
      const sessionId = parseSessionPath(entry.path)
      if (sessionId !== null) {
        const local = toLocalSession(
          readSessionFile(JSON.parse(await (await readEntryBlob(entry)).text()))
        )
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        commitSession(local)
        continue
      }
      // 会话图片；属于保留会话的才解压保存
      await saveImage(entry)
    }
    await flushBuffers()
    if (options.range.kind !== 'all' && kept === 0) {
      fail('backupEmptyRange')
    }
    await db.updateStagingFileTypes(stored)
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
}
