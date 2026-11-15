/**
 * 凭据存储：Tauri 壳里走系统凭据库（Rust 侧的 secret_* 命令），
 * 纯网页环境下退回 localStorage（只用于开发预览，不要用于真实令牌）。
 */

type TauriInternals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

const getInternals = () =>
  (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__

const hasTauri = () => typeof window !== 'undefined' && Boolean(getInternals())

export const secureSet = async (key: string, value: string): Promise<void> => {
  const internals = getInternals()
  if (internals) {
    await internals.invoke('secret_set', { key, value })
    return
  }
  localStorage.setItem(`chat-demo:secret:${key}`, value)
}

export const secureGet = async (key: string): Promise<string | null> => {
  const internals = getInternals()
  if (internals) {
    const value = (await internals.invoke('secret_get', { key })) as string | null
    return value ?? null
  }
  return localStorage.getItem(`chat-demo:secret:${key}`)
}

export const secureDelete = async (key: string): Promise<void> => {
  const internals = getInternals()
  if (internals) {
    await internals.invoke('secret_delete', { key })
    return
  }
  localStorage.removeItem(`chat-demo:secret:${key}`)
}

export { hasTauri }
