import { useEffect, useState } from 'react'
import { useTranslate } from '../i18n/index.js'
import { Button } from '../components/base/Button.js'
import { Modal } from '../components/base/Modal.js'
import * as db from '../services/chat/db.js'
import styles from './DatabaseRecoveryDialog.module.css'

/** 数据库打不开时接管界面：重试或备份损坏的库并重建，成功前不碰原文件。 */
export const DatabaseRecoveryDialog = () => {
  const t = useTranslate()
  const [corrupt, setCorrupt] = useState(false)
  const [busy, setBusy] = useState<'retry' | 'rebuild' | null>(null)
  const [failed, setFailed] = useState(false)
  const [backupPath, setBackupPath] = useState<string | null>(null)

  useEffect(() => {
    void db
      .health()
      .then((state) => setCorrupt(state.corrupt))
      .catch(() => {})
  }, [])

  const reload = () => window.location.reload()

  const retry = async () => {
    setBusy('retry')
    setFailed(false)
    try {
      if (await db.retryOpen()) {
        reload()
        return
      }
      setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(null)
    }
  }

  const rebuild = async () => {
    setBusy('rebuild')
    setFailed(false)
    try {
      setBackupPath(await db.rebuild())
    } catch {
      setFailed(true)
    } finally {
      setBusy(null)
    }
  }

  if (backupPath) {
    return (
      <Modal
        title={t('databaseRebuildDone')}
        onClose={reload}
        footer={<Button onClick={reload}>{t('gotIt')}</Button>}
      >
        <p className={styles.text}>
          {t('databaseRebuildDoneHint', { path: backupPath })}
        </p>
      </Modal>
    )
  }

  if (!corrupt) {
    return null
  }

  return (
    <Modal
      title={t('databaseCorrupted')}
      onClose={() => {}}
      footer={
        <div className={styles.actions} aria-busy={busy !== null}>
          <Button variant="outlined" disabled={busy !== null} onClick={() => void rebuild()}>
            {t('backupAndRebuildDatabase')}
          </Button>
          <Button disabled={busy !== null} onClick={() => void retry()}>
            {t('retry')}
          </Button>
        </div>
      }
    >
      <p className={styles.text}>{t('databaseCorruptedHint')}</p>
      {failed ? <p className={styles.error}>{t('databaseRecoveryFailed')}</p> : null}
    </Modal>
  )
}
