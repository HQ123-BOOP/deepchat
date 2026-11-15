/**
 * 提供给模型的"标准工具"定义与执行器。
 *
 * DeepSeek 的原生路径里，搜索/抓取由服务端在同一个响应内完成（server_tool_use），
 * 客户端不经手。换成其他提供商后没有这套服务端工具，于是把它们声明成普通
 * function，由客户端调用 DeepSeek 工具 API 执行——能力等价，只是多了几次往返。
 */
import { fetchPage, searchWeb, type SearchResult } from './deepseekTools.js'
import type { JsonSchema, ToolSchema } from '../providers/types.js'

export type ToolName = 'web_search' | 'read_url'

export const TOOL_SCHEMAS: ToolSchema[] = [
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
  throw new Error(`未知工具：${name}`)
}
