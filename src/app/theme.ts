import { useSyncExternalStore } from 'react'
import { setWindowTheme } from '../services/desktop.js'
import { useSettings, type ThemePreference } from '../services/settings.js'

export type Theme = 'light' | 'dark'

const query = window.matchMedia('(prefers-color-scheme: dark)')

const subscribeOsTheme = (listener: () => void) => {
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

const getOsTheme = (): Theme => (query.matches ? 'dark' : 'light')

const resolveTheme = (preference: ThemePreference, osTheme: Theme): Theme =>
  preference === 'system' ? osTheme : preference

/** 当前实际生效的深浅色：手动选择优先，「跟随系统」时取系统设置 */
export const useTheme = (): Theme => {
  const preference = useSettings((state) => state.themePreference)
  const osTheme = useSyncExternalStore(subscribeOsTheme, getOsTheme)
  return resolveTheme(preference, osTheme)
}

type AndroidThemeBridge = {
  setTheme: (dark: boolean, color: string) => void
}

/** 把 rgb()/rgba() 转成 Android 能解析的 #rrggbb */
const toHexColor = (value: string): string | null => {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value)
  // 透明背景不能当成黑色，交给调用方回退到主题默认底色
  if (!match || (match[4] !== undefined && Number(match[4]) === 0)) {
    return null
  }
  return `#${match
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('')}`
}

/**
 * Android 的状态栏、导航栏由原生窗口绘制，不跟随 WebView。
 * 壳里注入了 AndroidTheme 桥，用来同步底色与图标明暗；网页版没有该对象。
 */
const syncNativeTheme = (theme: Theme) => {
  const bridge = (window as unknown as { AndroidTheme?: AndroidThemeBridge }).AndroidTheme
  if (!bridge) {
    return
  }
  const color =
    toHexColor(getComputedStyle(document.body).backgroundColor) ??
    (theme === 'dark' ? '#151517' : '#ffffff')
  try {
    bridge.setTheme(theme === 'dark', color)
  } catch {
    // 旧版壳没有该桥时忽略
  }
}

const syncPageBackground = () => {
  const backgroundColor = getComputedStyle(document.body).backgroundColor
  document.documentElement.style.backgroundColor = backgroundColor
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', backgroundColor)
  syncNativeTheme(document.body.classList.contains('dark') ? 'dark' : 'light')
}

/** 同步页面主题、根画布背景和支持 theme-color 的浏览器栏。 */
const applyTheme = (theme: Theme) => {
  const body = document.body
  // 主题切换帧禁用过渡，使页面颜色同步更新
  body.classList.add('change-theme')
  body.classList.toggle('dark', theme === 'dark')
  body.classList.toggle('light', theme === 'light')
  if (theme === 'dark') {
    body.setAttribute('data-ds-dark-theme', 'dark')
  } else {
    body.removeAttribute('data-ds-dark-theme')
  }
  document.documentElement.style.colorScheme = theme
  // 原生标题栏由窗口系统绘制，需要单独同步一次
  void setWindowTheme(theme)
  // Android 的状态栏与导航栏也要跟着换底色和图标明暗
  syncNativeTheme(theme)
  // 首次背景色同步在样式表加载完成后执行，适配 WebKit 的 defer 脚本执行顺序。
  if (document.readyState === 'complete') {
    syncPageBackground()
  }
  setTimeout(() => {
    body.classList.remove('change-theme')
  }, 0)
}

let appliedTheme: Theme | null = null

const syncTheme = () => {
  const theme = resolveTheme(useSettings.getState().themePreference, getOsTheme())
  if (theme !== appliedTheme) {
    appliedTheme = theme
    applyTheme(theme)
  }
}

/** 首屏渲染前同步应用一次，之后随主题设置与系统深浅色变化更新 */
export const setupTheme = () => {
  syncTheme()
  if (document.readyState !== 'complete') {
    window.addEventListener('load', syncPageBackground, { once: true })
  }
  query.addEventListener('change', syncTheme)
  useSettings.subscribe(syncTheme)
}
