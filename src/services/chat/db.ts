import type { Session, SessionSummary } from './types.js'

/**
 * 主存储已迁移到 SQLite（Rust 侧 rusqlite），本模块是前端唯一的数据入口：
 * 所有函数只是 Tauri 命令的薄封装，签名与旧 IndexedDB 版保持一致，调用方无需改动。
 * 升级即清空旧数据（BREAKING CHANGE）；模块加载时后台删除遗留的 IndexedDB 数据库。
 */

/** 与 desktop.ts / localAsr.ts 共用 __TAURI_INTERNALS__，不额外引入 @tauri-apps/api */
type TauriInternals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

const getInternals = () =>
  (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__

const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const internals = getInternals()
  if (!internals) {
    throw new Error('Storage commands require the Tauri shell')
  }
  return (await internals.invoke(cmd, args)) as T
}

const DB_FILE_ID = 'chat-demo'

export type DatabaseHealth = {
  /** 磁盘上的库无法打开，当前连接指向内存中的临时空库 */
  corrupt: boolean
  path: string
}

/** 启动时查询数据库状态：损坏时前端弹恢复对话框，而不是让应用崩溃。 */
export const health = (): Promise<DatabaseHealth> => invoke('db_health')

/** 重试打开损坏的库；返回是否恢复成功。 */
export const retryOpen = (): Promise<boolean> => invoke('db_retry')

/** 备份损坏的库并重建空库；返回备份文件路径。 */
export const rebuild = (): Promise<string> => invoke('db_rebuild')

/** 数据库所在磁盘的可用字节数。 */
export const freeSpace = (): Promise<number> => invoke('db_free_space')

// 遗留的 IndexedDB 已不再是数据源；静默删除以释放空间，失败不影响使用。
if (typeof indexedDB !== 'undefined') {
  void (() => {
    try {
      const request = indexedDB.deleteDatabase(DB_FILE_ID)
      request.onsuccess = request.onerror = request.onblocked = () => {}
    } catch {
      // 某些环境删除旧库会抛异常，忽略。
    }
  })()
}

/** Uint8Array → base64：按块 btoa，块小一些避免 Android WebView 的参数栈上限。 */
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x2000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

const base64ToBytes = (data: string): Uint8Array => {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}


/** 附件字节转传输结构 */
const toDbFile = async (file: { id: string; blob: Blob }) => {
  const bytes = new Uint8Array(await file.blob.arrayBuffer())
  return { id: file.id, mime: file.blob.type, data: bytesToBase64(bytes) }
}

/** Rust 侧返回的是摘要 JSON 文本，这里解析成列表项 */
const toSessionSummaryOf = (value: string): SessionSummary => {
  const item = JSON.parse(value) as SessionSummary
  return {
    id: item.id,
    title: item.title,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    mode: item.mode,
  }
}

export type StoredFile = {
  id: string
  blob: Blob
}

export type StoredFileText = {
  id: string
  name: string
  text: string
  pages: number
  purpose: 'text_recognition' | 'rich_layout_recognition'
  createdAt: number
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const rows = await invoke<string[]>('db_load_summaries_page', {
    limit: -1,
    beforeUpdatedAt: null,
    beforeId: null,
  })
  return rows.map(toSessionSummaryOf)
}

/** 按 updatedAt 倒序分页取会话摘要；before 为上一页最后一项。分页在 SQL 里完成。 */
export const loadSessionSummariesPage = async (
  limit: number,
  before?: { updatedAt: number; id: string }
): Promise<SessionSummary[]> => {
  const rows = await invoke<string[]>('db_load_summaries_page', {
    limit,
    beforeUpdatedAt: before?.updatedAt ?? null,
    beforeId: before?.id ?? null,
  })
  return rows.map(toSessionSummaryOf)
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  // 分块读取：长会话的 JSON 可能数 MB，一次读取在移动端会失败或卡住
  const total = await invoke<number | null>('db_load_session_len', { id })
  if (total === null) {
    return undefined
  }
  let text = ''
  for (let offset = 0; offset < total; offset += CHUNK_CHARS) {
    text += await invoke<string>('db_load_session_chunk', {
      id,
      offset,
      len: CHUNK_CHARS,
    })
  }
  return JSON.parse(text) as Session
}

/** 分块大小（UTF-16 码元）：Android 的 IPC 不适合一次传数 MB 的 JSON */
const CHUNK_CHARS = 256 * 1024

/** 按码元切块，但不把代理对（emoji）切开，否则单块 JSON 可能产生孤立代理项 */
const chunksOf = (text: string): string[] => {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length)
    if (end < text.length) {
      const code = text.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) {
        end -= 1
      }
    }
    if (end <= start) {
      break
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

/** 每个会话一条写入队列：保证后发起的保存一定后落库，避免旧快照覆盖新数据。 */
const saveQueues = new Map<string, Promise<void>>()

const summaryOf = (session: Session) => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  mode: session.mode,
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

/**
 * 保存会话：分块写入，附件单独走 db_save_files。
 * 附件读取或传输失败不会再让整个会话写不进去；同一会话的写入串行执行。
 */
export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const previous = saveQueues.get(session.id) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    if (files.length > 0) {
      await invoke('db_save_files', { files: await Promise.all(files.map(toDbFile)) })
    }
    const payload = JSON.stringify(session)
    await invoke('db_session_write_begin', { id: session.id })
    for (const chunk of chunksOf(payload)) {
      await invoke('db_session_write_chunk', { id: session.id, chunk })
    }
    await invoke('db_session_write_commit', {
      save: {
        sessionId: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        data: '',
        summary: JSON.stringify(summaryOf(session)),
        files: [],
      },
    })
  })
  saveQueues.set(session.id, task)
  try {
    await task
  } finally {
    if (saveQueues.get(session.id) === task) {
      saveQueues.delete(session.id)
    }
  }
}

/** 未打开的会话也可重命名：读取、改标题后整会话回存。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const session = await loadSession(id)
  if (session) {
    session.title = title
    await saveSession(session)
  }
}

/** 删除会话，Rust 侧按引用计数清理不再被引用的附件原件与识别文本。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  await invoke('db_delete_session', { id: sessionId })
}

export const saveFiles = async (files: StoredFile[]): Promise<void> => {
  await invoke('db_save_files', { files: await Promise.all(files.map(toDbFile)) })
}

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const file = await invoke<{ mime: string; data: string } | null>('db_load_file', { id })
  if (!file) {
    return undefined
  }
  return new Blob([base64ToBytes(file.data) as BlobPart], { type: file.mime })
}

/** 保存一次 OCR 结果；同一附件重新解析时直接覆盖。 */
export const saveFileText = async (doc: StoredFileText): Promise<void> => {
  await invoke('db_save_file_text', { id: doc.id, doc: JSON.stringify(doc) })
}

export const loadFileText = async (id: string): Promise<StoredFileText | undefined> => {
  const doc = await invoke<string | null>('db_load_file_text', { id })
  return doc === null ? undefined : (JSON.parse(doc) as StoredFileText)
}

/** 清空导入暂存：开始导入前清除上次中断遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  await invoke('db_clear_staging')
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await addStagingSessions([session])
}

/**
 * 批量暂存：按序列化后的字节数切批（每批不超过约 400K 字符），
 * 既避免逐条 IPC 往返，也避免移动端一次传输过大。
 */
export const addStagingSessions = async (sessions: Session[]): Promise<void> => {
  const saves = sessions.map((session) => ({
    sessionId: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    data: JSON.stringify(session),
    summary: JSON.stringify(summaryOf(session)),
    files: [],
  }))
  const BATCH_CHARS = 400 * 1024
  let batch: typeof saves = []
  let size = 0
  const flush = async () => {
    if (batch.length > 0) {
      await invoke('db_add_staging_sessions', { saves: batch })
      batch = []
      size = 0
    }
  }
  for (const save of saves) {
    if (batch.length > 0 && size + save.data.length > BATCH_CHARS) {
      await flush()
    }
    batch.push(save)
    size += save.data.length
  }
  await flush()
}

export const saveStagingFiles = async (files: StoredFile[]): Promise<void> => {
  await invoke('db_save_staging_files', { files: await Promise.all(files.map(toDbFile)) })
}

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  await invoke('db_update_staging_file_types', { types: [...types.entries()] })
}

/**
 * 导入完成后用暂存替换正式数据；Rust 侧在同一事务中完成，返回摘要列表。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const rows = await invoke<string[]>('db_commit_staging')
  return rows.map(toSessionSummaryOf)
}

export type MergeResult = {
  /** 实际写入的会话数：新增的，以及覆盖了更旧本地版本的部分 */
  imported: number
  /** 合并后的全部会话摘要 */
  summaries: SessionSummary[]
}

/** 合并暂存：按 id 去重，导入版本更新才覆盖；本地同样新或更新的会话保留原样 */
export const mergeStaging = async (): Promise<MergeResult> => {
  const result = await invoke<{ imported: number; summaries: string[] }>('db_merge_staging')
  return {
    imported: result.imported,
    summaries: result.summaries.map(toSessionSummaryOf),
  }
}

/** 全对话内容搜索：标题与消息文本（含思考、工具查询）都参与匹配。 */
export const searchConversations = async (
  query: string
): Promise<
  {
    sessionId: string
    title: string
    updatedAt: number
    count: number
    snippets: { text: string; offset: number }[]
  }[]
> => {
  return await invoke('db_search', { query })
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
