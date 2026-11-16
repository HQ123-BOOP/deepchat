import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 推理强度：映射为标准 Chat API 的 reasoning_effort，off 表示关闭思考 */
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max'

/** pi-ai 支持的协议；provider 由设置里另行选择 */
export const PI_APIS = [
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'mistral-conversations',
] as const

/**
 * 模型声明的输入模态。pi-ai 只区分 text / image；
 * audio / video 作为能力标注保留，发送侧只取前两种。
 */
export const INPUT_MODALITIES = ['text', 'image', 'audio', 'video'] as const
export type InputModality = (typeof INPUT_MODALITIES)[number]

/** 所有模型请求统一由 pi-ai 发出；DeepSeek 的 OCR、搜索等工具另用独立的 Key */
export type ProviderConfig = {
  /** 模型请求用的 Key */
  apiKey: string
  /** DeepSeek 工具服务（OCR、联网搜索、网页抓取）的 Key；换模型后仍可用 */
  serviceApiKey: string
  /** 该提供商使用的模型名 */
  model: string
  /** pi-ai：提供商标识，用于自动适配各家兼容差异 */
  piProvider: string
  /** pi-ai：协议标识，见 PI_APIS */
  piApi: string
  /** pi-ai：独立端点，留空按 provider / 协议用官方默认值 */
  piBaseUrl: string
  /** 上下文窗口；null 表示按内置模型目录自动匹配，匹配不到用 1M */
  contextWindow: number | null
  /** 最大输出；null 表示按内置模型目录自动匹配，匹配不到用 384k */
  maxTokens: number | null
  /** 输入模态；null 表示按内置模型目录自动匹配，文本始终可用 */
  inputModalities: InputModality[] | null
}

const DEFAULT_PROVIDER: ProviderConfig = {
  apiKey: '',
  serviceApiKey: '',
  model: 'deepseek-flash',
  piProvider: 'deepseek',
  piApi: 'openai-completions',
  piBaseUrl: '',
  contextWindow: null,
  maxTokens: null,
  inputModalities: null,
}

const positiveOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null

/** 读取模态数组：非法或空值视为自动，文本始终补齐 */
const readModalities = (value: unknown): InputModality[] | null => {
  if (!Array.isArray(value)) {
    return null
  }
  const picked = INPUT_MODALITIES.filter((modality) => value.includes(modality))
  if (picked.length === 0) {
    return null
  }
  return picked.includes('text') ? picked : ['text', ...picked]
}

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  provider: ProviderConfig
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  reasoningEffort: ReasoningEffort
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  provider: 'chat-demo:provider',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  reasoningEffort: 'chat-demo:reasoning-effort',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 读取提供商配置；损坏或字段缺失时回落到默认值 */
const readProvider = (): ProviderConfig => {
  const raw = read(KEYS.provider)
  if (!raw) {
    return DEFAULT_PROVIDER
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProviderConfig> & { kind?: string }
    // 旧版三分流配置里的模型名属于另一条路径，统一后直接回到默认的标准 Chat API 配置
    if (parsed.kind && parsed.kind !== 'pi') {
      return DEFAULT_PROVIDER
    }
    return {
      apiKey: parsed.apiKey ?? '',
      serviceApiKey: parsed.serviceApiKey ?? '',
      model: parsed.model?.trim() || DEFAULT_PROVIDER.model,
      piProvider: parsed.piProvider?.trim() || DEFAULT_PROVIDER.piProvider,
      piApi: parsed.piApi?.trim() || DEFAULT_PROVIDER.piApi,
      piBaseUrl: parsed.piBaseUrl ?? '',
      contextWindow: positiveOrNull(parsed.contextWindow),
      maxTokens: positiveOrNull(parsed.maxTokens),
      inputModalities: readModalities(parsed.inputModalities),
    }
  } catch {
    return DEFAULT_PROVIDER
  }
}

/** 旧版把 Key 单独存一份；升级后迁移到模型配置，避免用户再填一次 */
const initialProvider = (): ProviderConfig => {
  const provider = readProvider()
  const legacy = read(KEYS.apiKey)
  return legacy && !provider.apiKey ? { ...provider, apiKey: legacy } : provider
}

/** 旧版本只有 thinking 开关：true 视为 high，false 视为 off */
const initialReasoningEffort = (): ReasoningEffort => {
  const saved = read(KEYS.reasoningEffort)
  if (saved === 'off' || saved === 'low' || saved === 'high' || saved === 'max') {
    return saved
  }
  return read(KEYS.thinking) === 'true' ? 'high' : 'off'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  provider: initialProvider(),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  reasoningEffort: initialReasoningEffort(),
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setProviderConfig = (patch: Partial<ProviderConfig>) => {
  const provider = { ...useSettings.getState().provider, ...patch }
  write(KEYS.provider, JSON.stringify(provider))
  useSettings.setState({ provider })
}

/**
 * 是否直连 DeepSeek 官方端点。官方端点才有 prefix 续写能力，
 * 自建或第三方网关无法保证语义，界面上静默隐藏续写入口。
 */
export const isOfficialDeepSeekEndpoint = (provider: ProviderConfig): boolean => {
  const raw = provider.piBaseUrl.trim()
  if (raw) {
    try {
      return new URL(raw).hostname.toLowerCase() === 'api.deepseek.com'
    } catch {
      return false
    }
  }
  // 留空时按内置目录的默认端点判断，只有 deepseek 提供商落在官方域名
  return provider.piProvider === 'deepseek'
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setReasoningEffort = (reasoningEffort: ReasoningEffort) => {
  write(KEYS.reasoningEffort, reasoningEffort)
  useSettings.setState({ reasoningEffort })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
