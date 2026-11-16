/**
 * 提供给模型的"标准工具"定义与执行器。
 *
 * DeepSeek 的原生路径里，搜索/抓取由服务端在同一个响应内完成（server_tool_use），
 * 客户端不经手。换成其他提供商后没有这套服务端工具，于是把它们声明成普通
 * function，由客户端调用 DeepSeek 工具 API 执行——能力等价，只是多了几次往返。
 */
import { fetchPage, ocrFile, searchWeb, type OcrPurpose, type SearchResult } from './deepseekTools.js'
import type { JsonSchema, ToolSchema } from '../providers/types.js'

export type ToolName = 'web_search' | 'read_url' | 'ocr_file'

/** 联网开关打开时才声明 */
export const WEB_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'web_search',
    description:
      '搜索互联网网页。返回若干条结果，每条含标题、URL 和摘要。需要最新信息、事实核查或用户明确要求联网时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索词，1～128 个字符。支持 site:、-site:、-词、lang:、after:、before: 等语法。',
        },
        count: {
          type: 'integer',
          description: '返回条数，1～50，默认 10。',
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
    description:
      '抓取单个网页并返回 Markdown 正文。需要阅读搜索结果里的具体页面、或用户给出链接时使用。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网页地址，必须带 host 的 http/https URL。' },
      },
      required: ['url'],
      additionalProperties: false,
    } satisfies JsonSchema,
  },
]

/** 本轮有附件时才声明，由模型自行决定何时读取附件内容 */
export const OCR_TOOL_SCHEMA: ToolSchema = {
  name: 'ocr_file',
  description:
    '读取本轮消息附带的 PDF、Word、PowerPoint 或图片，返回逐页识别出的文字。需要引用文档内容、或用户问到附件里的信息时使用。file_id 取自用户消息里的附件清单。',
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: '用户消息【本轮附件】清单中给出的 file_id' },
      purpose: {
        type: 'string',
        enum: ['text_recognition', 'rich_layout_recognition'],
        description: '默认 text_recognition；需要保留版面坐标时用 rich_layout_recognition',
      },
    },
    required: ['file_id'],
    additionalProperties: false,
  } satisfies JsonSchema,
}

/** 全量工具集合；实际请求按开关与本轮附件裁剪 */
export const TOOL_SCHEMAS: ToolSchema[] = [...WEB_TOOL_SCHEMAS, OCR_TOOL_SCHEMA]

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
  /** 本地 id → 文件名，仅用于 OCR 的 multipart 字段名 */
  fileNames?: Record<string, string>
  signal?: AbortSignal
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
      throw new Error('web_search 需要非空的 query')
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
      throw new Error('read_url 需要 http/https 开头的 url')
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
      throw new Error('ocr_file 需要非空的 file_id')
    }
    const blob = await ctx.loadFile(id)
    if (!blob) {
      throw new Error(`找不到附件 ${id} 的本地原件，可能已被清理`)
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
    return {
      content: `附件识别结果（共 ${result.page_count} 页）：\n\n${trim(text, 20000)}`,
      sources: [],
    }
  }
  throw new Error(`未知工具：${name}`)
}
