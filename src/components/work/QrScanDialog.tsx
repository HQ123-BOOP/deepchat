import { useEffect, useRef, useState } from 'react'
import * as jsQRModule from 'jsqr'
import { useTranslate } from '../../i18n/index.js'
import { Modal } from '../base/Modal.js'
import styles from './QrScanDialog.module.css'

/**
 * 网页里直接扫码：getUserMedia 取摄像头画面，jsQR 在本地解码。
 *
 * 不走原生的 barcode-scanner 插件——它在 Android 上打开相机会直接闪退；
 * 走 WebView 摄像头时权限由 WebRTC 申请，失败也只是拿不到画面，不会崩。
 */
/** jsqr 的运行时是 CJS，类型声明却是 default 导出，两种形态都兜一层 */
type QrDecoder = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null
const decodeQr: QrDecoder =
  (jsQRModule as unknown as { default?: QrDecoder }).default ?? (jsQRModule as unknown as QrDecoder)

export const QrScanDialog = ({
  onResult,
  onClose,
}: {
  onResult: (text: string) => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let stopped = false

    const scan = () => {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || stopped) {
        return
      }
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const width = video.videoWidth
        const height = video.videoHeight
        if (width > 0 && height > 0) {
          // 缩到 480 宽再解码，够清晰也不会卡住主线程
          const scale = Math.min(1, 480 / width)
          canvas.width = Math.round(width * scale)
          canvas.height = Math.round(height * scale)
          const context = canvas.getContext('2d', { willReadFrequently: true })
          if (context) {
            context.drawImage(video, 0, 0, canvas.width, canvas.height)
            const image = context.getImageData(0, 0, canvas.width, canvas.height)
            const code = decodeQr(image.data, image.width, image.height)
            if (code?.data) {
              stopped = true
              onResult(code.data)
              return
            }
          }
        }
      }
      raf = requestAnimationFrame(scan)
    }

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
        if (stopped) {
          return
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => undefined)
        }
        raf = requestAnimationFrame(scan)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      for (const track of stream?.getTracks() ?? []) {
        track.stop()
      }
    }
  }, [onResult])

  return (
    <Modal title={t('workScan')} onClose={onClose}>
      <div className={styles.body}>
        <video ref={videoRef} className={styles.video} muted playsInline />
        <canvas ref={canvasRef} className={styles.canvas} />
        {error ? (
          <>
            <p className={styles.error}>{t('workScanCameraFailed')}</p>
            <p className={styles.hint}>{error}</p>
          </>
        ) : (
          <p className={styles.hint}>{t('workScanHint')}</p>
        )}
      </div>
    </Modal>
  )
}
