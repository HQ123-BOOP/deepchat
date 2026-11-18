import { useTranslate } from '../../i18n/index.js'
import { useMemo, useRef, useState } from 'react'
import { useDismiss } from '../base/anchored.js'
import { useChatStore } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { resolveModelLimits } from '../../services/providers/piAi.js'
import { estimateTokens } from '../../services/chat/providerContext.js'
import type { Message } from '../../services/chat/types.js'
import styles from './ContextMeter.module.css'

/** 圆圈几何：14px viewBox，2px 描边 */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** 最近一次 usage 之后新增的消息按其文本长度估算，和 harness 的 surface 增量同理 */
const estimateMessage = (message: Message) => {
  if (message.role === 'user') {
    return estimateTokens(message.content) + message.files.length * 64 + 8
  }
  let total = 8
  for (const block of message.blocks) {
    if (block.type === 'text') {
      total += estimateTokens(block.text)
    } else if (block.type === 'thinking') {
      total += estimateTokens(block.thinking)
    }
  }
  return total
}

const formatTokens = (value: number) => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`
  }
  return String(value)
}

/** 输入栏的上下文占用：圆圈进度 + 百分比，点击展开已用 / 窗口 */
export const ContextMeter = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const used = useChatStore((state) => {
    const messages = sessionId ? state.sessionCache[sessionId]?.messages : undefined
    if (!messages) {
      return undefined
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role !== 'assistant' || !message.usage) {
        continue
      }
      // 与 harness 一致：prompt 侧 input + 缓存，加上采样之后新产生的输出与消息
      const pressure =
        message.usage.input_tokens +
        message.usage.cache_creation_input_tokens +
        message.usage.cache_read_input_tokens
      const output = message.usage.output_tokens
      let extra = 0
      for (let next = i + 1; next < messages.length; next++) {
        extra += estimateMessage(messages[next])
      }
      return pressure + output + extra
    }
    return undefined
  })
  const provider = useSettings((state) => state.provider)
  const contextWindow = useMemo(
    () =>
      resolveModelLimits(
        {
          provider: provider.piProvider,
          api: provider.piApi,
          baseUrl: provider.piBaseUrl,
          apiKey: provider.apiKey,
          contextWindow: provider.contextWindow,
          maxTokens: provider.maxTokens,
          inputModalities: provider.inputModalities,
        },
        provider.model
      ).window,
    [provider]
  )
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useDismiss(open, [rootRef, panelRef], () => setOpen(false))
  if (used === undefined || used <= 0 || contextWindow <= 0) {
    return null
  }
  const percent = Math.min(100, Math.round((used / contextWindow) * 100))
  const reading = `${percent}%`
  return (
    <div ref={rootRef} className={styles.root}>
      <button
        type="button"
        className={styles.trigger}
        aria-label={t('contextUsed', { percent: reading })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <circle className={styles.track} cx="7" cy="7" r={RADIUS} />
          <circle
            className={styles.ring}
            cx="7"
            cy="7"
            r={RADIUS}
            strokeDasharray={`${(CIRCUMFERENCE * percent) / 100} ${CIRCUMFERENCE}`}
            transform="rotate(-90 7 7)"
          />
        </svg>
        <span className={styles.reading}>{reading}</span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className={styles.panel}
          role="dialog"
          aria-label={t('contextUsageTitle')}
        >
          <div className={styles.header}>
            <span>{t('contextUsageTitle')}</span>
            <span className={styles.percent}>{reading}</span>
          </div>
          <div className={styles.figures}>
            {`~${formatTokens(used)} / ${formatTokens(contextWindow)}`}
          </div>
          <div className={styles.bar}>
            <div className={styles.fill} style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
