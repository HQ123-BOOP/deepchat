import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslationMessage } from '../../i18n/index.js'
import {
  isLocalAsrSupported,
  isModelReady,
  transcribeLocal,
} from '../../services/speech/localAsr.js'
import { startRecording, type Recording } from '../../services/speech/recorder.js'
import { showToast } from '../base/toastState.js'

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing'

/**
 * 录音依赖 getUserMedia，转写依赖 Tauri 壳里的本地模型；
 * 网页版没有本地识别能力，直接禁用入口。
 */
const AVAILABLE =
  typeof window !== 'undefined' && window.isSecureContext && isLocalAsrSupported()

const describeRecordingError = (error: unknown): TranslationMessage => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { key: 'voiceInputPermissionDenied' }
    }
    if (error.name === 'NotFoundError') {
      return { key: 'voiceInputNoDevice' }
    }
  }
  return { key: 'voiceInputFailed' }
}

/**
 * 语音输入（oneshot）：点击开始录音，再次点击结束并转写，结果交给 onText 填入输入框。
 * 转写中再次点击取消。录满 120 秒自动结束。
 */
export const useVoiceInput = (onText: (text: string) => void) => {
  const [status, setStatus] = useState<VoiceInputStatus>('idle')
  /** 本次录音已录秒数，只在录音中递增 */
  const [seconds, setSeconds] = useState(0)
  const recordingRef = useRef<Recording | null>(null)
  const operationRef = useRef(0)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const cancelOperation = useCallback(() => {
    operationRef.current++
    recordingRef.current?.cancel()
    recordingRef.current = null
  }, [])

  const cancel = useCallback(() => {
    cancelOperation()
    setStatus('idle')
  }, [cancelOperation])

  const finish = useCallback(async () => {
    const recording = recordingRef.current
    if (!recording) {
      // 仍在等待麦克风授权时也允许取消；迟到的录音对象会立即释放。
      cancel()
      return
    }
    const operation = operationRef.current
    recordingRef.current = null
    try {
      let pcm: Float32Array | null
      try {
        pcm = await recording.stop()
      } finally {
        recording.cancel()
      }
      if (operationRef.current !== operation || !pcm) {
        return
      }
      setStatus('transcribing')
      const text = await transcribeLocal(pcm)
      if (operationRef.current !== operation) {
        return
      }
      if (text.trim()) {
        onTextRef.current(text.trim())
      } else {
        showToast({ key: 'voiceInputEmpty' })
      }
    } catch {
      if (operationRef.current === operation) {
        showToast({ key: 'voiceInputFailed' })
      }
    } finally {
      if (operationRef.current === operation) {
        setStatus('idle')
      }
    }
  }, [cancel])

  const toggle = useCallback(async () => {
    if (!AVAILABLE) {
      return
    }
    // 模型默认不自动下载，需要在设置里手动下载后再使用。
    if (status === 'idle' && !(await isModelReady())) {
      showToast({ key: 'voiceInputModelMissing' })
      return
    }
    if (status === 'recording') {
      await finish()
      return
    }
    if (status === 'transcribing') {
      cancel()
      return
    }
    const operation = ++operationRef.current
    setStatus('recording')
    try {
      const recording = await startRecording(() => {
        if (operationRef.current === operation) {
          showToast({ key: 'voiceInputLimitReached' })
          void finish()
        }
      })
      if (operationRef.current !== operation) {
        recording.cancel()
        return
      }
      recordingRef.current = recording
    } catch (error) {
      if (operationRef.current === operation) {
        setStatus('idle')
        showToast(describeRecordingError(error))
      }
    }
  }, [status, finish, cancel])

  useEffect(() => {
    if (status !== 'recording') {
      return
    }
    const startedAt = Date.now()
    setSeconds(0)
    // 半秒刷新一次，让显示的秒数与实际录音时长保持一致
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => cancelOperation, [cancelOperation])

  /** 当前录音的频谱分析节点，未录音时为 null */
  const getAnalyser = useCallback(() => recordingRef.current?.analyser ?? null, [])

  return { status, seconds, getAnalyser, toggle, cancel, available: AVAILABLE }
}
