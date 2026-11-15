import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useWorkStore } from '../../services/remote/store.js'
import styles from './WorkView.module.css'

const shortId = (id: string) => (id.length > 18 ? `${id.slice(0, 18)}…` : id)

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

/** 已连接：会话列表，按工作目录分组 */
const SessionList = () => {
  const t = useTranslate()
  const sessions = useWorkStore((state) => state.sessions)
  const host = useWorkStore((state) => state.host)
  const port = useWorkStore((state) => state.port)
  const openSession = useWorkStore((state) => state.openSession)
  const refresh = useWorkStore((state) => state.refresh)
  const disconnect = useWorkStore((state) => state.disconnect)

  const groups = new Map<string, typeof sessions>()
  for (const session of sessions) {
    const list = groups.get(session.cwd) ?? []
    list.push(session)
    groups.set(session.cwd, list)
  }

  return (
    <div className={styles.panel}>
      <div className={styles.bar}>
        <span>
          {host}:{port} · {sessions.length}
        </span>
        <span>
          <button type="button" className={styles.linkButton} onClick={() => void refresh()}>
            {t('workRefresh')}
          </button>
          {' · '}
          <button type="button" className={styles.linkButton} onClick={() => void disconnect()}>
            {t('workDisconnect')}
          </button>
        </span>
      </div>
      <div className={styles.list}>
        {sessions.length === 0 ? <div className={styles.hint}>{t('workNoSessions')}</div> : null}
        {[...groups.entries()].map(([cwd, items]) => (
          <div key={cwd}>
            <div className={styles.group}>{cwd}</div>
            {items.map((session) => (
              <button
                key={session.sessionId}
                type="button"
                className={styles.item}
                onClick={() => openSession(session.sessionId)}
              >
                {shortId(session.sessionId)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 已连接：单个会话的聊天流 */
const SessionChat = () => {
  const t = useTranslate()
  const messages = useWorkStore((state) => state.messages)
  const streaming = useWorkStore((state) => state.streaming)
  const send = useWorkStore((state) => state.send)
  const cancel = useWorkStore((state) => state.cancel)
  const closeSession = useWorkStore((state) => state.closeSession)
  const [draft, setDraft] = useState('')

  return (
    <div className={styles.panel}>
      <div className={styles.bar}>
        <button type="button" className={styles.linkButton} onClick={closeSession}>
          ← {t('workBack')}
        </button>
        {streaming ? (
          <button type="button" className={styles.linkButton} onClick={() => void cancel()}>
            {t('workStop')}
          </button>
        ) : null}
      </div>
      <div className={styles.chat}>
        {messages.map((message) => (
          <div
            key={message.id}
            className={`${styles.message} ${message.role === 'user' ? styles.user : styles.assistant}`}
          >
            {message.note ? <div className={styles.note}>{message.note}</div> : null}
            {message.thinking ? <div className={styles.thinking}>{message.thinking}</div> : null}
            {message.text}
          </div>
        ))}
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
              const text = draft.trim()
              if (text) {
                setDraft('')
                void send(text)
              }
            }
          }}
        />
        <button
          type="button"
          className={styles.action}
          disabled={!draft.trim()}
          onClick={() => {
            const text = draft.trim()
            if (text) {
              setDraft('')
              void send(text)
            }
          }}
        >
          {t('send')}
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
  return activeSessionId ? <SessionChat /> : <SessionList />
}
