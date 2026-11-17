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
import { editWorkspaceFile, readWorkspaceFile, writeWorkspaceFile } from '../workspace.js'
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

/** OCR 一次最多回给模型的字符数；超出部分由 read 按行续读 */
export const OCR_PREVIEW_CHARS = 20000
/** read 单次默认与上限的行数，对齐 harness 的 readLimit */
export const READ_LIMIT = 2000
/** 单行最多返回的字符数，超出追加说明 */
export const READ_MAX_LINE_LENGTH = 2000
/** 单次返回内容的 UTF-8 字节上限，超出停止收集并标注 */
export const READ_MAX_BYTES = 50 * 1024

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

/** 读取附件或工作区文件；两者都存在时才需要分页 */
export const READ_TOOL_SCHEMA: ToolSchema = {
  name: 'read',
  description:
    'Read an attachment or a workspace file as line-numbered text. Plain-text uploads and workspace files are read directly; for documents or images, call ocr_file first to save their text. Attached images are already visible to vision models.',
  parameters: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        description: 'The attachment file_id from the user message. Omit when reading a workspace file.',
      },
      file_path: {
        type: 'string',
        description: 'Workspace-relative path, e.g. "notes/report.md". Omit when reading an attachment.',
      },
      offset: {
        type: 'integer',
        description: '1-based first line to return. Defaults to 1.',
        minimum: 1,
      },
      limit: {
        type: 'integer',
        description: `Maximum number of lines to return. Defaults to ${READ_LIMIT}.`,
        minimum: 1,
        maximum: READ_LIMIT,
      },
    },
    additionalProperties: false,
  } satisfies JsonSchema,
}

/** 模型可用的文件工具：只写应用内工作区，不接触系统文件 */
export const WRITE_TOOL_SCHEMA: ToolSchema = {
  name: 'write',
  description: 'Create or fully replace a UTF-8 text file in the app workspace.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Workspace-relative path to write, e.g. "notes/report.md". Provide file_path before content.',
      },
      content: {
        type: 'string',
        description: 'Full UTF-8 text content to write. Use an empty string to create an empty file.',
      },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  } satisfies JsonSchema,
}

export const EDIT_TOOL_SCHEMA: ToolSchema = {
  name: 'edit',
  description: 'Edit an existing UTF-8 text file in the app workspace by replacing literal text.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Workspace-relative path to edit. Provide file_path before old_string and new_string.',
      },
      old_string: { type: 'string', description: 'Literal text to replace.' },
      new_string: {
        type: 'string',
        description: 'Literal replacement text. Use an empty string to delete the match.',
      },
      replace_all: {
        type: 'boolean',
        description:
          'Replace all matches. Defaults to false; when false, old_string must appear exactly once.',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  } satisfies JsonSchema,
}

/** 全量工具集合；实际请求按开关与本轮附件裁剪 */
export const TOOL_SCHEMAS: ToolSchema[] = [
  ...WEB_TOOL_SCHEMAS,
  OCR_TOOL_SCHEMA,
  READ_TOOL_SCHEMA,
  WRITE_TOOL_SCHEMA,
  EDIT_TOOL_SCHEMA,
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
  /** 回填给模型的文本；产生时按上限截断，回放与实时请求一致 */
  content: string
  /** 供 UI 渲染的来源 */
  sources: ToolSource[]
  /** 附件解析结果，供 UI 显示一行可点开的记录 */
  attachment?: AttachmentSummary
  /** write / edit 的产物，供 UI 显示文件卡片 */
  workspace?: { path: string; operation: 'created' | 'updated'; chars: number }
}

/** UI 展示解析结果所需的元数据，不含全文 */
export type AttachmentSummary = {
  id: string
  name: string
  pages: number
  chars: number
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

/**
 * 回给模型的单次工具输出上限。对齐 harness：工具在产生输出时就截断并附一句说明，
 * 落库的轨迹因此与实时请求完全一致，回放时无需再改内容。
 */
const TOOL_OUTPUT_MAX_CHARS = 20000
/** 对齐 harness 的 fetch 截断说明 */
const TRUNCATION_FOOTER = '\n\n(Content truncated. Fetch a more specific URL or section for the full text.)'

/** 前缀截断并附说明，说明本身计入上限 */
const capOutput = (text: string): string =>
  text.length <= TOOL_OUTPUT_MAX_CHARS
    ? text
    : `${text.slice(0, TOOL_OUTPUT_MAX_CHARS - TRUNCATION_FOOTER.length)}${TRUNCATION_FOOTER}`

/** 搜索结果按整条保留：放不下时丢弃后面的条目并说明，避免从条目中间截断 */
const formatSearchContent = (query: string, entries: string[]): string => {
  const header = `搜索「${query}」的结果：`
  const join = (items: string[]) => `${header}\n\n${items.join('\n\n')}`
  const kept: string[] = []
  for (const entry of entries) {
    if (join([...kept, entry]).length > TOOL_OUTPUT_MAX_CHARS) {
      break
    }
    kept.push(entry)
  }
  if (kept.length === entries.length) {
    return join(kept)
  }
  const notice = `(Showing the first ${kept.length} sources. Refine the query for more.)`
  while (kept.length > 0 && join([...kept, notice]).length > TOOL_OUTPUT_MAX_CHARS) {
    kept.pop()
  }
  return join([...kept, notice])
}

const trim = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`

/** 可直接按文本读取的附件：MIME 为文本类，或扩展名在白名单里 */
const TEXT_MIME =
  /^text\/|^application\/(json|xml|x-ndjson|ndjson|javascript|x-yaml|yaml|toml|sql|x-sh)\b/i
const TEXT_EXT =
  /\.(txt|md|markdown|mdx|json|jsonl|ndjson|csv|tsv|log|yaml|yml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|c|h|cc|cpp|go|rs|sh|sql|ini|toml|conf)$/i

const isTextAttachment = (name: string, mime: string) =>
  TEXT_MIME.test(mime) || TEXT_EXT.test(name)

/** 纯文本附件直接解码；二进制或编码无法识别时返回 undefined，交由 ocr_file 处理 */
const loadPlainText = async (ctx: ToolContext, id: string): Promise<string | undefined> => {
  const blob = await ctx.loadFile(id)
  if (!blob) {
    return undefined
  }
  const name = ctx.fileNames?.[id] ?? id
  if (!isTextAttachment(name, blob.type)) {
    return undefined
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  // 含 NUL 的按二进制处理，避免把图片或压缩包解码成乱码
  if (bytes.includes(0)) {
    return undefined
  }
  for (const encoding of ['utf-8', 'gb18030']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes)
    } catch {
      // 编码不匹配时换下一种再试
    }
  }
  return undefined
}

const encoder = new TextEncoder()

/**
 * 对齐 harness 的 read 输出：编号行 + 续读/结束尾注，包在 path/type/content 信封里。
 * 按行分页，单行与总字节都有上限；即使命中字节上限也继续扫描全文，给出准确总行数。
 */
const formatReadWindow = (name: string, text: string, offset: number, limit: number): string => {
  const lines: string[] = []
  let totalLines = 0
  let outputBytes = 0
  let capped = false
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    let line = text.slice(start, end)
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    totalLines += 1
    if (!capped && totalLines >= offset && lines.length < limit) {
      const shown =
        line.length > READ_MAX_LINE_LENGTH
          ? `${line.slice(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
          : line
      const bytes = encoder.encode(shown).length + (lines.length > 0 ? 1 : 0)
      if (outputBytes + bytes > READ_MAX_BYTES) {
        capped = true
      } else {
        outputBytes += bytes
        lines.push(`${totalLines}: ${shown}`)
      }
    }
    if (newline === -1) {
      break
    }
    start = newline + 1
  }

  if (!capped && offset > totalLines && !(totalLines === 0 && offset === 1)) {
    throw new ToolFailure(
      'read',
      'invalid_arguments',
      `offset ${offset} is out of range for "${name}" (${totalLines} lines)`
    )
  }

  const endLine = lines.length > 0 ? offset + lines.length - 1 : offset - 1
  const footer = capped
    ? `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
    : endLine < totalLines
      ? `(Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.)`
      : `(End of file - total ${totalLines} lines)`
  const body = lines.length > 0 ? `${lines.join('\n')}\n\n${footer}` : footer
  return `<path>${name}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
}

const toSource = (result: SearchResult): ToolSource => ({
  title: result.title || result.url,
  url: result.url,
  snippet: result.snippet || result.summary || '',
  siteName: result.site_name,
  siteIcon: result.site_icon,
})

export type ToolContext = {
  apiKey: string
  /** 会话 id：write / edit 的工作区按会话隔离 */
  sessionId: string
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
    throw new ToolFailure('read', 'invalid_arguments', `${name} must be a positive integer`)
  }
  return parsed
}

/** Tauri 命令以字符串拒绝；按内容区分「文件不存在」与其他参数错误 */
const toWorkspaceFailure = (tool: string, error: unknown): ToolFailure => {
  const message =
    typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)
  return new ToolFailure(tool, /file not found/i.test(message) ? 'not_found' : 'invalid_arguments', message)
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
      content: formatSearchContent(query, lines),
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
      content: capOutput(`网页「${page.title || url}」的正文：\n\n${page.content}`),
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
    const lines = [`Parsed "${fileName}": ${result.page_count} pages, ${text.length} characters.`]
    if (text.length > head.length) {
      // read 按行分页：用预览末尾所在行号续读，宁可重读当前行也不跳过内容
      const nextLine = head.split('\n').length
      lines.push(
        `Showing the first ${head.length} characters. Call read with file_id "${id}", offset ${nextLine}, to continue.`
      )
    }
    return {
      content: `${lines.join('\n')}\n\n${head}`,
      sources: [],
      attachment: { id, name: fileName, pages: result.page_count, chars: text.length },
    }
  }
  if (name === 'read') {
    const fileId = typeof args.file_id === 'string' ? args.file_id.trim() : ''
    const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
    if ((fileId === '') === (filePath === '')) {
      throw new ToolFailure(
        'read',
        'invalid_arguments',
        'provide exactly one of file_id or file_path'
      )
    }
    const offset = positiveInteger('offset', args.offset) ?? 1
    const limit = positiveInteger('limit', args.limit) ?? READ_LIMIT
    if (limit > READ_LIMIT) {
      throw new ToolFailure(
        'read',
        'invalid_arguments',
        `limit must be less than or equal to ${READ_LIMIT}`
      )
    }
    // 工作区文件直接按行读取，附件则先取 OCR 结果、再退回纯文本原件
    if (filePath) {
      const text = await readWorkspaceFile(ctx.sessionId, filePath)
      if (text === null) {
        throw new ToolFailure('read', 'not_found', `file not found: ${filePath}`)
      }
      return { content: formatReadWindow(filePath, text, offset, limit), sources: [] }
    }
    const doc = await ctx.loadFileText?.(fileId)
    const fileName = doc?.name ?? ctx.fileNames?.[fileId] ?? fileId
    const text = doc?.text ?? (await loadPlainText(ctx, fileId))
    if (text === undefined) {
      throw new ToolFailure(
        'read',
        'invalid_arguments',
        `attachment "${fileName}" is not plain text; call ocr_file with file_id "${fileId}" first`
      )
    }
    return { content: formatReadWindow(fileName, text, offset, limit), sources: [] }
  }
  if (name === 'write' || name === 'edit') {
    const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
    if (!filePath) {
      throw new ToolFailure(name, 'invalid_arguments', 'file_path must be a non-empty string')
    }
    try {
      if (name === 'write') {
        const content = typeof args.content === 'string' ? args.content : ''
        const operation = await writeWorkspaceFile(ctx.sessionId, filePath, content)
        return {
          content: `<path>${filePath}</path>\n<type>file</type>\n<content>\n${
            operation === 'create' ? 'Created' : 'Updated'
          } file\n</content>`,
          sources: [],
          workspace: {
            path: filePath,
            operation: operation === 'create' ? 'created' : 'updated',
            chars: content.length,
          },
        }
      }
      const oldString = typeof args.old_string === 'string' ? args.old_string : ''
      const newString = typeof args.new_string === 'string' ? args.new_string : ''
      const replaceAll = args.replace_all === true
      await editWorkspaceFile(ctx.sessionId, filePath, oldString, newString, replaceAll)
      const saved = (await readWorkspaceFile(ctx.sessionId, filePath)) ?? ''
      return {
        content: replaceAll
          ? `The file ${filePath} has been updated. All occurrences were successfully replaced.`
          : `The file ${filePath} has been updated successfully.`,
        sources: [],
        workspace: { path: filePath, operation: 'updated', chars: saved.length },
      }
    } catch (error) {
      throw toWorkspaceFailure(name, error)
    }
  }
  throw new ToolFailure(name, 'unknown_tool', `Unknown tool: ${name}`)
}
