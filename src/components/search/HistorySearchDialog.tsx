import { useEffect, useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { searchConversations } from '../../services/chat/db.js'
import { selectSession } from '../../services/chat/store.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import { IconCloseOutline16, IconSearchOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { formatDate } from '../../utils/format.js'
import styles from './HistorySearchDialog.module.css'

type SearchHit = {
  sessionId: string
  title: string
  updatedAt: number
  count: number
  snippets: { text: string; offset: number }[]
}

/** 关键词高亮：与 Rust 侧一致，大小写不敏感的子串匹配 */
const highlight = (text: string, query: string): ReactNode[] => {
  if (!query) {
    return [text]
  }
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  const nodes: ReactNode[] = []
  let from = 0
  while (from <= text.length) {
    const index = lower.indexOf(needle, from)
    if (index === -1 || needle.length === 0) {
      nodes.push(text.slice(from))
      break
    }
    if (index > from) {
      nodes.push(text.slice(from, index))
    }
    nodes.push(<mark key={index}>{text.slice(index, index + needle.length)}</mark>)
    from = index + needle.length
  }
  return nodes
}

/**
 * 全对话内容搜索：标题与消息文本（含思考、工具查询词）都参与匹配。
 * 输入防抖后在 Rust 侧（SQLite）扫描；点击结果跳转到对应会话。
 */
export const HistorySearchDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [searched, setSearched] = useState(false)

  // 输入防抖；清空时回到未搜索状态
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setResults([])
      setSearched(false)
      return
    }
    const timer = setTimeout(() => {
      void searchConversations(trimmed)
        .then((hits) => {
          setResults(hits)
          setSearched(true)
        })
        .catch(() => setResults([]))
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  const open = (sessionId: string) => {
    selectSession(sessionId)
    closeMobileSider()
    onClose()
  }

  const trimmed = query.trim()
  return (
    <Modal
      closable
      onClose={onClose}
      overlayClassName={styles.overlay}
      className={styles.dialog}
      mainClassName={styles.results}
      title={
        <div className={styles.searchBar}>
          <span className={styles.searchIcon}>
            <IconSearchOutline16 />
          </span>
          <input
            className={styles.searchInput}
            value={query}
            placeholder={t('searchConversations')}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <IconButton
              className={styles.clear}
              tone="primary"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={() => setQuery('')}
            />
          ) : null}
        </div>
      }
    >
      {results.length > 0 ? (
        <div className={styles.list}>
          {results.map((hit) => (
            <button
              key={hit.sessionId}
              type="button"
              className={styles.hit}
              onClick={() => open(hit.sessionId)}
            >
              <span className={styles.hitHeader}>
                <span className={styles.hitTitle}>{hit.title || t('untitledChat')}</span>
                <span className={styles.hitDate}>{formatDate(hit.updatedAt)}</span>
              </span>
              <span className={styles.hitSnippets}>
                {hit.snippets.map((snippet, index) => (
                  <span key={index} className={styles.hitSnippet}>
                    {highlight(snippet.text, trimmed)}
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.empty}>{t(searched ? 'searchEmpty' : 'searchHint')}</div>
      )}
    </Modal>
  )
}
