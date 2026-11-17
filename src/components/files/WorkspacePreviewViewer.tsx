import { useTranslate } from '../../i18n/index.js'
import { Modal } from '../base/Modal.js'
import styles from './WorkspacePreviewViewer.module.css'

/** HTML / SVG 的渲染预览：沙箱 iframe 隔离脚本，避免影响应用页面 */
export const WorkspacePreviewViewer = ({
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
      title={`${name} · ${t('workspacePreviewTitle')}`}
      closable
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={onClose}
    >
      <iframe className={styles.frame} sandbox="" srcDoc={text} title={name} />
    </Modal>
  )
}
