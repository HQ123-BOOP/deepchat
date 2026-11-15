/**
 * 客户端 ReAct 循环：模型发起工具调用 → 本地执行 → 结果回填 → 继续请求。
 *
 * DeepSeek 原生路径不需要它（联网由服务端在一个响应内完成）；这里只给
 * "其他提供商 + 标准 function tools" 使用。
 */
import { runTool, TOOL_SCHEMAS, type ToolSource } from '../tools/registry.js'
import type { ChatProvider, ProviderMessage, ToolCall } from '../providers/types.js'

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_result'; call: ToolCall; sources: ToolSource[]; ok: boolean; error?: string }
  | { type: 'done'; stopReason: 'stop' | 'length' | 'tool_limit' | 'error'; error?: string }

export type AgentOptions = {
  provider: ChatProvider
  model: string
  /** 会话历史（已按上下文策略组装） */
  messages: ProviderMessage[]
  /** 是否声明联网工具；关闭时不发 tools */
  tools: boolean
  /** DeepSeek Key，用于执行 search/fetch；缺失时工具调用会失败 */
  toolApiKey: string
  signal?: AbortSignal
  /** 最多几轮工具调用，防止死循环 */
  maxSteps?: number
  temperature?: number
}

const DEFAULT_MAX_STEPS = 4

/**
 * 驱动一轮对话。事件按产生顺序产出，调用方据此更新 UI；函数结束时消息历史
 * 已被内部推进到最终回答，但不修改调用方传入的数组。
 */
export async function* runAgent(
  options: AgentOptions
): AsyncGenerator<AgentEvent> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const messages: ProviderMessage[] = [...options.messages]
  const tools = options.tools ? TOOL_SCHEMAS : undefined

  for (let step = 0; step < maxSteps; step++) {
    const pending: ToolCall[] = []
    let finish: 'stop' | 'length' | 'tool_calls' | 'error' = 'stop'
    let text = ''

    try {
      for await (const event of options.provider.stream(
        { model: options.model, messages, tools, temperature: options.temperature },
        options.signal
      )) {
        if (event.type === 'text') {
          text += event.text
          yield { type: 'text', text: event.text }
        } else if (event.type === 'reasoning') {
          yield { type: 'reasoning', text: event.text }
        } else if (event.type === 'tool_call') {
          pending.push(event.call)
        } else if (event.type === 'done') {
          finish = event.stopReason === 'error' ? 'error' : event.stopReason
          if (event.error) {
            yield { type: 'done', stopReason: 'error', error: event.error }
            return
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield { type: 'done', stopReason: 'error', error: error instanceof Error ? error.message : String(error) }
      return
    }

    if (pending.length === 0) {
      yield { type: 'done', stopReason: finish === 'length' ? 'length' : 'stop' }
      return
    }

    // 把这一轮的助手消息（可能含正文 + 工具调用）写入历史，再逐个执行工具
    messages.push({ role: 'assistant', content: text, toolCalls: pending })
    for (const call of pending) {
      yield { type: 'tool_start', call }
      let content: string
      let sources: ToolSource[] = []
      let ok = true
      try {
        const parsed = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {}
        const result = await runTool(call.name, parsed, {
          apiKey: options.toolApiKey,
          signal: options.signal,
        })
        content = result.content
        sources = result.sources
      } catch (error) {
        ok = false
        const message = error instanceof Error ? error.message : String(error)
        content = `工具 ${call.name} 执行失败：${message}`
        yield { type: 'tool_result', call, sources, ok, error: message }
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content })
        continue
      }
      yield { type: 'tool_result', call, sources, ok }
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content })
    }

    if (step === maxSteps - 1) {
      yield { type: 'done', stopReason: 'tool_limit' }
      return
    }
  }
}
