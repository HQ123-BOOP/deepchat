/**
 * pi-ai 适配器：所有模型请求的唯一出口。
 *
 * 协议由配置里的 api 决定（openai-completions / openai-responses /
 * anthropic-messages / google-generative-ai / mistral-conversations ...），
 * provider 决定各家兼容参数。模型不查内置目录，而是按配置构造自定义
 * Model：任意模型名、自建端点（Ollama / vLLM / LiteLLM）都能用。
 *
 * DeepSeek 标准 Chat API 的 thinking / reasoning_effort 由 pi-ai 的
 * deepseek 兼容分支生成；safety_check 这类扩展字段通过 onPayload 注入。
 */
import { normalizeContext } from '@earendil-works/pi-ai'
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider,
} from '@earendil-works/pi-ai/providers/all'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  JsonObject,
  Message,
  Model,
  TextContent,
  Tool,
} from '@earendil-works/pi-ai'
import {
  ProviderError,
  type ChatProvider,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderRequest,
} from './types.js'
import { useSettings } from '../settings.js'

export type PiAiConfig = {
  /** pi-ai 的 provider 标识，用于自动适配各家兼容差异 */
  provider: string
  /** 协议标识，见 PI_APIS */
  api: string
  /** 留空时按 provider / 协议使用官方默认地址 */
  baseUrl: string
  apiKey: string
  /** 手动覆盖的上下文窗口；缺省时按内置模型目录匹配 */
  contextWindow?: number | null
  /** 手动覆盖的最大输出；缺省时按内置模型目录匹配 */
  maxTokens?: number | null
  /** 手动声明的输入模态；缺省时按内置模型目录匹配 */
  inputModalities?: string[] | null
}

/** 目录匹配不到时的兜底值 */
const DEFAULT_CONTEXT_WINDOW = 1_048_576
const DEFAULT_MAX_TOKENS = 393_216
/** 目录匹配不到时按文本模型处理，避免把图片发给不支持视觉的端点 */
const DEFAULT_INPUT: Model<Api>['input'] = ['text']

/** 各协议的官方默认端点；自建服务可在设置里覆盖 */
const DEFAULT_BASE_URLS: Record<string, string> = {
  'openai-completions': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'azure-openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com/v1',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
  'mistral-conversations': 'https://api.mistral.ai/v1',
}

const FALLBACK_BASE_URL = 'https://api.openai.com/v1'
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/** 查 pi-ai 内置目录（数据来自 models.dev）；provider 不在目录里时返回 undefined */
const lookupBuiltin = (config: PiAiConfig, modelId?: string) => {
  try {
    if (!(getBuiltinProviders() as readonly string[]).includes(config.provider)) {
      return undefined
    }
    const models = getBuiltinModels(config.provider as BuiltinProvider)
    return modelId ? models.find((model) => model.id === modelId) : models[0]
  } catch {
    return undefined
  }
}

/** 当前模型是否直接支持图片输入：显式声明优先，其次内置目录 */
export const modelAcceptsImages = (
  provider: string,
  model: string,
  inputModalities?: string[] | null
): boolean => {
  if (inputModalities?.length) {
    return inputModalities.includes('image')
  }
  try {
    if (!(getBuiltinProviders() as readonly string[]).includes(provider)) {
      return false
    }
    const match = getBuiltinModels(provider as BuiltinProvider).find((item) => item.id === model)
    return match?.input.includes('image') ?? false
  } catch {
    return false
  }
}

/** DeepSeek 的 OpenAI 兼容端点不带 /v1；其余按内置目录、协议默认值依次回退 */
export const resolvePiBaseUrl = (config: PiAiConfig): string => {
  const explicit = config.baseUrl.trim()
  if (explicit) {
    return explicit.replace(/\/+$/, '')
  }
  const builtin = lookupBuiltin(config)
  if (builtin?.baseUrl) {
    return builtin.baseUrl.replace(/\/+$/, '')
  }
  if (config.provider === 'deepseek') {
    return DEEPSEEK_BASE_URL
  }
  return (DEFAULT_BASE_URLS[config.api] ?? FALLBACK_BASE_URL).replace(/\/+$/, '')
}

const emptyUsage = (): AssistantMessage['usage'] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

const isDeepSeekConfig = (config: PiAiConfig): boolean =>
  config.provider === 'deepseek' || resolvePiBaseUrl(config).includes('deepseek.com')

/**
 * 请求侧只认文本与图像：pi-ai 不支持音频/视频输入，
 * 这两项在设置里仅作为能力标注保留。
 */
const resolveInput = (config: PiAiConfig, builtin?: Model<Api>): Model<Api>['input'] => {
  const declared = config.inputModalities?.length
    ? config.inputModalities
    : builtin?.input ?? DEFAULT_INPUT
  const supported = declared.includes('image') ? ['text', 'image'] : ['text']
  return supported as Model<Api>['input']
}

const buildModel = (config: PiAiConfig, modelId: string): Model<Api> => {
  const builtin = lookupBuiltin(config, modelId)
  const model = {
    id: modelId,
    name: builtin?.name ?? modelId,
    api: config.api as Api,
    provider: config.provider,
    baseUrl: resolvePiBaseUrl(config),
    // 档位关闭时仍保持 reasoning=true，交给 reasoningEffort 缺省表达「关闭思考」
    reasoning: builtin?.reasoning ?? true,
    input: resolveInput(config, builtin),
    cost: builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // 目录里没有该模型时按 1M / 384k 兜底，用户可在设置里覆盖
    contextWindow: config.contextWindow ?? builtin?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: config.maxTokens ?? builtin?.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(builtin?.thinkingLevelMap ? { thinkingLevelMap: builtin.thinkingLevelMap } : {}),
    ...(builtin?.compat
      ? { compat: builtin.compat }
      : isDeepSeekConfig(config) && config.api === 'openai-completions'
        ? {
            compat: {
              thinkingFormat: 'deepseek',
              maxTokensField: 'max_tokens',
              supportsReasoningEffort: true,
              requiresReasoningContentOnAssistantMessages: true,
            },
          }
        : {}),
  }
  return model as unknown as Model<Api>
}

/** ProviderMessage[] → pi-ai Context；system 独立成 systemPrompt，工具参数直接是 JSON Schema */
const toContext = (request: ProviderRequest, config: PiAiConfig): Context => {
  const api = config.api as Api
  const system = request.messages
    .filter((message): message is Extract<ProviderMessage, { role: 'system' }> => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const now = Date.now()
  const messages: Message[] = []

  for (const message of request.messages) {
    switch (message.role) {
      case 'system':
        break
      case 'user': {
        const content: string | (TextContent | ImageContent)[] = message.images?.length
          ? [
              { type: 'text', text: message.content },
              ...message.images.map((image) => ({
                type: 'image' as const,
                data: image.data,
                mimeType: image.mimeType,
              })),
            ]
          : message.content
        messages.push({ role: 'user', content, timestamp: now })
        break
      }
      case 'assistant': {
        const content: AssistantMessage['content'] = []
        if (message.reasoning) {
          content.push({
            type: 'thinking',
            thinking: message.reasoning,
            // 签名决定 pi-ai 是否把这段思考写回 reasoning_content 等字段；
            // 没有签名时部分协议会降级成普通文本或直接丢弃
            ...(message.reasoningSignature
              ? { thinkingSignature: message.reasoningSignature }
              : {}),
          })
        }
        if (message.content) {
          content.push({ type: 'text', text: message.content })
        }
        for (const call of message.toolCalls ?? []) {
          let args: JsonObject = {}
          try {
            args = JSON.parse(call.arguments || '{}') as JsonObject
          } catch {
            // 参数残缺时保持空对象，交由模型重试
          }
          content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: args })
        }
        messages.push({
          role: 'assistant',
          content,
          api,
          provider: config.provider,
          model: request.model,
          usage: emptyUsage(),
          stopReason: 'stop',
          timestamp: now,
        })
        break
      }
      case 'tool':
        messages.push({
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.name,
          content: [{ type: 'text', text: message.content }],
          isError: false,
          timestamp: now,
        })
        break
    }
  }

  const tools: Tool[] | undefined = request.tools?.length
    ? request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as object,
      }))
    : undefined

  return {
    ...(system ? { systemPrompt: system } : {}),
    messages,
    ...(tools ? { tools } : {}),
  }
}

type StreamFn = (
  model: Model<Api>,
  context: ReturnType<typeof normalizeContext>,
  options?: Record<string, unknown>
) => AsyncIterable<AssistantMessageEvent>

/** 按协议懒加载实现，避免把各家 SDK 全打进首屏 */
const API_LOADERS: Record<string, () => Promise<unknown>> = {
  'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions'),
  'openai-responses': () => import('@earendil-works/pi-ai/api/openai-responses'),
  'azure-openai-responses': () => import('@earendil-works/pi-ai/api/azure-openai-responses'),
  'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages'),
  'google-generative-ai': () => import('@earendil-works/pi-ai/api/google-generative-ai'),
  'mistral-conversations': () => import('@earendil-works/pi-ai/api/mistral-conversations'),
}

const loadApi = async (api: string): Promise<{ stream: StreamFn }> => {
  const loader = API_LOADERS[api]
  if (!loader) {
    throw new ProviderError(`不支持的协议：${api}`)
  }
  const module = (await loader()) as unknown as { stream: StreamFn }
  if (typeof module.stream !== 'function') {
    throw new ProviderError(`协议 ${api} 没有可用的流式实现`)
  }
  return module
}

/**
 * 按当前设置构造唯一的模型请求出口。
 * 模型与工具 API 共用同一个 Key；旧版单独保存的 settings.apiKey 仅作回退。
 */
export const createConfiguredPiProvider = (): ChatProvider => {
  const { provider, apiKey } = useSettings.getState()
  return createPiAiProvider({
    provider: provider.piProvider,
    api: provider.piApi,
    baseUrl: provider.piBaseUrl,
    apiKey: provider.apiKey.trim() || apiKey?.trim() || '',
    contextWindow: provider.contextWindow,
    maxTokens: provider.maxTokens,
    inputModalities: provider.inputModalities,
  })
}

export const createPiAiProvider = (config: PiAiConfig): ChatProvider => ({
  id: 'pi-ai',
  async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    // pi-ai 在 apiKey 为空时会回退读 process.env，而 WebView 里没有 process，会直接抛错
    if (!config.apiKey.trim()) {
      throw new ProviderError('请先在设置里填写模型提供商的 API Key')
    }
    const effort = request.reasoningEffort ?? 'off'
    const enabled = effort !== 'off'
    const isDeepSeek = isDeepSeekConfig(config)

    let events: AsyncIterable<AssistantMessageEvent>
    try {
      const api = await loadApi(config.api)
      events = api.stream(
        buildModel(config, request.model),
        normalizeContext(toContext(request, config)),
        {
          apiKey: config.apiKey,
          signal,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
          ...(enabled ? { reasoningEffort: effort } : {}),
          // Anthropic SDK 在浏览器里需要这个头才允许直连
          ...(config.api === 'anthropic-messages'
            ? { headers: { 'anthropic-dangerous-direct-browser-access': 'true' } }
            : {}),
          // DeepSeek 扩展字段：内容安全等级（推理档位由 pi-ai 的 compat 分支处理）
          ...(isDeepSeek && config.api === 'openai-completions'
            ? {
                onPayload: (payload: unknown) => {
                  if (!payload || typeof payload !== 'object') {
                    return undefined
                  }
                  return {
                    ...(payload as Record<string, unknown>),
                    safety_check: { level: 'high' },
                  }
                },
              }
            : {}),
        }
      )
    } catch (error) {
      throw new ProviderError(error instanceof Error ? error.message : String(error))
    }

    for await (const event of events) {
      switch (event.type) {
        case 'text_delta':
          yield { type: 'text', text: event.delta }
          break
        case 'thinking_delta':
          yield { type: 'reasoning', text: event.delta }
          break
        case 'thinking_end': {
          // 签名在思考块结束时才完整（Anthropic 走 signature_delta 累积）
          const block = event.partial.content[event.contentIndex]
          if (block?.type === 'thinking' && block.thinkingSignature) {
            yield { type: 'reasoning_signature', signature: block.thinkingSignature }
          }
          break
        }
        case 'toolcall_start': {
          const block = event.partial.content[event.contentIndex]
          if (block?.type === 'toolCall') {
            yield { type: 'tool_prepare', index: event.contentIndex, name: block.name }
          }
          break
        }
        case 'toolcall_delta':
          yield { type: 'tool_prepare_delta', index: event.contentIndex, delta: event.delta }
          break
        case 'toolcall_end':
          yield {
            type: 'tool_call',
            index: event.contentIndex,
            call: {
              id: event.toolCall.id,
              name: event.toolCall.name,
              arguments: JSON.stringify(event.toolCall.arguments),
            },
          }
          break
        case 'done':
          yield {
            type: 'usage',
            inputTokens: event.message.usage.input,
            outputTokens: event.message.usage.output,
          }
          yield {
            type: 'done',
            stopReason:
              event.reason === 'toolUse'
                ? 'tool_calls'
                : event.reason === 'length'
                  ? 'length'
                  : 'stop',
          }
          break
        case 'error':
          yield {
            type: 'done',
            stopReason: 'error',
            error: event.error.errorMessage ?? 'pi-ai 请求失败',
          }
          break
      }
    }
  },
})
