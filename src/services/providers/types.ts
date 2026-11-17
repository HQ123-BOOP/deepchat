/**
 * 提供商无关的对话接口。
 *
 * DeepSeek 的原生路径（Antrhopic 兼容端点 + 服务端联网工具）继续走
 * `services/api/client.ts`，不经过这里；这里只服务"其他提供商"，它们大多是
 * OpenAI 兼容形态：`messages` + `tools`（function calling）+ SSE 增量。
 */

/** 工具的参数 schema：JSON Schema 的子集，够描述搜索/抓取/OCR 即可 */
export type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export type ToolSchema = {
  name: string
  description: string
  parameters: JsonSchema
}

/** 内联图片：base64 数据（不含 data: 前缀）与 MIME 类型 */
export type ProviderImage = { data: string; mimeType: string }

/** 模型请求发起的一次工具调用；arguments 是原始 JSON 字符串（可能被流式分片） */
export type ToolCall = {
  id: string
  name: string
  arguments: string
}

export type ProviderMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: ProviderImage[] }
  | {
      role: 'assistant'
      content: string
      toolCalls?: ToolCall[]
      /** 该轮的思考内容；随消息回传，不能丢弃 */
      reasoning?: string
      /** 思考签名，pi-ai 用它决定写回哪个 reasoning 字段（如 reasoning_content） */
      reasoningSignature?: string
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

/** 推理档位：off 关闭思考，其余对应各家的 reasoning_effort */
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max'

export type ProviderRequest = {
  model: string
  messages: ProviderMessage[]
  tools?: ToolSchema[]
  /** 0 表示不限制 */
  maxTokens?: number
  temperature?: number
  reasoningEffort?: ReasoningEffort
}

export type StopReason = 'stop' | 'tool_calls' | 'length' | 'error'

/** 统一的流式事件；上层据此更新 UI、驱动 ReAct 循环 */
export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** 思考块结束时到达的签名；缺失时该段思考无法在下一轮原样回传 */
  | { type: 'reasoning_signature'; signature: string }
  /** 工具调用参数开始生成；index 用来关联同一调用的后续增量 */
  | { type: 'tool_prepare'; index: number; name: string }
  /** 工具调用参数的 JSON 增量；用于在执行前显示文件名与正文大小 */
  | { type: 'tool_prepare_delta'; index: number; delta: string; name?: string }
  | { type: 'tool_call'; call: ToolCall; index?: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; stopReason: StopReason; error?: string }

export interface ChatProvider {
  /** 用于日志与调试 */
  readonly id: string
  stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent>
}

export class ProviderError extends Error {
  readonly status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
  }
}

/** 流式片段拼装：tool_calls 按 index 累积 id / name / arguments */
export type ToolCallDraft = { index: number; id: string; name: string; arguments: string }

export const toToolCall = (draft: ToolCallDraft): ToolCall => ({
  id: draft.id,
  name: draft.name,
  arguments: draft.arguments,
})
