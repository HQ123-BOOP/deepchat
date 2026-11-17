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

/** Uint8Array → base64：按块 btoa，避免一次编码大文件时超出参数长度限制。 */
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
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

/**
 * 抽取会话的全部可搜索文本：用户提问、助手正文与思考、工具调用的查询词与网址。
 * 搜索在 Rust 侧对这段拼接文本做大小写不敏感的子串匹配。
 */
const extractSearchText = (session: Session): string => {
  const parts: string[] = [session.title]
  for (const message of session.messages) {
    if (message.role === 'user') {
      if (message.content) {
        parts.push(message.content)
      }
      continue
    }
    for (const block of message.blocks) {
      if (block.type === 'text') {
        parts.push(block.text)
      } else if (block.type === 'thinking') {
        parts.push(block.thinking)
      } else if (block.type === 'server_tool_use') {
        if (block.input.action === 'search') {
          parts.push(...block.input.queries)
        } else if (block.input.url) {
          parts.push(block.input.url)
        }
        if ('pattern' in block.input && block.input.pattern) {
          parts.push(block.input.pattern)
        }
      }
    }
  }
  return parts.join(' ')
}

/** 附件字节转传输结构 */
const toDbFile = async (file: { id: string; blob: Blob }) => {
  const bytes = new Uint8Array(await file.blob.arrayBuffer())
  return { id: file.id, mime: file.blob.type, data: bytesToBase64(bytes) }
}

const toSessionSummaryOf = (value: unknown): SessionSummary => {
  const item = value as SessionSummary
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
  const data = await invoke<string | null>('db_load_session', { id })
  return data === null ? undefined : (JSON.parse(data) as Session)
}

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = {
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
  }
  await invoke('db_save_session', {
    save: {
      sessionId: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      data: JSON.stringify(session),
      summary: JSON.stringify(summary),
      searchText: extractSearchText(session),
      files: await Promise.all(files.map(toDbFile)),
    },
  })
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

/** 批量暂存：一次 IPC 写一批会话，导入大归档时避免逐条往返 */
export const addStagingSessions = async (sessions: Session[]): Promise<void> => {
  const saves = sessions.map((session) => {
    const summary = {
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
    }
    return {
      sessionId: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      data: JSON.stringify(session),
      summary: JSON.stringify(summary),
      searchText: extractSearchText(session),
      files: [],
    }
  })
  await invoke('db_add_staging_sessions', { saves })
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
