/**
 * 非 DeepSeek 提供商的回答流：把 agentLoop 的事件翻译成与协议一致的回复块。
 *
 * 目的不是兼容服务端协议（这条路径根本不经过 DeepSeek 对话接口），而是复用
 * 现成的渲染：搜索/阅读步骤在 UI 里只认 server_tool_use + *_tool_result 这些
 * 块，因此本地工具调用也构造成同样的块，视图层不需要分支。
 */
import { runAgent } from './agentLoop.js'
import type {
  ChatProvider,
  ProviderMessage,
  ReasoningEffort,
  ToolSchema,
} from '../providers/types.js'
import type { AssistantMessage, ReplyBlock } from './types.js'
import type {
  ServerToolUseBlock,
  WebSearchResult,
  WebSearchToolResultBlock,
  WebFetchToolResultBlock,
} from '../api/types.js'

export type ProviderReplyOptions = {
  provider: ChatProvider
  model: string
  messages: ProviderMessage[]
  /** 本轮声明给模型的工具 */
  tools?: ToolSchema[]
  /** 执行 search/fetch/ocr 用的 DeepSeek Key */
  toolApiKey: string
  /** ocr_file 按附件 id 读取本地原件 */
  loadFile: (id: string) => Promise<Blob | undefined>
  /** 本地 id → 文件名 */
  fileNames?: Record<string, string>
  /** 初始回复（store 已插好空回复） */
  reply: AssistantMessage
  signal?: AbortSignal
  reasoningEffort?: ReasoningEffort
  /** 每次块内容变化时回调，由调用方按帧合并刷新 */
  onChange: (reply: AssistantMessage) => void
  /** 回复结束时回调最终状态 */
  onDone: (reply: AssistantMessage) => void
}

const toolUseId = (callId: string) => `toolu_local_${callId}`

const searchInput = (args: Record<string, unknown>): ServerToolUseBlock['input'] => {
  const query = typeof args.query === 'string' ? args.query : ''
  return { action: 'search', query, queries: query ? [query] : [] }
}

/** 运行一轮提供商回复；返回时 reply 已写入最终块与状态 */
export const runProviderReply = async (options: ProviderReplyOptions): Promise<AssistantMessage> => {
  let reply: AssistantMessage = options.reply
  const pushBlock = (block: ReplyBlock) => {
    reply = { ...reply, blocks: [...reply.blocks, block] }
  }
  /** 追加到末尾的同类块（正文或思考），没有则新建 */
  const appendToLast = (kind: 'text' | 'thinking', chunk: string) => {
    const last = reply.blocks.at(-1)
    if (last?.type === kind) {
      const next =
        kind === 'text'
          ? { ...last, text: (last as { text: string }).text + chunk }
          : { ...last, thinking: (last as { thinking: string }).thinking + chunk }
      reply = { ...reply, blocks: [...reply.blocks.slice(0, -1), next as ReplyBlock] }
    } else if (kind === 'text') {
      pushBlock({ type: 'text', text: chunk })
    } else {
      pushBlock({ type: 'thinking', thinking: chunk, startedAt: Date.now() })
    }
    options.onChange(reply)
  }

  /** 把签名挂到最近一个思考块；历史轮次据此原样回传推理 */
  const attachReasoningSignature = (signature: string) => {
    for (let index = reply.blocks.length - 1; index >= 0; index--) {
      const block = reply.blocks[index]
      if (block.type !== 'thinking') {
        continue
      }
      const next = { ...block, signature }
      reply = {
        ...reply,
        blocks: [...reply.blocks.slice(0, index), next, ...reply.blocks.slice(index + 1)],
      }
      options.onChange(reply)
      return
    }
  }

  try {
    for await (const event of runAgent({
      provider: options.provider,
      model: options.model,
      messages: options.messages,
      tools: options.tools,
      toolApiKey: options.toolApiKey,
      loadFile: options.loadFile,
      fileNames: options.fileNames,
      signal: options.signal,
      reasoningEffort: options.reasoningEffort,
    })) {
      if (event.type === 'text') {
        appendToLast('text', event.text)
      } else if (event.type === 'reasoning') {
        appendToLast('thinking', event.text)
      } else if (event.type === 'reasoning_signature') {
        attachReasoningSignature(event.signature)
      } else if (event.type === 'tool_start') {
        // OCR 结果只回填给模型，不生成联网步骤卡片
        if (event.call.name === 'ocr_file') {
          continue
        }
        let args: Record<string, unknown> = {}
        try {
          args = event.call.arguments ? (JSON.parse(event.call.arguments) as Record<string, unknown>) : {}
        } catch {
          args = {}
        }
        const isRead = event.call.name === 'read_url'
        pushBlock({
          type: 'server_tool_use',
          id: toolUseId(event.call.id),
          name: isRead ? 'deepseek_read_url' : 'deepseek_web_search',
          input: isRead
            ? { action: 'read_link', url: typeof args.url === 'string' ? args.url : '' }
            : searchInput(args),
          caller: { type: 'direct' },
          kind: isRead ? 'read_link' : 'search',
        } as ServerToolUseBlock)
        options.onChange(reply)
      } else if (event.type === 'tool_result') {
        if (event.call.name === 'ocr_file') {
          continue
        }
        if (event.call.name === 'read_url') {
          const source = event.sources[0]
          pushBlock({
            type: 'web_fetch_tool_result',
            tool_use_id: toolUseId(event.call.id),
            kind: 'read_link',
            content: {
              type: 'web_fetch_result',
              url: source?.url ?? '',
              content: {
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: '' },
                title: source?.title ?? null,
              },
            },
          } as WebFetchToolResultBlock)
        } else {
          const results: WebSearchResult[] = event.sources.map((source) => ({
            type: 'web_search_result',
            title: source.title,
            url: source.url,
            snippet: source.snippet,
            site_icon: source.siteIcon ?? null,
            site_name: source.siteName ?? null,
            encrypted_content: '',
            page_age: null,
          }))
          pushBlock({
            type: 'web_search_tool_result',
            tool_use_id: toolUseId(event.call.id),
            kind: 'search',
            content: event.ok ? results : [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }],
          } as WebSearchToolResultBlock)
        }
        options.onChange(reply)
      }
    }
    reply = { ...reply, status: 'done', stopReason: 'end_turn' }
  } catch (error) {
    reply = {
      ...reply,
      status: 'error',
      error: { kind: 'stream', message: error instanceof Error ? error.message : String(error) },
    }
  }
  options.onDone(reply)
  return reply
}
