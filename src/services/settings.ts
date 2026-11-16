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

/** 所有模型请求统一由 pi-ai 发出；联网工具另用 settings.apiKey 调用工具 API */
export type ProviderConfig = {
  /** 模型提供商的 Key；留空时复用 settings.apiKey */
  apiKey: string
  /** 该提供商使用的模型名 */
  model: string
  /** pi-ai：提供商标识，用于自动适配各家兼容差异 */
  piProvider: string
  /** pi-ai：协议标识，见 PI_APIS */
  piApi: string
  /** pi-ai：独立端点，留空按 provider / 协议用官方默认值 */
  piBaseUrl: string
}

const DEFAULT_PROVIDER: ProviderConfig = {
  apiKey: '',
  model: 'deepseek-flash',
  piProvider: 'deepseek',
  piApi: 'openai-completions',
  piBaseUrl: '',
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
      model: parsed.model?.trim() || DEFAULT_PROVIDER.model,
      piProvider: parsed.piProvider?.trim() || DEFAULT_PROVIDER.piProvider,
      piApi: parsed.piApi?.trim() || DEFAULT_PROVIDER.piApi,
      piBaseUrl: parsed.piBaseUrl ?? '',
    }
  } catch {
    return DEFAULT_PROVIDER
  }
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
  provider: readProvider(),
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
