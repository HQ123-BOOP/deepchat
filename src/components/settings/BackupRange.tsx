import { useTranslate } from '../../i18n/index.js'
import type { BackupProgress, BackupRange } from '../../services/chat/backup.js'
import styles from './Settings.module.css'

/** 范围选择器的本地状态：天数与条数即使未选中也保留，方便来回切换 */
export type RangeState = {
  kind: 'all' | 'days' | 'latest'
  days: number
  count: number
}

export const DEFAULT_RANGE: RangeState = { kind: 'all', days: 7, count: 20 }

export const toBackupRange = (state: RangeState): BackupRange =>
  state.kind === 'all'
    ? { kind: 'all' }
    : state.kind === 'days'
      ? { kind: 'days', days: state.days }
      : { kind: 'latest', count: state.count }

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min

/** 三选一的范围：全部 / 最近 N 天 / 最新 N 条 */
export const RangePicker = ({
  value,
  onChange,
  disabled,
}: {
  value: RangeState
  onChange: (next: RangeState) => void
  disabled?: boolean
}) => {
  const t = useTranslate()
  const pick = (kind: RangeState['kind']) => {
    if (!disabled) {
      onChange({ ...value, kind })
    }
  }
  return (
    <div className={styles.range} role="radiogroup" aria-label={t('historyRangeLabel')}>
      <label className={styles.rangeRow}>
        <input
          type="radio"
          name="backup-range"
          checked={value.kind === 'all'}
          disabled={disabled}
          onChange={() => pick('all')}
        />
        <span>{t('historyRangeAll')}</span>
      </label>
      <label className={styles.rangeRow}>
        <input
          type="radio"
          name="backup-range"
          checked={value.kind === 'days'}
          disabled={disabled}
          onChange={() => pick('days')}
        />
        <span>{t('historyRangeDays')}</span>
        <input
          className={styles.rangeInput}
          type="number"
          inputMode="numeric"
          min={1}
          max={3650}
          value={value.days}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, days: clamp(Number(event.target.value), 1, 3650) })
          }
        />
        <span>{t('historyRangeDaysUnit')}</span>
      </label>
      <label className={styles.rangeRow}>
        <input
          type="radio"
          name="backup-range"
          checked={value.kind === 'latest'}
          disabled={disabled}
          onChange={() => pick('latest')}
        />
        <span>{t('historyRangeLatest')}</span>
        <input
          className={styles.rangeInput}
          type="number"
          inputMode="numeric"
          min={1}
          max={10000}
          value={value.count}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, count: clamp(Number(event.target.value), 1, 10000) })
          }
        />
        <span>{t('historyRangeLatestUnit')}</span>
      </label>
    </div>
  )
}

/** 一条细进度条 + 「已完成 / 总数」 */
export const RangeProgress = ({ progress }: { progress: BackupProgress | null }) => {
  const t = useTranslate()
  if (!progress || progress.total <= 0) {
    return null
  }
  const percent = Math.min(100, Math.round((progress.done / progress.total) * 100))
  return (
    <div className={styles.progress}>
      <div className={styles.progressTrack}>
        <div className={styles.progressBar} style={{ width: `${percent}%` }} />
      </div>
      <div className={styles.progressText}>
        {t('historyProgress', { done: progress.done, total: progress.total })}
      </div>
    </div>
  )
}
