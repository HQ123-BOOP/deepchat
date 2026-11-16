/**
 * 系统提示：模型身份、当前时间、位置、平台与语言。
 *
 * 时间取浏览器本地时区（避免 UTC 跨日）；位置取设置里用户选择的地区，
 * 未设置时省略该项，不猜测 IP 归属。
 */
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider,
} from '@earendil-works/pi-ai/providers/all'
import { isTauriShell } from '../desktop.js'
import { getRegionName, provinces, type UserLocation } from '../location.js'
import type { Locale } from '../settings.js'

export type SystemPromptOptions = {
  /** pi-ai 提供商标识，用于查目录里的模型展示名 */
  provider: string
  model: string
  locale: Locale
  location: UserLocation | null
  /** 便于测试注入；默认当前时刻 */
  now?: Date
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 2026-11-16 Mon UTC+8 */
const formatNow = (now: Date): string => {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(now)
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hours = Math.floor(Math.abs(offset) / 60)
  const minutes = Math.abs(offset) % 60
  return `${date} ${weekday} UTC${sign}${hours}${minutes ? `:${pad(minutes)}` : ''}`
}

/** 目录里的展示名；自定义模型回落到 id */
const displayModelName = (provider: string, model: string): string => {
  try {
    if (!(getBuiltinProviders() as readonly string[]).includes(provider)) {
      return model
    }
    const match = getBuiltinModels(provider as BuiltinProvider).find((item) => item.id === model)
    return match?.name || model
  } catch {
    return model
  }
}

/** 地区名：港澳台用固定写法，中国用行政区原名，其他国家用英文国名 */
const displayLocation = (location: UserLocation): string => {
  if (location.region === 'HK') {
    return '香港特别行政区'
  }
  if (location.region === 'MO') {
    return '澳门特别行政区'
  }
  if (location.region === 'TW') {
    return 'Taiwan'
  }
  if (location.region === 'CN') {
    const province = location.province
      ? provinces.find((item) => item.code === location.province)
      : undefined
    const city = province?.cities.find((item) => item.code === location.city)
    return city?.name ?? province?.name ?? '中国'
  }
  return getRegionName(location.region, 'en-US') || location.region
}

/** 生成一行式系统提示；工具说明由 providerContext 追加在后面 */
export const createSystemPrompt = ({
  provider,
  model,
  locale,
  location,
  now = new Date(),
}: SystemPromptOptions): string =>
  [
    `You are ${displayModelName(provider, model)}.`,
    `Now is ${formatNow(now)}.`,
    ...(location ? [`IP location ${displayLocation(location)}.`] : []),
    `Platform: ${isTauriShell() ? 'APP' : 'Web'}.`,
    `Language ${locale}.`,
  ].join(' ')
