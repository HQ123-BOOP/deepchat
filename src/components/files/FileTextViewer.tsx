import { useTranslate } from '../../i18n/index.js'
import type { StoredFileText } from '../../services/chat/db.js'
import { Modal } from '../base/Modal.js'
import styles from './FileTextViewer.module.css'

/** 附件识别文本查看器：内容与模型读到的是同一份，只读、可滚动 */
export const FileTextViewer = ({ doc, onClose }: { doc: StoredFileText; onClose: () => void }) => {
  const t = useTranslate()
  return (
    <Modal
      title={`${doc.name} · ${t('fileTextViewerTitle')}`}
      closable
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={onClose}
      footer={
        <span className={styles.meta}>
          {t('fileTextViewerMeta', { pages: doc.pages, chars: doc.text.length })}
        </span>
      }
    >
      <pre className={styles.text}>{doc.text}</pre>
    </Modal>
  )
}
