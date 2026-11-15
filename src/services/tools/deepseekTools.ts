/**
 * DeepSeek 工具 API 的封装：Search / Fetch / OCR。
 *
 * 这三个接口是普通的 JSON / multipart 请求，和对话模型无关——所以即使用户把
 * 对话模型换成别的提供商，联网搜索、网页抓取和 OCR 仍然可以走这里，代价是
 * 消耗 DeepSeek 账号的额度（Search/Fetch 5 元/千次，OCR 1.5 元/千页）。
 *
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/search
 *      https://api-docs.deepseek.com/zh-cn/guides/ocr
 */
import { API_ORIGIN } from '../api/client.js'

const TOOLS_BASE_URL = `${API_ORIGIN}/v1/tools`

/** 重试上限：只对 408 / 429 / 5xx 这类可恢复错误重试 */
const MAX_RETRIES = 2
const RETRY_BASE_DELAY = 800

export type SearchResult = {
  rerank_score: number
  title: string
  url: string
  /** 短摘要（100～200 字符），适合展示 */
  snippet: string
  /** 长摘要（600～800 字符），适合给模型阅读 */
  summary: string
  /** 网页正文；need_content 为 false 时为空串 */
  content: string
  site_name: string | null
  site_icon: string | null
  date: string | null
  /** 0～4，-1 表示未知 */
  authority: number
}

export type SearchResponse = { results: SearchResult[] }

export type FetchResponse = { title: string; content: string }

export type OcrPage = { index: number; text: string; finish_reason: 'stop' | 'length' }

export type OcrResponse = {
  id: string
  object: 'ocr.result'
  purpose: OcrPurpose
  page_count: number
  pages: OcrPage[]
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number }
}

export type OcrPurpose = 'text_recognition' | 'rich_layout_recognition'

/** 工具接口的错误；status 为 0 表示网络层失败 */
export class ToolApiError extends Error {
  readonly status: number
  readonly retryable: boolean

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ToolApiError'
    this.status = status
    this.retryable = status === 0 || status === 408 || status === 429 || status >= 500
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    if (body?.error?.message) {
      return body.error.message
    }
  } catch {
    // 非 JSON 响应体直接忽略
  }
  return `HTTP ${response.status}`
}

/** 发请求并按可恢复性重试；409/429/5xx 会退避重试，其余 4xx 立即失败 */
const requestTool = async (
  path: string,
  init: RequestInit,
  apiKey: string,
  signal?: AbortSignal
): Promise<Response> => {
  let attempt = 0
  for (;;) {
    let response: Response
    try {
      response = await fetch(`${TOOLS_BASE_URL}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, ...init.headers },
        signal,
      })
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
      if (attempt++ < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY * 2 ** (attempt - 1), signal)
        continue
      }
      throw new ToolApiError(error instanceof Error ? error.message : String(error), 0)
    }
    if (response.ok) {
      return response
    }
    const error = new ToolApiError(await errorMessage(response), response.status)
    if (!error.retryable || attempt++ >= MAX_RETRIES) {
      throw error
    }
    await sleep(RETRY_BASE_DELAY * 2 ** (attempt - 1), signal)
  }
}

export type SearchOptions = {
  apiKey: string
  query: string
  /** 1～50，默认 10 */
  count?: number
  /** 触发搜索的原始问题，帮助理解意图 */
  oriQuestion?: string
  /** 是否返回网页正文（计费不变，但响应体更大） */
  needContent?: boolean
  /** 用于返回本地化结果的 IP 地址 */
  localization?: string
  signal?: AbortSignal
}

/** POST /v1/tools/search */
export const searchWeb = async ({
  apiKey,
  query,
  count = 10,
  oriQuestion,
  needContent = false,
  localization,
  signal,
}: SearchOptions): Promise<SearchResult[]> => {
  const body = {
    query,
    count,
    ...(oriQuestion ? { ori_question: oriQuestion } : {}),
    ...(localization ? { localization } : {}),
    need_content: needContent,
  }
  const response = await requestTool(
    '/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    apiKey,
    signal
  )
  const data = (await response.json()) as SearchResponse
  return Array.isArray(data?.results) ? data.results : []
}

/** POST /v1/tools/fetch，返回 Markdown 正文 */
export const fetchPage = async (
  apiKey: string,
  url: string,
  signal?: AbortSignal
): Promise<FetchResponse> => {
  const response = await requestTool(
    '/fetch',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    },
    apiKey,
    signal
  )
  const data = (await response.json()) as FetchResponse
  return { title: data?.title ?? '', content: data?.content ?? '' }
}

export type OcrOptions = {
  apiKey: string
  file: Blob
  fileName: string
  purpose?: OcrPurpose
  signal?: AbortSignal
}

/**
 * POST /v1/tools/ocr。
 * 服务端在识别过程中持续发送换行符保活，完成后一次性返回 JSON；由于换行属于
 * JSON 前导空白，整个响应体可以直接按 JSON 解析。识别开始后状态码已是 200，
 * 失败会以 { error } 对象返回，需要额外检查。
 */
export const ocrFile = async ({
  apiKey,
  file,
  fileName,
  purpose = 'text_recognition',
  signal,
}: OcrOptions): Promise<OcrResponse> => {
  const form = new FormData()
  form.append('file', file, fileName)
  form.append('purpose', purpose)
  const response = await requestTool('/ocr', { method: 'POST', body: form }, apiKey, signal)
  const data = (await response.json()) as OcrResponse & { error?: { message?: string } }
  if (data?.error?.message) {
    throw new ToolApiError(data.error.message, response.status)
  }
  return data
}
