/** 备份范围：全部、最近 N 天、最新的 N 条 */
export type BackupRange =
  | { kind: 'all' }
  | { kind: 'days'; days: number }
  | { kind: 'latest'; count: number }

/** 处理进度，total 为本次范围内的会话数或归档条目数 */
export type BackupProgress = { done: number; total: number }

export type BackupOptions = {
  range: BackupRange
  onProgress?: (progress: BackupProgress) => void
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 按范围筛选并保持原有顺序；天数按 updatedAt 从 now 往前算 */
export const selectInRange = <T extends { id: string }>(
  items: readonly T[],
  time: (item: T) => number,
  range: BackupRange,
  now: number
): T[] => {
  if (range.kind === 'days') {
    const since = now - range.days * DAY_MS
    return items.filter((item) => time(item) >= since)
  }
  if (range.kind === 'latest') {
    const keep = new Set(
      [...items]
        .sort((a, b) => time(b) - time(a))
        .slice(0, range.count)
        .map((item) => item.id)
    )
    return items.filter((item) => keep.has(item.id))
  }
  return [...items]
}
