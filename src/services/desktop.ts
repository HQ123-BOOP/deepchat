/**
 * Tauri 壳的最小桥：只在桌面/移动壳里可用，网页版静默跳过。
 * 与本地语音识别共用 __TAURI_INTERNALS__，不额外引入 @tauri-apps/api。
 */

type TauriInternals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

const getInternals = () =>
  (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__

/** 是否运行在 Tauri 壳里 */
export const isTauriShell = () => typeof window !== 'undefined' && Boolean(getInternals())

/** 同步原生标题栏深浅色；网页版或平台不支持时忽略 */
export const setWindowTheme = async (theme: 'light' | 'dark'): Promise<void> => {
  const internals = getInternals()
  if (!internals) {
    return
  }
  try {
    await internals.invoke('set_window_theme', { theme })
  } catch {
    // 标题栏跟随属于增强项，失败不影响页面主题
  }
}
