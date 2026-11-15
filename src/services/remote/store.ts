/**
 * 「工作」模式的连接状态：本机局域网里的 dsh-lan-bridge。
 *
 * 手机/桌面都只是遥控器：会话、工具、文件都在电脑上，这里只保存连接信息和
 * 用于渲染的消息快照；令牌走系统凭据库（见 secureStore）。
 */
import { create } from 'zustand'
import {
  cancelSession,
  listSessions,
  fetchHistory,
  pair,
  sendMessage,
  subscribe,
  type BridgeSession,
} from './bridgeClient.js'
import { secureDelete, secureGet, secureSet } from './secureStore.js'

const HOST_KEY = 'chat-demo:bridge-host'
const PORT_KEY = 'chat-demo:bridge-port'
const TOKEN_KEY = 'bridge-token'

export type WorkMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  thinking: string
  note: string
  /** 工具卡片：名称、入参、输出 */
  name?: string
  input?: string
  output?: string
}

type WorkState = {
  host: string
  port: number
  token: string | null
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error: string | null
  sessions: BridgeSession[]
  activeSessionId: string | null
  messages: WorkMessage[]
  streaming: boolean
  /** 历史是否还有更早的内容，以及正在加载时的占位状态 */
  hasMore: boolean
  historyLoading: boolean
}

type WorkActions = {
  restore: () => Promise<void>
  connect: (host: string, port: number, code: string) => Promise<void>
  disconnect: () => Promise<void>
  refresh: () => Promise<void>
  openSession: (sessionId: string) => void
  closeSession: () => void
  loadOlder: () => Promise<void>
  send: (text: string) => Promise<void>
  cancel: () => Promise<void>
}

let counter = 0
const nextId = () => `m${++counter}`
let unsubscribe: (() => void) | null = null

const readPort = () => {
  const raw = Number(localStorage.getItem(PORT_KEY))
  return Number.isFinite(raw) && raw > 0 ? raw : 18923
}

export const useWorkStore = create<WorkState & WorkActions>((set, get) => ({
  host: localStorage.getItem(HOST_KEY) ?? '',
  port: readPort(),
  token: null,
  status: 'disconnected',
  error: null,
  sessions: [],
  activeSessionId: null,
  messages: [],
  streaming: false,
  hasMore: false,
  historyLoading: false,

  restore: async () => {
    const token = await secureGet(TOKEN_KEY)
    if (!token) {
      return
    }
    set({ token, status: 'connected' })
    await get()
      .refresh()
      .catch((error: Error) => set({ error: error.message }))
  },

  connect: async (host, port, code) => {
    set({ status: 'connecting', error: null })
    try {
      const { token } = await pair(host, port, code, 'chat-demo')
      localStorage.setItem(HOST_KEY, host)
      localStorage.setItem(PORT_KEY, String(port))
      await secureSet(TOKEN_KEY, token)
      set({ host, port, token, status: 'connected' })
      await get().refresh()
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  },

  disconnect: async () => {
    unsubscribe?.()
    unsubscribe = null
    await secureDelete(TOKEN_KEY)
    set({
      token: null,
      status: 'disconnected',
      sessions: [],
      activeSessionId: null,
      messages: [],
      error: null,
    })
  },

  refresh: async () => {
    const { host, port, token } = get()
    if (!token) {
      return
    }
    const sessions = await listSessions(host, port, token)
    set({ sessions })
  },

  openSession: (sessionId) => {
    unsubscribe?.()
    set({
      activeSessionId: sessionId,
      messages: [],
      streaming: false,
      hasMore: false,
      historyLoading: true,
    })
    const { host, port, token } = get()
    if (!token) {
      set({ historyLoading: false })
      return
    }
    // 先取最近 20 条，再订阅增量；更早的内容由 loadOlder 按需拉取
    void fetchHistory(host, port, token, sessionId, { limit: 20 })
      .then((page) => {
        if (get().activeSessionId !== sessionId) {
          return
        }
        set((state) =>
          state.messages.length > 0
            ? state
            : {
                messages: page.messages.map((message) => ({
                  id: nextId(),
                  role: message.role,
                  text: 'text' in message ? message.text : '',
                  thinking: '',
                  note: '',
                  name: 'name' in message ? message.name : undefined,
                  input: 'input' in message ? message.input : undefined,
                  output: 'output' in message ? message.output : undefined,
                })),
                hasMore: page.hasMore,
                historyLoading: false,
              }
        )
      })
      .catch((error: Error) => set({ error: error.message, historyLoading: false }))
    unsubscribe = subscribe(
      host,
      port,
      token,
      sessionId,
      (update) => {
        const info = update.update
        if (!info?.sessionUpdate) {
          return
        }
        const text = info.content?.type === 'text' ? (info.content.text ?? '') : ''
        set((state) => {
          const messages = [...state.messages]
          const last = messages.at(-1)
          const ensureAssistant = () => {
            if (last && last.role === 'assistant') {
              return { ...last }
            }
            const created: WorkMessage = {
              id: nextId(),
              role: 'assistant',
              text: '',
              thinking: '',
              note: '',
            }
            messages.push(created)
            return created
          }
          if (info.sessionUpdate === 'agent_message_chunk') {
            const target = ensureAssistant()
            target.text += text
            messages[messages.length - 1] = target
            return { messages, streaming: true }
          }
          if (info.sessionUpdate === 'agent_thought_chunk') {
            const target = ensureAssistant()
            target.thinking += text
            messages[messages.length - 1] = target
            return { messages, streaming: true }
          }
          if (info.sessionUpdate === 'tool_call' || info.sessionUpdate === 'tool_call_update') {
            const target = ensureAssistant()
            const label = typeof info.title === 'string' ? info.title : '工具调用'
            target.note = label
            messages[messages.length - 1] = target
            return { messages, streaming: true }
          }
          return {}
        })
      },
      (error) => set({ error: error.message })
    )
  },

  closeSession: () => {
    unsubscribe?.()
    unsubscribe = null
    set({ activeSessionId: null, messages: [], streaming: false })
  },

  loadOlder: async () => {
    const { host, port, token, activeSessionId, messages, hasMore, historyLoading } = get()
    if (!token || !activeSessionId || !hasMore || historyLoading) {
      return
    }
    set({ historyLoading: true })
    try {
      const page = await fetchHistory(host, port, token, activeSessionId, {
        limit: 20,
        before: messages.length,
      })
      if (get().activeSessionId !== activeSessionId) {
        return
      }
      const older = page.messages.map((message) => ({
        id: nextId(),
        role: message.role,
        text: 'text' in message ? message.text : '',
        thinking: '',
        note: '',
        name: 'name' in message ? message.name : undefined,
        input: 'input' in message ? message.input : undefined,
        output: 'output' in message ? message.output : undefined,
      }))
      set((state) => ({ messages: [...older, ...state.messages], hasMore: page.hasMore }))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ historyLoading: false })
    }
  },

  send: async (text) => {
    const { host, port, token, activeSessionId } = get()
    if (!token || !activeSessionId || !text.trim()) {
      return
    }
    set((state) => ({
      messages: [...state.messages, { id: nextId(), role: 'user', text, thinking: '', note: '' }],
      streaming: true,
    }))
    await sendMessage(host, port, token, activeSessionId, text)
  },

  cancel: async () => {
    const { host, port, token, activeSessionId } = get()
    if (!token || !activeSessionId) {
      return
    }
    await cancelSession(host, port, token, activeSessionId)
    set({ streaming: false })
  },
}))
