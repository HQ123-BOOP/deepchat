import { useTranslate } from '../../i18n/index.js'
import { useState } from 'react'
import { IconDownloadOutline16 } from '../base/icons.js'
import { readWorkspaceFile, saveWorkspaceFile } from '../../services/workspace.js'
import { showToast } from '../base/toastState.js'
import { WorkspaceFileViewer } from '../files/WorkspaceFileViewer.js'
import type { PresentedFile } from '../../services/chat/types.js'
import styles from './PresentedFiles.module.css'

const filename = (path: string) => path.split('/').pop() || path

const extension = (path: string) => {
  const name = filename(path)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1).toUpperCase() : ''
}

/** 模型声明的交付文件：点击卡片预览，右侧按钮保存到设备 */
export const PresentedFiles = ({
  sessionId,
  files,
}: {
  sessionId: string
  files: PresentedFile[]
}) => {
  const t = useTranslate()
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null)
  if (files.length === 0) {
    return null
  }
  const open = async (file: PresentedFile) => {
    const text = await readWorkspaceFile(sessionId, file.path)
    if (text === null) {
      showToast({ key: 'workspaceMissing' })
      return
    }
    setPreview({ name: file.path, text })
  }
  const save = async (file: PresentedFile) => {
    if (await saveWorkspaceFile(sessionId, file.path)) {
      showToast({ key: 'workspaceSaved' })
    } else {
      showToast({ key: 'workspaceSaveFailed' })
    }
  }
  return (
    <>
      <div className={styles.root} data-single={files.length === 1 || undefined}>
        {files.map((file) => (
          <div className={styles.file} key={file.path}>
            <button
              type="button"
              className={styles.card}
              title={file.path}
              aria-label={file.path}
              onClick={() => void open(file)}
            />
            <span className={styles.icon} aria-hidden="true">
              {extension(file.path) || t('presentedFile')}
            </span>
            <div className={styles.body}>
              <span className={styles.name}>{filename(file.path)}</span>
              <span className={styles.description}>
                {file.description || extension(file.path) || t('presentedFile')}
              </span>
            </div>
            <button
              type="button"
              className={styles.action}
              title={t('workspaceSave')}
              aria-label={t('workspaceSave')}
              onClick={() => void save(file)}
            >
              <IconDownloadOutline16 />
            </button>
          </div>
        ))}
      </div>
      {preview ? (
        <WorkspaceFileViewer
          name={preview.name}
          text={preview.text}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  )
}
