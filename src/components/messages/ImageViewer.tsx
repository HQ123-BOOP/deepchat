import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from '../base/icons.js'
import styles from './ImageViewer.module.css'

/**
 * 全屏图片查看：图片按自身比例 contain 在可用区域内，不拉伸也不裁切。
 * 打开时压入一条历史记录，Android 返回键先关闭查看器；桌面端点遮罩或 Esc 关闭。
 */
export const ImageViewer = ({
  url,
  name,
  onClose,
}: {
  url: string
  name: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const finish = () => {
    window.clearTimeout(timer.current)
    closeRef.current()
  }

  const close = () => {
    if (closingRef.current) {
      return
    }
    closingRef.current = true
    setClosing(true)
    timer.current = window.setTimeout(finish, 160)
  }

  useEffect(() => {
    const token = `image-${Date.now()}-${Math.random()}`
    history.pushState({ ...history.state, [token]: true }, '')
    let popped = false
    const onPop = () => {
      popped = true
      if (closingRef.current) {
        finish()
      } else {
        close()
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }
    window.addEventListener('popstate', onPop)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('popstate', onPop)
      document.removeEventListener('keydown', onKeyDown)
      window.clearTimeout(timer.current)
      // 通过按钮或遮罩关闭时把历史记录退掉，避免下次返回多退一步
      if (!popped) {
        history.back()
      }
    }
    // 只在挂载时压入历史；close / finish 通过闭包读取 ref，不随渲染重建
  }, [])

  return createPortal(
    <div
      className={`${styles.overlay}${closing ? ` ${styles.closing}` : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          close()
        }
      }}
    >
      <button type="button" className={styles.close} aria-label={t('close')} onClick={close}>
        <IconCloseOutline16 />
      </button>
      <img className={styles.image} src={url} alt={name} />
    </div>,
    document.body
  )
}
