import { useState } from 'react'
import { createPortal } from 'react-dom'
import { IconPaperclipOutline16, IconSendOutline16 } from '../base/icons.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconButton } from '../base/IconButton.js'
import { Tooltip } from '../base/Tooltip.js'
import { useTranslate } from '../../i18n/index.js'
import { useVoiceInput } from '../chatInput/useVoiceInput.js'
import { VoiceButton } from '../chatInput/VoiceButton.js'
import { useWorkStore } from '../../services/remote/store.js'
import type { ConfigGroup, ConfigOption, ConfigValue } from '../../services/remote/bridgeClient.js'
import styles from './WorkComposer.module.css'

const isGroup = (option: ConfigValue | ConfigGroup): option is ConfigGroup =>
  'options' in option && !('value' in option)

/** 展平分组选项，保留分组名用于展示 */
const flatten = (
  options: (ConfigValue | ConfigGroup)[]
): { value: string; name: string; group?: string }[] =>
  options.flatMap((option) =>
    isGroup(option)
      ? option.options.map((item) => ({ value: item.value, name: item.name, group: option.name }))
      : [{ value: option.value, name: option.name }]
  )

const modelName = (option: ConfigOption | undefined) => {
  if (!option) {
    return ''
  }
  const match = flatten(option.options).find((item) => item.value === option.currentValue)
  return match?.name ?? option.currentValue
}

const effortName = (option: ConfigOption | undefined) => {
  if (!option) {
    return ''
  }
  const match = flatten(option.options).find((item) => item.value === option.currentValue)
  return match?.name ?? option.currentValue
}

/** 会话配置菜单：模型、推理等级（DSH 的 ACP 只暴露这两项） */
const ConfigMenu = () => {
  const t = useTranslate()
  const config = useWorkStore((state) => state.config)
  const applyConfig = useWorkStore((state) => state.applyConfig)
  const busy = useWorkStore((state) => state.configBusy)
  const [open, setOpen] = useState(false)
  // 与其他浮层一致：挂到 body 避开祖先裁切，空间不足自动翻面
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { side: 'top', align: 'start', offset: 8 })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false))

  const model = config.find((option) => option.id === 'model')
  const effort = config.find((option) => option.id === 'reasoning_effort')
  if (!model && !effort) {
    return null
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {[modelName(model), effortName(effort)].filter(Boolean).join(' · ') || t('workConfig')}
        <span className={styles.chevron}>⌃</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              style={position ?? undefined}
              role="menu"
            >
              {model ? (
                <div className={styles.row}>
                  <div className={styles.rowLabel}>{t('workConfigModel')}</div>
                  <div className={styles.chips}>
                    {flatten(model.options).map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        disabled={busy}
                        className={
                          item.value === model.currentValue ? styles.chipActive : styles.chip
                        }
                        onClick={() => void applyConfig('model', item.value)}
                      >
                        {item.name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {effort ? (
                <div className={styles.row}>
                  <div className={styles.rowLabel}>{t('workConfigEffort')}</div>
                  <div className={styles.chips}>
                    {flatten(effort.options).map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        disabled={busy}
                        className={
                          item.value === effort.currentValue ? styles.chipActive : styles.chip
                        }
                        onClick={() => void applyConfig('reasoning_effort', item.value)}
                      >
                        {item.name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className={styles.row}>
                <div className={styles.rowLabel}>{t('workConfigTeam')}</div>
                <div className={styles.rowHint}>{t('workConfigTeamUnavailable')}</div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}

/** 工作模式的输入框：与主对话共用的录音、发送控件，外加会话配置菜单 */
export const WorkComposer = ({
  draft,
  onDraftChange,
  onSend,
  disabled = false,
  streaming = false,
  showConfig = false,
}: {
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => void
  disabled?: boolean
  streaming?: boolean
  showConfig?: boolean
}) => {
  const t = useTranslate()
  const voice = useVoiceInput((text) => onDraftChange(`${draft}${text}`))

  return (
    <div className={styles.composer}>
      <textarea
        rows={1}
        placeholder={t('workMessagePlaceholder')}
        value={draft}
        disabled={disabled}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onSend()
          }
        }}
      />
      <div className={styles.controls}>
        {showConfig ? <ConfigMenu /> : null}
        <div className={styles.spacer} />
        <Tooltip content={t('workAttachUnavailable')}>
          <IconButton
            size="m"
            icon={<IconPaperclipOutline16 />}
            aria-label={t('attachFile')}
            disabled
            onClick={() => undefined}
          />
        </Tooltip>
        <VoiceButton status={voice.status} seconds={voice.seconds} onClick={voice.toggle} />
        <button
          type="button"
          className={styles.send}
          disabled={disabled || !draft.trim()}
          aria-label={streaming ? t('workStop') : t('send')}
          onClick={onSend}
        >
          <IconSendOutline16 />
        </button>
      </div>
    </div>
  )
}
