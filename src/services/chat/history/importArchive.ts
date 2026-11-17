import * as db from '../db.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { selectInRange, type BackupOptions } from './range.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession, type LocalSession } from './toLocal.js'
import type { Session } from '../types.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readEntry,
  skipEntry,
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
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await (await readEntry(entry)).text()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/**
 * 检查 ZIP 格式、首个 manifest 条目及格式版本。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
export const checkArchiveFormat = async (file: File): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    for await (const entry of readArchive(file)) {
      if (entry.path !== MANIFEST_PATH) {
        fail('backupUnrecognized')
      }
      checkManifest(await readJson(entry))
      return
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  fail('backupUnrecognized')
}

/**
 * 流式导入：manifest → user（不导入）→ 全部会话 JSON → index → 全部图片。
 * 也支持会话与图片交错排列、index 位于末尾的条目顺序。
 *
 * 范围为「全部」时读到会话立即暂存，内存占用最小；
 * 指定天数或条数时先把会话留在内存，读完 index 后按 updatedAt 筛选再暂存，
 * 因此需要标准条目顺序（index 在图片之前），否则图片会被跳过。
 */
export const importArchive = async (file: File, options: BackupOptions): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const imported = new Set<string>()
  const images = new Map<string, string>()
  /** 已保存的原件：文件 ID → MIME。同一图片出现在多个会话目录时只保存一次。 */
  const stored = new Map<string, string>()
  const streaming = options.range.kind === 'all'
  const pending: LocalSession[] = []
  /** 批量写缓冲：SQLite 单条写入很快，但一次 IPC 写一批远胜逐条往返 */
  const sessionBuffer: Session[] = []
  const fileBuffer: { id: string; blob: Blob }[] = []
  const SESSION_BATCH = 64
  const FILE_BATCH = 16
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  let currentSessionId: string | undefined
  let kept = 0

  const flushBuffers = async () => {
    if (sessionBuffer.length > 0) {
      const batch = sessionBuffer.splice(0)
      await db.addStagingSessions(batch)
      kept += batch.length
    }
    if (fileBuffer.length > 0) {
      const batch = fileBuffer.splice(0)
      await db.saveStagingFiles(batch)
    }
  }

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    const data = await readEntry(entry)
    const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
    fileBuffer.push({ id, blob: new Blob([data as BlobPart], { type }) })
    stored.set(id, type)
    if (fileBuffer.length >= FILE_BATCH) {
      await flushBuffers()
    }
  }

  /** 只登记保留会话的图片，跳过的会话其图片条目会被忽略 */
  const commitSession = async (local: LocalSession) => {
    for (const [imagePath, id] of local.images) {
      images.set(imagePath, id)
    }
    sessionBuffer.push(local.session)
    if (sessionBuffer.length >= SESSION_BATCH) {
      await flushBuffers()
    }
  }

  const flushPending = async () => {
    const ordered = pending.map((item) => ({
      id: item.session.id,
      updatedAt: item.session.updatedAt,
    }))
    const keep = new Set(
      selectInRange(ordered, (item) => item.updatedAt, options.range, Date.now()).map(
        (item) => item.id
      )
    )
    for (const local of pending) {
      if (keep.has(local.session.id)) {
        await commitSession(local)
      }
    }
    pending.length = 0
  }

  try {
    for await (const entry of readArchive(file, (done, total) =>
      options.onProgress?.({ done, total })
    )) {
      const { path } = entry
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        checkManifest(await readJson(entry))
        manifest = true
      } else if (path === USER_PATH && !index && imported.size === 0) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        currentSessionId = sessionId
        if (streaming) {
          await commitSession(local)
        } else {
          pending.push(local)
        }
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
        if (!streaming) {
          await flushPending()
        }
      } else if (
        index
          ? imported.has(/^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? '')
          : currentSessionId && path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        // 没有被引用的条目不保存，引用了但缺失的图片只展示文件名。
        const id = images.get(path)
        await (id === undefined ? skipEntry(entry) : saveImage(entry, id))
      } else {
        fail('backupIncomplete')
      }
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (!manifest) {
    fail('backupUnrecognized')
  }
  // index 位于末尾或缺失时补一次筛选
  if (!streaming && pending.length > 0) {
    await flushPending()
  }
  // 把缓冲里的会话与图片全部落库，再做完整性校验与类型回填
  await flushBuffers()
  // index 只列出成功写出的会话，与会话文件一一对应。
  const listed = new Set(index?.map((entry) => entry.id))
  if (
    !index ||
    listed.size !== index.length ||
    listed.size !== imported.size ||
    [...imported].some((id) => !listed.has(id))
  ) {
    fail('backupIncomplete')
  }
  if (!streaming && kept === 0) {
    fail('backupEmptyRange')
  }
  await db.updateStagingFileTypes(stored)
}
