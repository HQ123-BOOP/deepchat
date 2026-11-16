/**
 * Android 壳的媒体桥：读取相册最近照片、按需读取原图，以及用系统浏览器打开外链。
 * 网页版没有该对象，调用方按不可用处理。
 */
export type RecentPhoto = {
  id: string
  name: string
  thumb: string
}

type AndroidMediaBridge = {
  listRecentPhotos: (limit: number) => void
  readPhoto: (id: string) => void
  openExternal: (url: string) => void
}

const getBridge = () =>
  (window as unknown as { AndroidMedia?: AndroidMediaBridge }).AndroidMedia

export const hasNativeMedia = (): boolean => Boolean(getBridge())

type ListRequest = {
  resolve: (photos: RecentPhoto[]) => void
  timer: number
}

type ReadRequest = {
  id: string
  resolve: (url: string | null) => void
  timer: number
}

let listRequest: ListRequest | null = null
let readRequest: ReadRequest | null = null

const settleList = (photos: RecentPhoto[]) => {
  if (!listRequest) {
    return
  }
  window.clearTimeout(listRequest.timer)
  const { resolve } = listRequest
  listRequest = null
  resolve(photos)
}

const settleRead = (id: string, url: string | null) => {
  if (!readRequest || readRequest.id !== id) {
    return
  }
  window.clearTimeout(readRequest.timer)
  const { resolve } = readRequest
  readRequest = null
  resolve(url)
}

// Kotlin 通过 evaluateJavascript 调这两个全局函数回传结果
Object.assign(window, {
  __androidRecentPhotos: (json: string) => {
    try {
      const parsed = JSON.parse(json)
      settleList(Array.isArray(parsed) ? (parsed as RecentPhoto[]) : [])
    } catch {
      settleList([])
    }
  },
  __androidPhotoData: (id: string, dataUrl: string) => {
    settleRead(id, dataUrl || null)
  },
})

/** 读取最近照片；权限弹窗可能停留较久，超时后返回空列表 */
export const listRecentPhotos = (limit = 20): Promise<RecentPhoto[]> => {
  const bridge = getBridge()
  if (!bridge) {
    return Promise.resolve([])
  }
  settleList([])
  return new Promise((resolve) => {
    const request: ListRequest = { resolve, timer: 0 }
    request.timer = window.setTimeout(() => {
      if (listRequest === request) {
        listRequest = null
      }
      resolve([])
    }, 60_000)
    listRequest = request
    try {
      bridge.listRecentPhotos(limit)
    } catch {
      settleList([])
    }
  })
}

/** 读取一张照片的完整数据（已缩放到 2048px 内并转成 JPEG） */
export const readPhoto = (id: string): Promise<string | null> => {
  const bridge = getBridge()
  if (!bridge) {
    return Promise.resolve(null)
  }
  settleRead(id, null)
  return new Promise((resolve) => {
    const request: ReadRequest = { id, resolve, timer: 0 }
    request.timer = window.setTimeout(() => {
      if (readRequest === request) {
        readRequest = null
      }
      resolve(null)
    }, 30_000)
    readRequest = request
    try {
      bridge.readPhoto(id)
    } catch {
      settleRead(id, null)
    }
  })
}

/** 用系统浏览器打开外链，避免 WebView 跳转后丢失当前会话；返回是否已交给原生处理 */
export const openExternal = (url: string): boolean => {
  const bridge = getBridge()
  if (!bridge) {
    return false
  }
  try {
    bridge.openExternal(url)
    return true
  } catch {
    return false
  }
}

/** data URL 转成可直接加入草稿的图片文件 */
export const photoFile = async (photo: RecentPhoto): Promise<File | null> => {
  const dataUrl = await readPhoto(photo.id)
  if (!dataUrl) {
    return null
  }
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const name = /\.[a-z0-9]+$/i.test(photo.name) ? photo.name : `${photo.name}.jpg`
    return new File([blob], name, { type: blob.type || 'image/jpeg' })
  } catch {
    return null
  }
}
