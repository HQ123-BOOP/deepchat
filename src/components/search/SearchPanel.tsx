import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Source } from '../../services/chat/view.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { closeSearchPanel, useSearchPanel } from './searchPanelState.js'
import { SourceCard } from './SourceCard.js'
import styles from './SearchPanel.module.css'

/**
 * 右侧「搜索结果」面板。
 * 常驻挂载，只切换宽度：打开时把左侧对话区推开，收起时推回。
 * 保持 DOM 是为了让宽度过渡始终有起点，避免首次挂载直接落在终态。
 */
export const SearchPanel = () => {
  const t = useTranslate()
  const entry = useSearchPanel((state) => state.entry)
  const sources = useSearchPanel((state) => state.sources)
  // 收起后保留最后一次的内容，再次展开时不会先闪空
  const [remembered, setRemembered] = useState<Source[]>([])
  useEffect(() => {
    if (entry) {
      setRemembered(sources)
    }
  }, [entry, sources])
  // 展开时直接用当前来源，避免等 effect 回填导致首帧空白
  const items = entry ? sources : remembered
  const open = Boolean(entry)
  const isMobile = useIsMobile()

  // 移动端是全屏抽屉：压一条历史记录，Android 返回键先收起面板回到原对话
  useEffect(() => {
    if (!isMobile || !open) {
      return
    }
    const token = `search-${Date.now()}`
    history.pushState({ ...history.state, [token]: true }, '')
    let popped = false
    const onPop = () => {
      popped = true
      closeSearchPanel()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if (!popped) {
        history.back()
      }
    }
  }, [isMobile, open])

  return (
    <aside className={clsx(styles.panel, open && styles.panelOpen)} aria-hidden={!open}>
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
          {items.map((source) => (
            <SourceCard key={source.url} source={source} className={styles.item} />
          ))}
        </div>
      </div>
    </aside>
  )
}
