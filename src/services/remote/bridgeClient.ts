/**
 * 局域网桥接（dsh-lan-bridge）的客户端。
 *
 * 传输是普通 HTTP + SSE：桥接端已经在局域网内开放了 CORS，App 直接 fetch 即可，
 * 不需要经过 Tauri 的 Rust 层。令牌通过 secureStore 持久化（系统凭据库）。
 */
import { readServerSentEvents } from '../api/sse.js'

export type BridgeSession = {
  sessionId: string
  cwd: string
  /** 会话标题：DSH 的命名或第一条用户消息；可能为空 */
  title?: string
}

export class BridgeError extends Error {
  readonly status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'BridgeError'
    this.status = status
  }
}

const base = (host: string, port: number) => `http://${host}:${port}`

const request = async <T>(
  url: string,
  token: string | null,
  init: RequestInit = {}
): Promise<T> => {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    })
  } catch (error) {
    throw new BridgeError(
      error instanceof Error ? `无法连接：${error.message}` : '无法连接桥接服务'
    )
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      message = body?.error?.message ?? message
    } catch {
      // 非 JSON 错误体忽略
    }
    throw new BridgeError(message, response.status)
  }
  return (await response.json()) as T
}

/** 用配对码换设备令牌 */
export const pair = async (host: string, port: number, code: string, deviceName: string) => {
  const result = await request<{ token: string; device: { id: string; name: string } }>(
    `${base(host, port)}/v1/pair`,
    null,
    { method: 'POST', body: JSON.stringify({ code, deviceName }) }
  )
  return result
}

export const listSessions = async (host: string, port: number, token: string) => {
  const result = await request<{ sessions: BridgeSession[] }>(
    `${base(host, port)}/v1/sessions`,
    token
  )
  return result.sessions ?? []
}

export const createSession = async (host: string, port: number, token: string, cwd: string) => {
  return request<{ sessionId: string }>(`${base(host, port)}/v1/sessions`, token, {
    method: 'POST',
    body: JSON.stringify({ cwd }),
  })
}

export type HistoryMessage =
  | { role: 'user' | 'assistant'; text: string; time: number }
  | { role: 'tool'; id: string; name: string; input: string; output: string; time: number }

export type HistoryPage = {
  messages: HistoryMessage[]
  hasMore: boolean
  total: number
}

export type ConfigValue = { value: string; name: string; description?: string }
export type ConfigGroup = { group: string; name: string; options: ConfigValue[] }
export type ConfigOption = {
  id: string
  name: string
  category?: string
  type: 'select'
  currentValue: string
  options: (ConfigValue | ConfigGroup)[]
}

/** 会话配置项：模型、推理强度等 */
export const fetchConfig = async (
  host: string,
  port: number,
  token: string,
  sessionId: string
): Promise<ConfigOption[]> => {
  const result = await request<{ configOptions: ConfigOption[] }>(
    `${base(host, port)}/v1/sessions/${encodeURIComponent(sessionId)}/config`,
    token
  )
  return result.configOptions ?? []
}

export const setConfigOption = async (
  host: string,
  port: number,
  token: string,
  sessionId: string,
  configId: string,
  value: string
): Promise<ConfigOption[]> => {
  const result = await request<{ configOptions?: ConfigOption[] }>(
    `${base(host, port)}/v1/sessions/${encodeURIComponent(sessionId)}/config`,
    token,
    { method: 'POST', body: JSON.stringify({ configId, value }) }
  )
  return result.configOptions ?? []
}

/** 会话历史：桥接端从 DSH 的会话日志还原出来的消息，支持从最新往前分页 */
export const fetchHistory = async (
  host: string,
  port: number,
  token: string,
  sessionId: string,
  { limit = 20, before = 0 }: { limit?: number; before?: number } = {}
): Promise<HistoryPage> => {
  const query = new URLSearchParams({ limit: String(limit), before: String(before) })
  const result = await request<HistoryPage>(
    `${base(host, port)}/v1/sessions/${encodeURIComponent(sessionId)}/history?${query}`,
    token
  )
  return {
    messages: result.messages ?? [],
    hasMore: Boolean(result.hasMore),
    total: result.total ?? 0,
  }
}

export const sendMessage = async (
  host: string,
  port: number,
  token: string,
  sessionId: string,
  text: string
) => {
  await request<{ accepted: boolean }>(
    `${base(host, port)}/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
    token,
    { method: 'POST', body: JSON.stringify({ text }) }
  )
}

export const cancelSession = async (
  host: string,
  port: number,
  token: string,
  sessionId: string
) => {
  await request<{ cancelled: boolean }>(
    `${base(host, port)}/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,
    token,
    { method: 'POST' }
  )
}

/** ACP session/update 的宽松形状：只取我们渲染需要的那几个字段 */
export type AcpUpdate = {
  sessionId: string
  update?: {
    sessionUpdate?: string
    content?: { type?: string; text?: string }
    title?: string
    [key: string]: unknown
  }
}

/** 订阅某个会话的 SSE 更新；返回取消函数 */
export const subscribe = (
  host: string,
  port: number,
  token: string,
  sessionId: string,
  onUpdate: (update: AcpUpdate) => void,
  onError: (error: Error) => void
) => {
  const controller = new AbortController()
  const run = async () => {
    try {
      const response = await fetch(
        `${base(host, port)}/v1/sessions/${encodeURIComponent(sessionId)}/events`,
        { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }
      )
      if (!response.ok || !response.body) {
        throw new BridgeError(`订阅失败：HTTP ${response.status}`, response.status)
      }
      for await (const event of readServerSentEvents(response.body, controller.signal)) {
        if (event.event !== 'update') {
          continue
        }
        try {
          onUpdate(JSON.parse(event.data) as AcpUpdate)
        } catch {
          // 忽略无法解析的帧
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
  void run()
  return () => controller.abort()
}

/** 解析二维码内容：dshbridge://pair?host=..&port=..&code=.. */
export const parsePairingUri = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('dshbridge://')) {
    return null
  }
  try {
    const url = new URL(trimmed)
    const host = url.searchParams.get('host')
    const port = Number(url.searchParams.get('port'))
    const code = url.searchParams.get('code')
    if (!host || !code || !Number.isFinite(port)) {
      return null
    }
    return { host, port, code }
  } catch {
    return null
  }
}
