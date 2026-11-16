/**
 * 提供给模型的标准工具定义与执行器。
 *
 * 搜索、抓取与 OCR 都是普通 function tool：模型发起调用，客户端 ReAct 循环
 * 调 DeepSeek 工具 API 执行，结果回填后再请求一次。
 * 文案对齐 DSH 的 web 工具：描述保持简短，外部内容的不可信提示放在系统提示里。
 */
import {
  fetchPage,
  ocrFile,
  searchWeb,
  ToolApiError,
  type OcrPurpose,
  type SearchResult,
} from './deepseekTools.js'
import type { JsonSchema, ToolSchema } from '../providers/types.js'

export type ToolName = 'web_search' | 'read_url' | 'ocr_file' | 'read'

/** 联网开关打开时才声明 */
export const WEB_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'web_search',
    description: 'Search the web for current information. Returns a list of source URLs with titles and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The search query, 1–128 characters. Supports site:, -site:, -term, lang:, after: and before: filters.',
        },
        count: {
          type: 'integer',
          description: 'Number of results to return, 1–50. Defaults to 10.',
          minimum: 1,
          maximum: 50,
        },
      },
      required: ['query'],
      additionalProperties: false,
    } satisfies JsonSchema,
  },
  {
    name: 'read_url',
    description: 'Fetch the content of a specific HTTP(S) URL and return it decoded to text.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The HTTP(S) URL to fetch.' },
      },
      required: ['url'],
      additionalProperties: false,
    } satisfies JsonSchema,
  },
]

/** OCR 一次最多回给模型的字符数；超出部分由 read 分段续读 */
export const OCR_PREVIEW_CHARS = 50_000
/** read 单次默认与上限，对齐 DSH 的 read 窗口做法 */
export const READ_DEFAULT_CHARS = 50_000
export const READ_MAX_CHARS = 50_000

/** 本轮有附件时才声明：解析结果落到应用内部，模型按 file_id 读取 */
export const OCR_TOOL_SCHEMA: ToolSchema = {
  name: 'ocr_file',
  description:
    'Parse an attached document or image with OCR and save the recognized text as an in-app document. Returns the beginning of the text; continue with the read tool and the same file_id when it is truncated.',
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'The file_id listed under attachments in the user message.' },
      purpose: {
        type: 'string',
        enum: ['text_recognition', 'rich_layout_recognition'],
        description:
          'Defaults to text_recognition; use rich_layout_recognition to keep layout and figures.',
      },
    },
    required: ['file_id'],
    additionalProperties: false,
  } satisfies JsonSchema,
}

/** 只在有解析结果需要续读时才有意义；与 ocr_file 一起声明 */
export const READ_TOOL_SCHEMA: ToolSchema = {
  name: 'read',
  description:
    'Read the text saved for an attachment. Returns a bounded window starting at a 1-based character offset; call it again with the returned offset to continue a long document.',
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'The attachment file_id from the user message.' },
      offset: {
        type: 'integer',
        description: '1-based character offset to start from. Defaults to 1.',
        minimum: 1,
      },
      limit: {
        type: 'integer',
        description: `Maximum characters to return. Defaults to ${READ_DEFAULT_CHARS}.`,
        minimum: 1,
        maximum: READ_MAX_CHARS,
      },
    },
    required: ['file_id'],
    additionalProperties: false,
  } satisfies JsonSchema,
}

/** 全量工具集合；实际请求按开关与本轮附件裁剪 */
export const TOOL_SCHEMAS: ToolSchema[] = [
  ...WEB_TOOL_SCHEMAS,
  OCR_TOOL_SCHEMA,
  READ_TOOL_SCHEMA,
]

/** 一份落盘的 OCR 结果 */
export type ParsedAttachment = {
  id: string
  name: string
  text: string
  pages: number
  purpose: OcrPurpose
  createdAt: number
}

/** 工具执行产生的一条来源，供 UI 展示引用 */
export type ToolSource = {
  title: string
  url: string
  snippet: string
  siteName?: string | null
  siteIcon?: string | null
}

export type ToolRunResult = {
  /** 回填给模型的文本（会进入上下文，按需裁剪） */
  content: string
  /** 供 UI 渲染的来源 */
  sources: ToolSource[]
}

/** 工具失败分类：未知工具 / 参数错 / 404 / 服务不可用 */
export type ToolFailureCode = 'unknown_tool' | 'invalid_arguments' | 'not_found' | 'unavailable'

export class ToolFailure extends Error {
  readonly code: ToolFailureCode
  readonly tool: string
  readonly status: number

  constructor(tool: string, code: ToolFailureCode, message: string, status = 0) {
    super(message)
    this.name = 'ToolFailure'
    this.tool = tool
    this.code = code
    this.status = status
  }
}

/** 把执行期异常归一成可展示的失败类别 */
export const classifyToolFailure = (tool: string, error: unknown): ToolFailure => {
  if (error instanceof ToolFailure) {
    return error
  }
  if (error instanceof ToolApiError) {
    const code: ToolFailureCode =
      error.status === 404
        ? 'not_found'
        : error.status === 0 || error.status >= 500
          ? 'unavailable'
          : 'invalid_arguments'
    return new ToolFailure(tool, code, error.message, error.status)
  }
  return new ToolFailure(
    tool,
    'unavailable',
    error instanceof Error ? error.message : String(error)
  )
}

const trim = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`

const toSource = (result: SearchResult): ToolSource => ({
  title: result.title || result.url,
  url: result.url,
  snippet: result.snippet || result.summary || '',
  siteName: result.site_name,
  siteIcon: result.site_icon,
})

export type ToolContext = {
  apiKey: string
  /** 按附件本地 id 取回原件；tool call 只能传 JSON 文本，二进制从这里取 */
  loadFile: (id: string) => Promise<Blob | undefined>
  /** 保存 OCR 全文，供 read 与 UI 共用 */
  saveFileText?: (doc: ParsedAttachment) => Promise<void>
  /** 读取已保存的 OCR 全文 */
  loadFileText?: (id: string) => Promise<ParsedAttachment | undefined>
  /** 本地 id → 文件名，仅用于 OCR 的 multipart 字段名 */
  fileNames?: Record<string, string>
  signal?: AbortSignal
}

/** read 的 offset / limit 只接受正整数 */
const positiveInteger = (name: string, value: unknown): number | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.NaN
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new ToolFailure('read', 'invalid_arguments', `read 的 ${name} 必须是正整数`)
  }
  return parsed
}

/** 执行一次工具调用；未知工具或参数非法时抛错，由调用方决定如何回填 */
export const runTool = async (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolRunResult> => {
  if (name === 'web_search') {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) {
      throw new ToolFailure('web_search', 'invalid_arguments', 'web_search 需要非空的 query')
    }
    const count = typeof args.count === 'number' ? args.count : 10
    const results = await searchWeb({
      apiKey: ctx.apiKey,
      query,
      count: Math.min(50, Math.max(1, Math.trunc(count))),
      signal: ctx.signal,
    })
    if (results.length === 0) {
      return { content: `搜索「${query}」没有返回结果。`, sources: [] }
    }
    const lines = results.map(
      (result, index) =>
        `[${index + 1}] ${result.title}\n${result.url}\n${trim(result.summary || result.snippet, 800)}`
    )
    return {
      content: `搜索「${query}」的结果：\n\n${lines.join('\n\n')}`,
      sources: results.map(toSource),
    }
  }
  if (name === 'read_url') {
    const url = typeof args.url === 'string' ? args.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) {
      throw new ToolFailure('read_url', 'invalid_arguments', 'read_url 需要 http/https 开头的 url')
    }
    const page = await fetchPage(ctx.apiKey, url, ctx.signal)
    return {
      content: `网页「${page.title || url}」的正文：\n\n${trim(page.content, 20000)}`,
      sources: [{ title: page.title || url, url, snippet: trim(page.content, 160) }],
    }
  }
  if (name === 'ocr_file') {
    const id = typeof args.file_id === 'string' ? args.file_id.trim() : ''
    if (!id) {
      throw new ToolFailure('ocr_file', 'invalid_arguments', 'ocr_file 需要非空的 file_id')
    }
    const blob = await ctx.loadFile(id)
    if (!blob) {
      throw new ToolFailure(
        'ocr_file',
        'invalid_arguments',
        `找不到附件 ${id} 的本地原件，可能已被清理`
      )
    }
    const purpose: OcrPurpose =
      args.purpose === 'rich_layout_recognition' ? 'rich_layout_recognition' : 'text_recognition'
    const result = await ocrFile({
      apiKey: ctx.apiKey,
      file: blob,
      fileName: ctx.fileNames?.[id] ?? id,
      purpose,
      signal: ctx.signal,
    })
    const text = result.pages.map((page) => page.text).join('\n\n')
    const fileName = ctx.fileNames?.[id] ?? id
    // 全文落盘，模型只看到前一段；剩余部分由 read 按偏移续读
    await ctx.saveFileText?.({
      id,
      name: fileName,
      text,
      pages: result.page_count,
      purpose,
      createdAt: Date.now(),
    })
    const head = text.slice(0, OCR_PREVIEW_CHARS)
    const remain = text.length - head.length
    const lines = [`附件「${fileName}」识别完成：共 ${result.page_count} 页、${text.length} 字符。`]
    if (remain > 0) {
      lines.push(
        `以下是第 1–${head.length} 字符；剩余 ${remain} 字符，调用 read（file_id: ${id}，offset: ${head.length + 1}）继续读取。`
      )
    }
    return {
      content: `${lines.join('\n')}\n\n${head}`,
      sources: [],
    }
  }
  if (name === 'read') {
    const id = typeof args.file_id === 'string' ? args.file_id.trim() : ''
    if (!id) {
      throw new ToolFailure('read', 'invalid_arguments', 'read 需要非空的 file_id')
    }
    const doc = await ctx.loadFileText?.(id)
    if (!doc) {
      throw new ToolFailure(
        'read',
        'invalid_arguments',
        `附件 ${id} 还没有识别结果，先调用 ocr_file 解析`
      )
    }
    const total = doc.text.length
    const offset = positiveInteger('offset', args.offset) ?? 1
    if (total > 0 && offset > total) {
      throw new ToolFailure(
        'read',
        'invalid_arguments',
        `offset 超出范围：全文共 ${total} 字符`
      )
    }
    const limit = Math.min(positiveInteger('limit', args.limit) ?? READ_DEFAULT_CHARS, READ_MAX_CHARS)
    const slice = doc.text.slice(offset - 1, offset - 1 + limit)
    const end = offset - 1 + slice.length
    const header = `附件「${doc.name}」第 ${offset}–${end} 字符，共 ${total} 字符。`
    const footer = end < total ? `\n\n[已截断] 继续读取请调用 read，offset: ${end + 1}。` : ''
    return { content: `${header}\n\n${slice}${footer}`, sources: [] }
  }
  throw new ToolFailure(name, 'unknown_tool', `未知工具：${name}`)
}
