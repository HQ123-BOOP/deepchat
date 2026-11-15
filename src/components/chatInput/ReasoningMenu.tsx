import { useState } from 'react'
import { IconThinkOutline14 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setReasoningEffort, useSettings, type ReasoningEffort } from '../../services/settings.js'
import styles from './ReasoningMenu.module.css'

const LEVELS: ReasoningEffort[] = ['off', 'low', 'high', 'max']

const LABEL_KEYS = {
  off: 'reasoningOff',
  low: 'reasoningLow',
  high: 'reasoningHigh',
  max: 'reasoningMax',
} as const

/** 推理等级：对应 API 的 output_config.effort，off 关闭思考模式 */
export const ReasoningMenu = () => {
  const t = useTranslate()
  const effort = useSettings((state) => state.reasoningEffort)
  const [open, setOpen] = useState(false)
  const current = t(LABEL_KEYS[effort])

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`${styles.trigger} ${effort !== 'off' ? styles.triggerActive : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconThinkOutline14 />
        <span>{t('reasoningLevel')}</span>
        <span className={styles.value}>{current}</span>
      </button>
      {open ? (
        <>
          <div className={styles.mask} onClick={() => setOpen(false)} />
          <div className={styles.menu} role="menu">
            <div className={styles.title}>{t('reasoningLevel')}</div>
            {LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                role="menuitemradio"
                aria-checked={level === effort}
                className={level === effort ? styles.itemActive : styles.item}
                onClick={() => {
                  setReasoningEffort(level)
                  setOpen(false)
                }}
              >
                <span>{t(LABEL_KEYS[level])}</span>
                {level === effort ? <span className={styles.check}>✓</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
