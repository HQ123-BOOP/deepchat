import { useTranslate } from '../../i18n/index.js'
import { useState } from 'react'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconDataOutline16,
} from '../base/icons.js'
import { Markdown } from '../markdown/Markdown.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import styles from './CompactionMarker.module.css'

/** 上下文压缩记录：一行状态，展开查看结构化摘要 */
export const CompactionMarker = ({ message }: { message: AssistantMessage }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const compaction = message.compaction
  if (!compaction) {
    return null
  }
  const running = compaction.running === true
  const summary = running
    ? t('compactionRunning')
    : t('compactionCompleted', {
        items: compaction.items,
        tokens: compaction.tokens.toLocaleString(),
      })
  return (
    <div className={styles.row}>
      <button
        type="button"
        className={styles.button}
        aria-expanded={running ? undefined : open}
        disabled={running}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.icon} aria-hidden="true">
          <IconDataOutline16 />
        </span>
        <span className={styles.title}>{t('compactionTitle')}</span>
        <span className={styles.sep} aria-hidden="true" />
        <span className={styles.summary}>{summary}</span>
        {running ? null : (
          <span className={styles.chevron} aria-hidden="true">
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        )}
      </button>
      {open && !running ? (
        <div className={styles.body}>
          <Markdown
            content={compaction.summary}
            loading={false}
            cacheKey={`${message.id}-compaction`}
            disableLink
          />
        </div>
      ) : null}
    </div>
  )
}
