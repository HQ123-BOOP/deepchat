import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { listRecentPhotos, photoFile, type RecentPhoto } from '../../services/nativeMedia.js'
import {
  IconCameraOutline20,
  IconCheckOutline16,
  IconFileOutline20,
  IconGalleryOutline20,
} from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import styles from './AttachmentSheet.module.css'

/** 移动端附件面板：最近照片网格 + 拍照 / 相册 / 文件三个入口，展开时向上推 */
export const AttachmentSheet = ({
  open,
  onCamera,
  onGallery,
  onFiles,
  onPickPhoto,
}: {
  open: boolean
  onCamera: () => void
  onGallery: () => void
  onFiles: () => void
  onPickPhoto: (file: File) => void
}) => {
  const t = useTranslate()
  const [photos, setPhotos] = useState<RecentPhoto[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const loaded = useRef(false)

  useEffect(() => {
    if (!open || loaded.current) {
      return
    }
    loaded.current = true
    setLoading(true)
    let cancelled = false
    void listRecentPhotos(20).then((items) => {
      if (!cancelled) {
        setPhotos(items)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const choose = async (photo: RecentPhoto) => {
    if (busy || selected.has(photo.id)) {
      return
    }
    setBusy(photo.id)
    const file = await photoFile(photo)
    setBusy(null)
    if (!file) {
      showToast({ key: 'attachmentPhotoFailed', type: 'error' })
      return
    }
    // 选中后不收起面板，方便继续多选；已选的显示勾选、不再重复添加
    setSelected((prev) => new Set(prev).add(photo.id))
    onPickPhoto(file)
  }

  // 每次收起后清空选中态，下次打开可重新挑选
  useEffect(() => {
    if (!open) {
      setSelected(new Set())
    }
  }, [open])

  return (
    <div
      data-attachment-sheet=""
      className={`${styles.sheet}${open ? ` ${styles.sheetOpen}` : ''}`}
      aria-hidden={!open}
    >
      <div className={styles.sheetInner}>
        <div className={styles.recentRow}>
          {loading
            ? Array.from({ length: 8 }, (_, index) => (
                <span key={index} className={styles.skeleton} />
              ))
            : null}
          {!loading && photos.length === 0 ? (
            <div className={styles.empty}>{t('attachmentNoPhotos')}</div>
          ) : null}
          {photos.map((photo) => (
            <button
              key={photo.id}
              type="button"
              className={`${styles.photo}${selected.has(photo.id) ? ` ${styles.photoSelected}` : ''}`}
              aria-label={photo.name}
              aria-pressed={selected.has(photo.id)}
              disabled={busy !== null}
              onClick={() => void choose(photo)}
            >
              <img src={photo.thumb} alt="" loading="lazy" />
              {selected.has(photo.id) ? (
                <span className={styles.photoCheck}>
                  <IconCheckOutline16 />
                </span>
              ) : null}
              {busy === photo.id ? <span className={styles.photoBusy} /> : null}
            </button>
          ))}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.action} onClick={onCamera}>
            <IconCameraOutline20 />
            <span>{t('attachmentCamera')}</span>
          </button>
          <button type="button" className={styles.action} onClick={onGallery}>
            <IconGalleryOutline20 />
            <span>{t('attachmentGallery')}</span>
          </button>
          <button type="button" className={styles.action} onClick={onFiles}>
            <IconFileOutline20 />
            <span>{t('attachmentFiles')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
