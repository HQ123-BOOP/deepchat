import { useTranslate } from '../../i18n/index.js'
import { useState } from 'react'
import { IconDownloadOutline16, IconEllipsisOutline16, IconFileOutline20 } from '../base/icons.js'
import { Menu } from '../base/Menu.js'
import { readWorkspaceFile, saveWorkspaceFile } from '../../services/workspace.js'
import { showToast } from '../base/toastState.js'
import { WorkspaceFileViewer } from '../files/WorkspaceFileViewer.js'
import { WorkspacePreviewViewer } from '../files/WorkspacePreviewViewer.js'
import type { PresentedFile } from '../../services/chat/types.js'
import styles from './PresentedFiles.module.css'

/** 可以直接渲染预览的文件类型；其余文件点击查看源码 */
const PREVIEWABLE = new Set(['svg', 'html', 'htm'])

const filename = (path: string) => path.split('/').pop() || path

const extension = (path: string) => {
  const name = filename(path)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1).toUpperCase() : ''
}

const isPreviewable = (path: string) => PREVIEWABLE.has(extension(path).toLowerCase())

/** 模型声明的交付文件：HTML / SVG 点击直接预览，三个点里可查看源码 */
export const PresentedFiles = ({
  sessionId,
  files,
}: {
  sessionId: string
  files: PresentedFile[]
}) => {
  const t = useTranslate()
  const [viewer, setViewer] = useState<{
    name: string
    text: string
    source: boolean
  } | null>(null)
  if (files.length === 0) {
    return null
  }
  const open = async (file: PresentedFile, source: boolean) => {
    const text = await readWorkspaceFile(sessionId, file.path)
    if (text === null) {
      showToast({ key: 'workspaceMissing' })
      return
    }
    setViewer({ name: file.path, text, source })
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
              onClick={() => void open(file, !isPreviewable(file.path))}
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
            <div className={styles.actions}>
              {isPreviewable(file.path) ? (
                <Menu
                  options={[
                    {
                      key: 'source',
                      label: t('presentedShowSource'),
                      icon: <IconFileOutline20 />,
                      onSelect: () => void open(file, true),
                    },
                  ]}
                >
                  {({ toggle }) => (
                    <button
                      type="button"
                      className={styles.action}
                      title={t('presentedShowSource')}
                      aria-label={t('presentedShowSource')}
                      onClick={toggle}
                    >
                      <IconEllipsisOutline16 />
                    </button>
                  )}
                </Menu>
              ) : null}
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
          </div>
        ))}
      </div>
      {viewer ? (
        viewer.source ? (
          <WorkspaceFileViewer
            name={viewer.name}
            text={viewer.text}
            onClose={() => setViewer(null)}
          />
        ) : (
          <WorkspacePreviewViewer
            name={viewer.name}
            text={viewer.text}
            onClose={() => setViewer(null)}
          />
        )
      ) : null}
    </>
  )
}
