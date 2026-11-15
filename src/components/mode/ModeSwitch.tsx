import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { setMode, useModeStore, type AppMode } from '../../services/appMode.js'
import styles from './ModeSwitch.module.css'

/** 顶部的「对话 / 工作」切换：工作模式需要先连接局域网里的 DSH */
export const ModeSwitch = () => {
  const t = useTranslate()
  const mode = useModeStore((state) => state.mode)
  const options: { value: AppMode; label: string }[] = [
    { value: 'chat', label: t('modeChat') },
    { value: 'work', label: t('modeWork') },
  ]
  return (
    <div className={styles.wrap}>
      <div className={styles.switch} role="tablist">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={mode === option.value}
            className={clsx(styles.option, mode === option.value && styles.active)}
            onClick={() => setMode(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
