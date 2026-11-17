import { useTranslate } from '../../i18n/index.js'
import { Modal } from '../base/Modal.js'
import styles from './FileTextViewer.module.css'

/** 工作区文本预览：内容与模型写入的一致，只读、可滚动 */
export const WorkspaceFileViewer = ({
  name,
  text,
  onClose,
}: {
  name: string
  text: string
  onClose: () => void
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={`${name} · ${t('workspaceViewerTitle')}`}
      closable
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={onClose}
      footer={
        <span className={styles.meta}>
          {t('workspaceViewerMeta', { count: text.length.toLocaleString() })}
        </span>
      }
    >
      <pre className={styles.text}>{text}</pre>
    </Modal>
  )
}
