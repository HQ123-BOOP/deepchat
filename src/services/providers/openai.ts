/**
 * OpenAI 兼容提供商的流式适配器。
 *
 * 覆盖 OpenAI、硅基流动、Moonshot、通义、Together、Ollama、vLLM 等所有暴露
 * `POST {baseUrl}/chat/completions` + SSE 的服务。差异点用配置吸收：baseUrl、
 * 是否发送 `reasoning_content`（部分服务用它回传思考）、是否支持 `parallel_tool_calls`。
 */
import { readServerSentEvents } from '../api/sse.js'
import {
  ProviderError,
  toToolCall,
  type ChatProvider,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderRequest,
  type ToolCallDraft,
} from './types.js'

export type OpenAiCompatibleConfig = {
  /** 例如 https://api.openai.com/v1；末尾斜杠会被去掉 */
  baseUrl: string
  apiKey: string
  /** 部分服务要求额外的请求头 */
  headers?: Record<string, string>
}

type OpenAiDelta = {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: {
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }[]
}

type OpenAiChunk = {
  choices?: { delta?: OpenAiDelta; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

const toOpenAiMessages = (messages: ProviderMessage[]) =>
  messages.map((message) => {
    switch (message.role) {
      case 'system':
      case 'user':
        return { role: message.role, content: message.content }
      case 'assistant':
        return {
          role: 'assistant' as const,
          content: message.content,
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        }
      case 'tool':
        return {
          role: 'tool' as const,
          tool_call_id: message.toolCallId,
          content: message.content,
        }
    }
  })

const stopReasonOf = (finish: string | null | undefined, hasToolCalls: boolean) => {
  if (hasToolCalls || finish === 'tool_calls' || finish === 'function_call') {
    return 'tool_calls' as const
  }
  if (finish === 'length') {
    return 'length' as const
  }
  return 'stop' as const
}

export const createOpenAiCompatibleProvider = (
  config: OpenAiCompatibleConfig
): ChatProvider => {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  return {
    id: 'openai-compatible',
    async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
      let response: Response
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            ...config.headers,
          },
          body: JSON.stringify({
            model: request.model,
            messages: toOpenAiMessages(request.messages),
            stream: true,
            stream_options: { include_usage: true },
            ...(request.tools?.length
              ? {
                  tools: request.tools.map((tool) => ({
                    type: 'function' as const,
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.parameters,
                    },
                  })),
                }
              : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          }),
          signal,
        })
      } catch (error) {
        if (signal?.aborted) {
          throw error
        }
        throw new ProviderError(error instanceof Error ? error.message : String(error))
      }

      if (!response.ok) {
        let message = `HTTP ${response.status}`
        try {
          const body = (await response.json()) as { error?: { message?: string } }
          if (body?.error?.message) {
            message = body.error.message
          }
        } catch {
          // 非 JSON 错误体直接忽略
        }
        throw new ProviderError(message, response.status)
      }
      if (!response.body) {
        throw new ProviderError('响应没有可读的流', response.status)
      }

      const drafts = new Map<number, ToolCallDraft>()
      let finish: string | null | undefined
      let usage: { inputTokens: number; outputTokens: number } | null = null

      for await (const event of readServerSentEvents(response.body, signal)) {
        if (event.data === '[DONE]') {
          break
        }
        let chunk: OpenAiChunk
        try {
          chunk = JSON.parse(event.data) as OpenAiChunk
        } catch {
          continue
        }
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          }
        }
        const choice = chunk.choices?.[0]
        if (!choice) {
          continue
        }
        if (choice.finish_reason) {
          finish = choice.finish_reason
        }
        const delta = choice.delta
        if (!delta) {
          continue
        }
        if (delta.reasoning_content) {
          yield { type: 'reasoning', text: delta.reasoning_content }
        }
        if (delta.content) {
          yield { type: 'text', text: delta.content }
        }
        for (const piece of delta.tool_calls ?? []) {
          const draft = drafts.get(piece.index) ?? {
            index: piece.index,
            id: '',
            name: '',
            arguments: '',
          }
          if (piece.id) {
            draft.id += piece.id
          }
          if (piece.function?.name) {
            draft.name += piece.function.name
          }
          if (piece.function?.arguments) {
            draft.arguments += piece.function.arguments
          }
          drafts.set(piece.index, draft)
        }
      }

      if (usage) {
        yield { type: 'usage', ...usage }
      }
      for (const draft of drafts.values()) {
        yield { type: 'tool_call', call: toToolCall(draft) }
      }
      yield { type: 'done', stopReason: stopReasonOf(finish, drafts.size > 0) }
    },
  }
}
