/**
 * 版本检查：读 GitHub Releases 的最新 tag，与本机构建版本比较。
 * 请求间隔由「自动检查更新」设置决定（1 / 7 / 30 天或永不），
 * 未认证的 GitHub API 有速率限制，间隔内直接用缓存。
 */
import { useSettings } from './settings.js'

const REPO = 'HQ123-BOOP/deepchat'
const CACHE_KEY = 'chat-demo:update-check'
const DAY = 24 * 60 * 60 * 1000

export type UpdateResult =
  | { state: 'update'; version: string; url: string }
  | { state: 'latest' }
  | { state: 'error' }

type Cache = {
  checkedAt: number
  latest: string | null
  url: string | null
}

/** 构建时由 HtmlRspackPlugin 写入的版本号 */
export const appVersion = (): string =>
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? '0.0.0'

const readCache = (): Cache | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<Cache>
    return typeof parsed.checkedAt === 'number' && 'latest' in parsed
      ? {
          checkedAt: parsed.checkedAt,
          latest: parsed.latest ?? null,
          url: parsed.url ?? null,
        }
      : null
  } catch {
    return null
  }
}

const writeCache = (cache: Cache) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // 隐私模式或配额不足时忽略，下一次重新请求。
  }
}

const segments = (value: string): number[] =>
  value
    .replace(/^v/, '')
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10) || 0)

const isNewer = (latest: string, current: string): boolean => {
  const left = segments(latest)
  const right = segments(current)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) {
      return a > b
    }
  }
  return false
}

const releaseUrl = (version: string) => `https://github.com/${REPO}/releases/tag/v${version}`

const resolve = (latest: string | null, url: string | null): UpdateResult => {
  if (!latest) {
    return { state: 'error' }
  }
  return isNewer(latest, appVersion())
    ? { state: 'update', version: latest, url: url || releaseUrl(latest) }
    : { state: 'latest' }
}

/** 设置的检查间隔换算成缓存有效期；永不自动检查时缓存一直有效 */
const cacheTtl = (): number => {
  const { updateInterval } = useSettings.getState()
  return updateInterval === 'never' ? Number.POSITIVE_INFINITY : updateInterval * DAY
}

/** force 跳过缓存；失败不写缓存，保留上一次成功的结果 */
export const checkForUpdate = async (force = false): Promise<UpdateResult> => {
  const cache = readCache()
  if (!force && cache && Date.now() - cache.checkedAt < cacheTtl()) {
    return resolve(cache.latest, cache.url)
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!response.ok) {
      return { state: 'error' }
    }
    const data = (await response.json()) as { tag_name?: string; html_url?: string }
    const latest = data.tag_name?.replace(/^v/, '') ?? null
    const url = data.html_url ?? null
    if (latest) {
      writeCache({ checkedAt: Date.now(), latest, url })
    }
    return resolve(latest, url)
  } catch {
    return { state: 'error' }
  }
}

/**
 * 启动时调用：间隔内直接用缓存，不请求也不重复提示；
 * 只有真正发起检查的那次才返回更新信息。返回 null 表示无需提示。
 */
export const checkOnLaunch = async (): Promise<{ version: string; url: string } | null> => {
  const { updateInterval } = useSettings.getState()
  if (updateInterval === 'never') {
    return null
  }
  const cache = readCache()
  if (cache && Date.now() - cache.checkedAt < updateInterval * DAY) {
    return null
  }
  const result = await checkForUpdate(true)
  return result.state === 'update' ? { version: result.version, url: result.url } : null
}
