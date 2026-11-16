import { create } from 'zustand'
import type { LinkedMessage, TranslationMessage } from '../i18n/index.js'
import type { FilePurpose } from './api/types.js'
import { ACCEPT_FILE_EXTS } from './uploadExts.js'

/** 允许上传的扩展名，按扩展名白名单过滤，清单见 uploadExts.ts */
export const ACCEPTED_EXTS = ACCEPT_FILE_EXTS
/** 选择文件对话框的过滤条件 */
export const ACCEPT = ACCEPTED_EXTS.map((ext) => `.${ext}`).join(',')
/** 单文件大小上限 */
export const MAX_SIZE_MB = 64
/** 纯文本、代码、表格、电子书类文件的上限更小 */
export const MAX_USER_DATA_SIZE_MB = 32
export const MAX_COUNT = 50

/** 文件扩展名（小写，不含点）；没有扩展名时为空 */
export const getFileExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isAcceptedExt = (name: string) => ACCEPTED_EXTS.includes(getFileExt(name))

/** 需要版面解析的文档；其余非图片文件按普通文本处理 */
const LAYOUT_RECOGNITION_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])

export const getUploadPurpose = (name: string, isImage: boolean): FilePurpose | null => {
  if (isImage) {
    return null
  }
  return LAYOUT_RECOGNITION_EXTS.has(getFileExt(name)) ? 'rich_layout_recognition' : 'user_data'
}

/** 文件允许的最大体积（MB），按文件类别区分 */
const getMaxSizeMB = (file: File) =>
  getUploadPurpose(file.name, isImage(resolveMimeType(file))) === 'user_data'
    ? MAX_USER_DATA_SIZE_MB
    : MAX_SIZE_MB

/** 添加前校验：格式 → 大小 → 数量，任一不满足即整批不添加 */
export const validateFiles = (files: File[], currentCount: number): TranslationMessage | null => {
  if (files.some((file) => !isAcceptedExt(file.name))) {
    return { key: 'uploadUnsupportedFormat' }
  }
  const oversized = files.find((file) => file.size > getMaxSizeMB(file) * 1024 * 1024)
  if (oversized) {
    return { key: 'uploadMaxMBSize', params: { size: getMaxSizeMB(oversized) } }
  }
  if (currentCount + files.length > MAX_COUNT) {
    return { key: 'uploadMaxFiles', params: { count: MAX_COUNT } }
  }
  return null
}

type NoticeListener = (notice: LinkedMessage) => void

/** 附件已完全本地化，不再有上传配额提示；保留订阅接口以免改动调用方 */
export const onUploadNotice = (listener: NoticeListener) => {
  void listener
  return () => {}
}

/**
 * 附件任务按本地 id 登记。原来的「上传中 / 成功 / 失败」三态保留给界面复用，
 * 但不再发出任何网络请求：选中即为就绪，done 里的 serverId 就是本地附件 id。
 * 请求侧只用本地 Blob（图片内联或由 ocr_file 工具读取）。
 */
export type UploadTask =
  | { status: 'uploading' }
  | { status: 'done'; serverId: string }
  | { status: 'error'; error: TranslationMessage; retryable: boolean }

type UploadState = { tasks: Record<string, UploadTask> }

export const useUploads = create<UploadState>(() => ({ tasks: {} }))

const setTask = (id: string, task: UploadTask | null) =>
  useUploads.setState((state) => ({
    tasks: task
      ? { ...state.tasks, [id]: task }
      : Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id)),
  }))

/** 本地就绪，立即返回附件 id；其余参数只为兼容既有调用点保留 */
export const uploadAttachment = (
  apiKey: string,
  id: string,
  blob: Blob,
  name: string,
  isImage: boolean
): Promise<string> => {
  void apiKey
  void blob
  void name
  void isImage
  setTask(id, { status: 'done', serverId: id })
  return Promise.resolve(id)
}

export const cancelUpload = (id: string) => {
  setTask(id, null)
}

/** 各扩展名对应的 MIME：部分系统（如 Windows）给不出 file.type，按扩展名补齐 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** 取文件的 MIME：优先用浏览器给出的类型，缺失时按扩展名推断 */
export const resolveMimeType = (file: File) => file.type || MIME_BY_EXT[getFileExt(file.name)] || ''

export const isImage = (mimeType: string) => mimeType.startsWith('image/')

/** 文件扩展名（大写），用于卡片元信息 */
export const getExtension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
}

export const formatSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
