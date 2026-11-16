import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { Source } from '../../services/chat/view.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { closeSearchPanel, useSearchPanel } from './searchPanelState.js'
import { SourceCard } from './SourceCard.js'
import styles from './SearchPanel.module.css'

/** 收起动画时长，需与 CSS 的 transition 保持一致 */
const CLOSE_MS = 260

/**
 * 右侧「搜索结果」面板。
 * 打开时宽度从 0 过渡到目标值，把左侧对话区推过去；收起时反向推回再卸载。
 */
export const SearchPanel = () => {
  const t = useTranslate()
  const entry = useSearchPanel((state) => state.entry)
  const sources = useSearchPanel((state) => state.sources)
  // 收起过程中仍要显示最后一次的内容
  const [snapshot, setSnapshot] = useState<{ sources: Source[] } | null>(null)
  const [mounted, setMounted] = useState(Boolean(entry))
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (entry) {
      setSnapshot({ sources })
    }
  }, [entry, sources])

  useEffect(() => {
    if (entry) {
      window.clearTimeout(closeTimer.current)
      setMounted(true)
      // 先以收起态挂载一帧，再切到展开态，宽度才有过渡起点
      const frame = requestAnimationFrame(() => setOpen(true))
      return () => cancelAnimationFrame(frame)
    }
    setOpen(false)
    closeTimer.current = window.setTimeout(() => setMounted(false), CLOSE_MS)
    return () => window.clearTimeout(closeTimer.current)
  }, [entry])

  if (!mounted || !snapshot) {
    return null
  }

  return (
    <aside className={clsx(styles.panel, open && styles.panelOpen)}>
      <div className={styles.panelInner}>
        <div className={styles.header}>
          <div role="heading" className={styles.title}>
            {t('searchResult')}
          </div>
          <IconButton
            icon={<IconCloseOutline16 />}
            aria-label={t('close')}
            onClick={closeSearchPanel}
          />
        </div>
        <div className={styles.content}>
          {snapshot.sources.map((source) => (
            <SourceCard key={source.url} source={source} className={styles.item} />
          ))}
        </div>
      </div>
    </aside>
  )
}
