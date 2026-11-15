import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconPanelLeftOutline16, IconSettingsOutline16, NewChatIcon } from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { setMode } from '../../services/appMode.js'
import { useWorkStore } from '../../services/remote/store.js'
import { ConvertToWorkDialog } from './ConvertToWorkDialog.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const workToken = useWorkStore((state) => Boolean(state.token))
  const workSessions = useWorkStore((state) => state.sessions)
  const activeWorkId = useWorkStore((state) => state.activeSessionId)
  const openWorkSession = useWorkStore((state) => state.openSession)
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [converting, setConverting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.listWrap}>
        <div className={styles.list}>
          <details className={styles.group} open>
            <summary className={styles.groupTitle}>{t('siderChatGroup')}</summary>
            {groups.map((group) => (
              <div key={group.key} className={styles.section}>
                <div className={styles.sectionHeader}>{group.label}</div>
                {group.sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={session.id === activeId}
                    onDelete={() => setDeleting(session)}
                    onConvert={() => setConverting(session)}
                  />
                ))}
              </div>
            ))}
          </details>
          <details className={styles.group} open>
            <summary className={styles.groupTitle}>{t('siderWorkGroup')}</summary>
            {workToken ? (
              workSessions.length > 0 ? (
                workSessions.map((session) => (
                  <button
                    key={session.sessionId}
                    type="button"
                    className={clsx(
                      styles.workItem,
                      session.sessionId === activeWorkId && styles.active
                    )}
                    onClick={() => {
                      setMode('work')
                      openWorkSession(session.sessionId)
                      closeMobileSider()
                    }}
                  >
                    <span className={styles.workTitle}>
                      {session.title || session.cwd.split(/[\\/]/).at(-1) || session.sessionId}
                    </span>
                    <span className={styles.workCwd}>{session.cwd}</span>
                  </button>
                ))
              ) : (
                <div className={styles.sectionHeader}>{t('siderWorkEmpty')}</div>
              )
            ) : (
              <div className={styles.sectionHeader}>{t('siderWorkDisconnected')}</div>
            )}
          </details>
        </div>
      </div>
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {converting ? (
        <ConvertToWorkDialog session={converting} onClose={() => setConverting(null)} />
      ) : null}
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  // 抽屉常驻，靠 transform 过渡滑入；关闭时不可聚焦也不拦截点击
  return (
    <>
      <div
        className={clsx(styles.drawerMask, open && styles.drawerMaskOpen)}
        onClick={closeMobileSider}
      />
      <div className={clsx(styles.drawer, open && styles.drawerOpen)} aria-hidden={!open}>
        <Sider mobile />
      </div>
    </>
  )
}
