/**
 * 设备本地语音识别：调用 Tauri 后端的 CrispASR 原生库（Android 上是 SenseVoice-Small Q4_K）。
 *
 * 策略：首次使用时加载模型（实测 ~50 ms），之后保留在内存里；
 * 空闲 5 分钟或页面转入后台时释放，避免长期占用 RSS。
 * 网页版没有 Tauri 运行时，语音输入直接不可用。
 */

type TauriInternals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

const getInternals = () => (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__

/** 是否具备本地识别能力（运行在 Tauri 壳里） */
export const isLocalAsrSupported = () => typeof window !== 'undefined' && Boolean(getInternals())

const IDLE_RELEASE_MS = 5 * 60 * 1000

let opened = false
let idleTimer: ReturnType<typeof setTimeout> | undefined
let releasing = false

const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const internals = getInternals()
  if (!internals) {
    throw new Error('当前环境不支持本地语音识别')
  }
  return (await internals.invoke(cmd, args)) as T
}

const clearIdleTimer = () => {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer)
    idleTimer = undefined
  }
}

const scheduleRelease = () => {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    void releaseLocalAsr()
  }, IDLE_RELEASE_MS)
}

/** 释放模型占用的内存；下次使用时按需重新加载 */
export const releaseLocalAsr = async (): Promise<void> => {
  clearIdleTimer()
  if (!opened || releasing) {
    return
  }
  releasing = true
  opened = false
  try {
    await invoke('asr_close')
  } catch {
    // 释放失败不影响后续使用，下次 ensureOpen 会重新加载
  } finally {
    releasing = false
  }
}

/** 模型文件是否已就绪（首次使用需要下载，约 135 MB） */
export const isModelReady = async (): Promise<boolean> => {
  if (!isLocalAsrSupported()) {
    return false
  }
  return invoke<boolean>('asr_model_ready')
}

/** 下载模型文件；重复调用会复用同一个下载请求 */
let downloading: Promise<void> | undefined
export const downloadModel = (): Promise<void> => {
  downloading ??= invoke('asr_download_model')
    .then(() => undefined)
    .finally(() => {
      downloading = undefined
    })
  return downloading
}

const ensureOpen = async (): Promise<void> => {
  if (opened) {
    return
  }
  const modelPath = await invoke<string>('asr_model_path')
  await invoke('asr_open', { modelPath, threads: 4 })
  opened = true
  scheduleRelease()
}

/**
 * 转写一段 16 kHz 单声道 PCM。
 * lang 传 null 时交给模型自动判断语种（SenseVoice 支持中/英/粤/日/韩）。
 */
export const transcribeLocal = async (pcm: Float32Array): Promise<string> => {
  await ensureOpen()
  try {
    const text = await invoke<string>('asr_transcribe', {
      pcm: Array.from(pcm),
      lang: null,
    })
    return text
  } finally {
    scheduleRelease()
  }
}

// 页面进入后台时立即释放，回到前台再次使用时重新加载
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void releaseLocalAsr()
    }
  })
}
