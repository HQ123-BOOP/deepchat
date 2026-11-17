/**
 * 应用内文本工作区：模型通过 write / edit 生成的文件只存在 SQLite 里，
 * 不读写系统文件；用户主动保存时才通过系统分享或浏览器下载导出到设备。
 */

type TauriInternals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

const getInternals = () =>
  (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__

const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const internals = getInternals()
  if (!internals) {
    throw new Error('Workspace commands require the Tauri shell')
  }
  return (await internals.invoke(cmd, args)) as T
}

export type WorkspaceEntry = {
  path: string
  /** UTF-8 字节数 */
  size: number
  updatedAt: number
}

export const listWorkspaceFiles = (sessionId: string) =>
  invoke<WorkspaceEntry[]>('ws_list', { sessionId })

export const readWorkspaceFile = (sessionId: string, path: string) =>
  invoke<string | null>('ws_read', { sessionId, path })

export type WorkspaceWriteResult = {
  operation: 'create' | 'update'
  added: number
  removed: number
}

/** 编辑结果的行级增删数 */
export type WorkspaceEditResult = {
  added: number
  removed: number
}

export const writeWorkspaceFile = (sessionId: string, path: string, content: string) =>
  invoke<WorkspaceWriteResult>('ws_write', { sessionId, path, content })

export const editWorkspaceFile = (
  sessionId: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
) => invoke<WorkspaceEditResult>('ws_edit', { sessionId, path, oldString, newString, replaceAll })

/**
 * 把工作区文件交给系统：能分享附件时走分享面板（Android 可存到「文件」），
 * 否则退化为浏览器下载。用户取消分享不算失败。
 */
export const saveWorkspaceFile = async (sessionId: string, path: string): Promise<boolean> => {
  const text = await readWorkspaceFile(sessionId, path)
  if (text === null) {
    return false
  }
  const name = path.split('/').pop() || 'file.txt'
  const file = new File([text], name, { type: 'text/plain;charset=utf-8' })
  const shareNavigator = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean
  }
  if (shareNavigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name })
      return true
    } catch (error) {
      // 用户取消分享不算失败；其他错误退回下载
      if ((error as DOMException | undefined)?.name === 'AbortError') {
        return true
      }
    }
  }
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noreferrer'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}
