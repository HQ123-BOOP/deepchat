import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Markdown } from '../markdown/Markdown.js'
import { useTranslate } from '../../i18n/index.js'
import { parsePairingUri } from '../../services/remote/bridgeClient.js'
import { QrScanDialog } from './QrScanDialog.js'
import { useWorkStore } from '../../services/remote/store.js'
import styles from './WorkView.module.css'

/** 未连接：输入地址与配对码 */
const ConnectForm = () => {
  const t = useTranslate()
  const connect = useWorkStore((state) => state.connect)
  const status = useWorkStore((state) => state.status)
  const error = useWorkStore((state) => state.error)
  const savedHost = useWorkStore((state) => state.host)
  const savedPort = useWorkStore((state) => state.port)
  const [host, setHost] = useState(savedHost)
  const [port, setPort] = useState(String(savedPort))
  const [code, setCode] = useState('')
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)

  const onScanned = (content: string) => {
    setScanning(false)
    const parsed = parsePairingUri(content)
    if (!parsed) {
      setScanError(t('workScanUnrecognized'))
      return
    }
    setHost(parsed.host)
    setPort(String(parsed.port))
    setCode(parsed.code)
  }

  return (
    <div className={styles.panel}>
      <div className={styles.title}>{t('workConnectTitle')}</div>
      <div className={styles.hint}>{t('workConnectHint')}</div>
      <div className={styles.field}>
        <input
          placeholder={t('workHostPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          value={host}
          onChange={(event) => setHost(event.target.value)}
        />
      </div>
      <div className={styles.row}>
        <div className={styles.field} style={{ flex: 1 }}>
          <input
            placeholder={t('workPortPlaceholder')}
            inputMode="numeric"
            value={port}
            onChange={(event) => setPort(event.target.value)}
          />
        </div>
        <div className={styles.field} style={{ flex: 1 }}>
          <input
            placeholder={t('workCodePlaceholder')}
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
      </div>
      <button type="button" className={styles.linkButton} onClick={() => setScanning(true)}>
        {t('workScan')}
      </button>
      {scanning ? <QrScanDialog onResult={onScanned} onClose={() => setScanning(false)} /> : null}
      {scanError ? <div className={styles.error}>{scanError}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}
      <button
        type="button"
        className={styles.action}
        disabled={status === 'connecting' || !host.trim() || code.trim().length !== 6}
        onClick={() => void connect(host.trim(), Number(port) || 18923, code.trim())}
      >
        {status === 'connecting' ? t('workConnecting') : t('workConnect')}
      </button>
    </div>
  )
}

/** 已连接但还没选会话：工作模式的欢迎页 */
const WorkWelcome = () => {
  const t = useTranslate()
  const status = useWorkStore((state) => state.status)
  const sessions = useWorkStore((state) => state.sessions)
  const startNewSession = useWorkStore((state) => state.startNewSession)
  const [draft, setDraft] = useState('')
  const ready = status === 'connected' && sessions.length > 0

  const submit = () => {
    const text = draft.trim()
    if (!text || !ready) {
      return
    }
    setDraft('')
    void startNewSession(text)
  }

  return (
    <div className={styles.panel}>
      <div className={styles.welcome}>
        <div className={styles.welcomeText}>{t('workWelcome')}</div>
      </div>
      <div className={styles.composer}>
        <textarea
          rows={1}
          placeholder={ready ? t('workMessagePlaceholder') : t('workConnectHint')}
          value={draft}
          disabled={!ready}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button
          type="button"
          className={styles.sendButton}
          disabled={!ready || !draft.trim()}
          aria-label={t('send')}
          onClick={submit}
        >
          ↑
        </button>
      </div>
    </div>
  )
}

/** 已连接：单个会话的聊天流，渲染与主对话一致的 Markdown 和工具卡片 */
const SessionChat = () => {
  const t = useTranslate()
  const messages = useWorkStore((state) => state.messages)
  const streaming = useWorkStore((state) => state.streaming)
  const hasMore = useWorkStore((state) => state.hasMore)
  const historyLoading = useWorkStore((state) => state.historyLoading)
  const loadOlder = useWorkStore((state) => state.loadOlder)
  const send = useWorkStore((state) => state.send)
  const cancel = useWorkStore((state) => state.cancel)
  const closeSession = useWorkStore((state) => state.closeSession)
  const sessions = useWorkStore((state) => state.sessions)
  const activeSessionId = useWorkStore((state) => state.activeSessionId)
  const title =
    sessions.find((session) => session.sessionId === activeSessionId)?.title || t('sessionModeWork')
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  /** 是否跟随新消息贴底；用户上滑后停止跟随 */
  const stickRef = useRef(true)
  /** 顶部加载更早内容后，恢复原来的滚动位置 */
  const restoreRef = useRef<{ height: number; top: number } | null>(null)
  const firstLoadRef = useRef(true)

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) {
      return
    }
    const restore = restoreRef.current
    if (restore) {
      restoreRef.current = null
      list.scrollTop = list.scrollHeight - restore.height + restore.top
      return
    }
    if (stickRef.current) {
      list.scrollTop = list.scrollHeight
    }
    if (messages.length > 0) {
      firstLoadRef.current = false
    }
  }, [messages, streaming])

  const onScroll = () => {
    const list = listRef.current
    if (!list) {
      return
    }
    stickRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80
    if (list.scrollTop < 40 && hasMore && !historyLoading) {
      restoreRef.current = { height: list.scrollHeight, top: list.scrollTop }
      void loadOlder()
    }
  }

  const submit = () => {
    const text = draft.trim()
    if (!text) {
      return
    }
    setDraft('')
    stickRef.current = true
    void send(text)
  }

  return (
    <div className={styles.panel}>
      <div className={styles.bar}>
        <span className={styles.chatHead}>
          <button type="button" className={styles.linkButton} onClick={closeSession}>
            ←
          </button>
          <span className={styles.chatTitle}>{title}</span>
        </span>
        {streaming ? (
          <button type="button" className={styles.linkButton} onClick={() => void cancel()}>
            {t('workStop')}
          </button>
        ) : null}
      </div>
      <div className={styles.chat} ref={listRef} onScroll={onScroll}>
        {historyLoading && messages.length === 0 ? (
          <div className={styles.hint}>{t('workHistoryLoading')}</div>
        ) : null}
        {messages.map((message) => {
          if (message.role === 'tool') {
            return (
              <details key={message.id} className={styles.tool}>
                <summary className={styles.toolSummary}>
                  <span className={styles.toolName}>{message.name ?? 'tool'}</span>
                </summary>
                {message.input ? <pre className={styles.toolBody}>{message.input}</pre> : null}
                {message.output ? <pre className={styles.toolBody}>{message.output}</pre> : null}
              </details>
            )
          }
          if (message.role === 'user') {
            return (
              <div key={message.id} className={`${styles.message} ${styles.user}`}>
                {message.text}
              </div>
            )
          }
          return (
            <div key={message.id} className={styles.assistantBlock}>
              {message.thinking ? (
                <details className={styles.thinkingBox}>
                  <summary className={styles.thinkingSummary}>{t('workThinking')}</summary>
                  <div className={styles.thinkingText}>{message.thinking}</div>
                </details>
              ) : null}
              {message.text ? (
                <Markdown
                  content={message.text}
                  loading={false}
                  cacheKey={message.id}
                  disableLink={false}
                />
              ) : null}
            </div>
          )
        })}
        {streaming ? <div className={styles.hint}>{t('workReplying')}</div> : null}
      </div>
      <div className={styles.composer}>
        <textarea
          rows={1}
          placeholder={t('workMessagePlaceholder')}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button
          type="button"
          className={styles.sendButton}
          disabled={!draft.trim()}
          aria-label={t('send')}
          onClick={submit}
        >
          ↑
        </button>
      </div>
    </div>
  )
}

export const WorkView = () => {
  const status = useWorkStore((state) => state.status)
  const activeSessionId = useWorkStore((state) => state.activeSessionId)
  const restore = useWorkStore((state) => state.restore)

  useEffect(() => {
    void restore()
  }, [restore])

  if (status !== 'connected') {
    return <ConnectForm />
  }
  return activeSessionId ? <SessionChat /> : <WorkWelcome />
}
