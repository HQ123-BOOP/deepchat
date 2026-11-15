import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { getSession } from '../../services/chat/store.js'
import type { Session, SessionSummary } from '../../services/chat/types.js'
import { convertSessionToWork, knownWorkspaces } from '../../services/remote/convert.js'
import { useWorkStore } from '../../services/remote/store.js'
import { setMode } from '../../services/appMode.js'
import styles from './SessionItem.module.css'

/** 「转换为工作模式」：警示不可逆，选工作区，然后导入到 DSH */
export const ConvertToWorkDialog = ({
  session,
  onClose,
}: {
  session: SessionSummary
  onClose: () => void
}) => {
  const t = useTranslate()
  const connected = useWorkStore((state) => Boolean(state.token))
  const openSession = useWorkStore((state) => state.openSession)
  const workspaces = knownWorkspaces()
  const [cwd, setCwd] = useState(workspaces[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const full = await loadSessionForConvert(session.id)
      if (!full) {
        throw new Error('session-not-found')
      }
      const dshSessionId = await convertSessionToWork(full, cwd.trim())
      setMode('work')
      openSession(dshSessionId)
      showToast(t('convertToWorkDone'))
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('convertToWorkTitle')}
      onClose={() => {
        if (!busy) {
          onClose()
        }
      }}
      footer={
        <>
          <Button variant="outlined" disabled={busy} onClick={onClose}>
            {t('convertToWorkCancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !connected || !cwd.trim()}
            onClick={() => void confirm()}
          >
            {t('convertToWorkConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.convertBody}>
        <p className={styles.convertWarning}>{t('convertToWorkWarning')}</p>
        {connected ? null : <p className={styles.convertError}>{t('convertToWorkNeedBridge')}</p>}
        <label className={styles.convertLabel}>
          {t('convertToWorkWorkspace')}
          <input
            className={styles.renameInput}
            list="convert-workspaces"
            placeholder={t('convertToWorkWorkspacePlaceholder')}
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
          />
        </label>
        <datalist id="convert-workspaces">
          {workspaces.map((workspace) => (
            <option key={workspace} value={workspace} />
          ))}
        </datalist>
        {error ? <p className={styles.convertError}>{error}</p> : null}
      </div>
    </Modal>
  )
}

/** 列表里只有摘要，转换前按需加载完整会话 */
const loadSessionForConvert = async (id: string): Promise<Session | null> => {
  const cached = getSession(id)
  if (cached) {
    return cached
  }
  const db = await import('../../services/chat/db.js')
  const stored = await db.loadSession(id)
  return stored ?? null
}
