import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import logoUrl from '../../assets/deepchat.svg'
import { useTranslate } from '../../i18n/index.js'
import { IconPanelLeftOutline16, IconSettingsOutline16, NewChatIcon } from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { appVersion } from '../../services/updates.js'
import { openExternal } from '../../services/nativeMedia.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, openMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 连点品牌标志打开的彩蛋页面 */
const PROJECT_URL = 'https://github.com/HQ123-BOOP/deepchat'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  // 对话分组默认展开；收起/展开用高度过渡，内容整体推动
  const [chatGroupOpen, setChatGroupOpen] = useState(true)
  // 2 秒内连点 5 次品牌标志打开项目主页
  const brandClicks = useRef<number[]>([])

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
        <div
          className={styles.brand}
          onClick={() => {
            const now = Date.now()
            const recent = brandClicks.current.filter((time) => now - time < 2000)
            recent.push(now)
            brandClicks.current = recent
            if (recent.length >= 5) {
              brandClicks.current = []
              if (!openExternal(PROJECT_URL)) {
                window.open(PROJECT_URL, '_blank', 'noreferrer')
              }
            }
          }}
        >
          <img className={styles.brandMark} src={logoUrl} alt="" />
          <span className={styles.brandName}>DeepChat</span>
          <span className={styles.brandVersion}>v{appVersion()}</span>
        </div>
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
          <div className={styles.group}>
            <button
              type="button"
              className={styles.groupTitle}
              aria-expanded={chatGroupOpen}
              onClick={() => setChatGroupOpen((value) => !value)}
            >
              {t('siderChatGroup')}
            </button>
            <div className={clsx(styles.groupBody, chatGroupOpen && styles.groupBodyOpen)}>
              <div className={styles.groupBodyInner}>
                {groups.map((group) => (
                  <div key={group.key} className={styles.section}>
                    <div className={styles.sectionHeader}>{group.label}</div>
                    {group.sessions.map((session) => (
                      <SessionItem
                        key={session.id}
                        session={session}
                        active={session.id === activeId}
                        onDelete={() => setDeleting(session)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
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

/** 从触摸起点往上找横向可滚动容器：这类区域里的横滑留给内容本身 */
const insideHorizontalScroller = (node: Element | null): boolean => {
  for (let element = node; element && element !== document.body; element = element.parentElement) {
    if (element.scrollWidth > element.clientWidth + 2) {
      const { overflowX } = getComputedStyle(element)
      if (overflowX === 'auto' || overflowX === 'scroll') {
        return true
      }
    }
  }
  return false
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭；右滑拉出、左滑推回。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const drawerRef = useRef<HTMLDivElement>(null)
  // 拖动中的位移与遮罩透明度；null 表示没有拖动，交给 CSS 过渡
  const [drag, setDrag] = useState<{ x: number; opacity: number } | null>(null)

  useEffect(() => {
    let startX = 0
    let startY = 0
    let base = 0
    let width = 0
    let offset = 0
    let active = false
    let horizontal = false

    const start = (event: TouchEvent) => {
      active = false
      if (event.touches.length !== 1) {
        return
      }
      // 弹窗（例如设置）在前时不接管手势
      if (document.querySelector('[role="dialog"]')) {
        return
      }
      const touch = event.touches[0]
      const isOpen = useMobileSider.getState().open
      if (
        !isOpen &&
        (touch.clientX > window.innerWidth - 40 ||
          insideHorizontalScroller(event.target as Element | null) ||
          (event.target as Element | null)?.closest('input, textarea, [contenteditable="true"]'))
      ) {
        return
      }
      width = drawerRef.current?.offsetWidth ?? 0
      if (width <= 0) {
        return
      }
      startX = touch.clientX
      startY = touch.clientY
      base = isOpen ? 0 : -width
      offset = base
      active = true
      horizontal = false
    }

    const move = (event: TouchEvent) => {
      if (!active || event.touches.length !== 1) {
        return
      }
      const touch = event.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (!horizontal) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
          return
        }
        // 纵向手势交还给页面滚动
        if (Math.abs(dx) <= Math.abs(dy)) {
          active = false
          return
        }
        horizontal = true
      }
      if (event.cancelable) {
        event.preventDefault()
      }
      offset = Math.min(0, Math.max(-width, base + dx))
      setDrag({ x: offset, opacity: 1 + offset / width })
    }

    const end = () => {
      if (!active) {
        return
      }
      const dragged = horizontal
      active = false
      horizontal = false
      if (!dragged) {
        return
      }
      if (offset > -width / 2) {
        openMobileSider()
      } else {
        closeMobileSider()
      }
      setDrag(null)
    }

    document.addEventListener('touchstart', start, { passive: true })
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', end)
    document.addEventListener('touchcancel', end)
    return () => {
      document.removeEventListener('touchstart', start)
      document.removeEventListener('touchmove', move)
      document.removeEventListener('touchend', end)
      document.removeEventListener('touchcancel', end)
    }
  }, [])

  // 抽屉常驻，靠 transform 过渡滑入；关闭时不可聚焦也不拦截点击
  return (
    <>
      <div
        className={clsx(styles.drawerMask, open && styles.drawerMaskOpen)}
        style={drag ? { opacity: drag.opacity, transition: 'none' } : undefined}
        onClick={closeMobileSider}
      />
      <div
        ref={drawerRef}
        className={clsx(styles.drawer, open && styles.drawerOpen)}
        style={drag ? { transform: `translateX(${drag.x}px)`, transition: 'none' } : undefined}
        aria-hidden={!open}
      >
        <Sider mobile />
      </div>
    </>
  )
}
