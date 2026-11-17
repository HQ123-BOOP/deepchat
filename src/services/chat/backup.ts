import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import { selectInRange, type BackupOptions } from './history/range.js'
import { mergeHistory, replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

import { BackupError } from './history/errors.js'

export { BackupError }
export type { BackupOptions, BackupProgress, BackupRange } from './history/range.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/**
 * 导入先把归档写进暂存表，提交时再复制到正式表，两份数据会短暂共存：
 * 因此按未压缩体积的 2.2 倍估算所需空间，空间不足时在写入前拒绝，
 * 避免写到一半磁盘满导致数据库损坏。
 */
const assertImportSpace = async (file: File): Promise<void> => {
  const { archiveUncompressedSize } = await import('./history/zipReader.js')
  const needed = (await archiveUncompressedSize(file)) * 2.2 + 64 * 1024 * 1024
  const free = await db.freeSpace()
  if (free < needed) {
    throw new BackupError('backupNotEnoughSpace')
  }
}

/** 按范围导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (options: BackupOptions): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    const now = new Date()
    const selected = selectInRange(
      sessions,
      (summary) => summary.updatedAt,
      options.range,
      now.getTime()
    )
    if (selected.length === 0) {
      throw new BackupError('backupEmptyRange')
    }
    let done = 0
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of selected) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
        done += 1
        options.onProgress?.({ done, total: selected.length })
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const blob = await exportArchive(readSessions(), { total: selected.length })
    return { name: backupFileName(now), blob }
  })

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
/** 导入归档：会话合并进现有历史，重复的按更新时间保留较新版本，不覆盖整库。 */
export const importHistory = (file: File, options: BackupOptions): Promise<number> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    await assertImportSpace(file)
    return mergeHistory(async () => {
      // 先取本地版本，导入时可跳过本地已是最新的会话，不再解压它们
      const existing = await db.loadSessionVersions()
      return importArchive(file, options, existing)
    })
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
