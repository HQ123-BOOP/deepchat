/**
 * 非 DeepSeek 提供商的回答流：把 agentLoop 的事件翻译成与协议一致的回复块。
 *
 * 目的不是兼容服务端协议（这条路径根本不经过 DeepSeek 对话接口），而是复用
 * 现成的渲染：搜索/阅读步骤在 UI 里只认 server_tool_use + *_tool_result 这些
 * 块，因此本地工具调用也构造成同样的块，视图层不需要分支。
 */
import { runAgent } from './agentLoop.js'
import { settleReply } from './reply.js'
import type { ParsedAttachment } from '../tools/registry.js'
import type {
  ChatProvider,
  ProviderMessage,
  ReasoningEffort,
  ToolSchema,
} from '../providers/types.js'
import type { AssistantMessage, ReplyBlock, ToolTraceStep } from './types.js'
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
  /** 会话 id：write / edit 的工作区按会话隔离 */
  sessionId: string
  /** 执行 search/fetch/ocr 用的 DeepSeek Key */
  toolApiKey: string
  /** ocr_file 按附件 id 读取本地原件 */
  loadFile: (id: string) => Promise<Blob | undefined>
  /** 保存 OCR 全文，供 read 与 UI 共用 */
  saveFileText?: (doc: ParsedAttachment) => Promise<void>
  /** 读取已保存的 OCR 全文 */
  loadFileText?: (id: string) => Promise<ParsedAttachment | undefined>
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

/** 参数流式阶段的临时块 id；工具真正开始时替换成正式 id 的块 */
const prepareBlockId = (index: number) => `prepare-${index}`

/**
 * 从尚未闭合的工具参数 JSON 中取出某个字符串字段已到达的部分。
 * 只在准备阶段估算文件名与正文大小，不要求完整或合法的 JSON。
 */
const partialJsonString = (raw: string, key: string): string | undefined => {
  const marker = `"${key}"`
  const at = raw.indexOf(marker)
  if (at < 0) {
    return undefined
  }
  let cursor = at + marker.length
  while (cursor < raw.length && /\s/.test(raw[cursor])) {
    cursor += 1
  }
  if (raw[cursor] !== ':') {
    return undefined
  }
  cursor += 1
  while (cursor < raw.length && /\s/.test(raw[cursor])) {
    cursor += 1
  }
  if (raw[cursor] !== '"') {
    return undefined
  }
  cursor += 1
  let out = ''
  while (cursor < raw.length) {
    const char = raw[cursor]
    if (char === '"') {
      return out
    }
    if (char !== '\\') {
      out += char
      cursor += 1
      continue
    }
    const next = raw[cursor + 1]
    if (next === undefined) {
      return out
    }
    if (next === 'u') {
      const hex = raw.slice(cursor + 2, cursor + 6)
      if (hex.length < 4) {
        return out
      }
      out += String.fromCharCode(Number.parseInt(hex, 16))
      cursor += 6
      continue
    }
    out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next
    cursor += 2
  }
  return out
}

/**
 * 把 trace 消息压成步骤记录：正文和思考已经在 blocks 里，只保留字符数与签名，
 * 避免同一段内容在会话里存两份。
 */
const appendTrace = (
  trace: ToolTraceStep[] | undefined,
  message: ProviderMessage
): ToolTraceStep[] => {
  const steps = trace ? [...trace] : []
  if (message.role === 'assistant') {
    steps.push({
      toolCalls: message.toolCalls ?? [],
      textLength: message.content.length,
      reasoningLength: message.reasoning?.length ?? 0,
      ...(message.reasoningSignature ? { reasoningSignature: message.reasoningSignature } : {}),
      results: [],
    })
  } else if (message.role === 'tool') {
    const last = steps.at(-1)
    if (last) {
      steps[steps.length - 1] = {
        ...last,
        results: [
          ...last.results,
          { toolCallId: message.toolCallId, name: message.name, content: message.content },
        ],
      }
    }
  }
  return steps
}

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
  /** 参数流式阶段的写文件行：index → 工具名、原始 JSON、是否已经显示 */
  const preparing = new Map<number, { name: string; raw: string; pushed: boolean }>()
  /** 请求失败时清掉还没结算的临时行 */
  const clearPrepared = () => {
    reply = {
      ...reply,
      blocks: reply.blocks.filter(
        (block) => !('id' in block) || !block.id.startsWith('prepare-')
      ),
    }
  }
  /** 用同一 id 的新块替换旧块（解析中 → 完成）；没有旧块时追加 */
  const replaceBlock = (id: string, next: ReplyBlock) => {
    const index = reply.blocks.findIndex((block) => 'id' in block && block.id === id)
    reply = {
      ...reply,
      blocks:
        index >= 0
          ? [...reply.blocks.slice(0, index), next, ...reply.blocks.slice(index + 1)]
          : [...reply.blocks, next],
    }
  }
  /** 思考阶段结束时打点，避免用时一直增长；重复调用无副作用 */
  const closeThinking = (at: number) => {
    const last = reply.blocks.at(-1)
    if (
      last?.type !== 'thinking' ||
      last.startedAt === undefined ||
      last.endedAt !== undefined
    ) {
      return
    }
    reply = { ...reply, blocks: [...reply.blocks.slice(0, -1), { ...last, endedAt: at }] }
    options.onChange(reply)
  }
  /** 追加到末尾的同类块（正文或思考），没有则新建 */
  const appendToLast = (kind: 'text' | 'thinking', chunk: string) => {
    // 正文开始即思考结束
    if (kind === 'text') {
      closeThinking(Date.now())
    }
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
      // thinking_end 同时意味着该思考阶段结束，直接打上结束时间
      const next = {
        ...block,
        signature,
        ...(block.endedAt === undefined ? { endedAt: Date.now() } : {}),
      }
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
      sessionId: options.sessionId,
      toolApiKey: options.toolApiKey,
      loadFile: options.loadFile,
      saveFileText: options.saveFileText,
      loadFileText: options.loadFileText,
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
      } else if (event.type === 'tool_prepare') {
        // 只有写文件需要提前显示；其他工具等执行时再出现
        if (event.name === 'write' || event.name === 'edit') {
          preparing.set(event.index, { name: event.name, raw: '', pushed: false })
        }
      } else if (event.type === 'tool_prepare_delta') {
        const prepared = preparing.get(event.index)
        if (prepared) {
          prepared.raw += event.delta
          const path = partialJsonString(prepared.raw, 'file_path')?.trim()
          if (path) {
            const content =
              prepared.name === 'write'
                ? partialJsonString(prepared.raw, 'content') ?? ''
                : [partialJsonString(prepared.raw, 'old_string'), partialJsonString(prepared.raw, 'new_string')]
                    .filter((value): value is string => value !== undefined)
                    .join('')
            const blockId = prepareBlockId(event.index)
            const block: ReplyBlock = {
              type: 'workspace_file',
              id: blockId,
              path,
              action: prepared.name === 'write' ? 'write' : 'edit',
              status: 'running',
              bytes: new TextEncoder().encode(content).length,
            }
            if (prepared.pushed) {
              replaceBlock(blockId, block)
            } else {
              pushBlock(block)
              prepared.pushed = true
            }
            options.onChange(reply)
          }
        }
      } else if (event.type === 'trace') {
        // function call 与结果按步骤落库；正文和思考不重复存，回放时按长度从 blocks 取回
        for (const message of event.messages) {
          reply = { ...reply, toolTrace: appendTrace(reply.toolTrace, message) }
        }
        options.onChange(reply)
      } else if (event.type === 'tool_start') {
        // 工具调用说明思考阶段已结束
        closeThinking(Date.now())
        const round = event.round
        // 附件解析先占一行「解析中」，完成后再补页数与字符数
        if (event.call.name === 'ocr_file') {
          let args: Record<string, unknown> = {}
          try {
            args = event.call.arguments
              ? (JSON.parse(event.call.arguments) as Record<string, unknown>)
              : {}
          } catch {
            args = {}
          }
          const fileId = typeof args.file_id === 'string' ? args.file_id : ''
          pushBlock({
            type: 'attachment_parse',
            id: toolUseId(event.call.id),
            fileId,
            name: options.fileNames?.[fileId] ?? fileId,
            status: 'parsing',
            pages: 0,
            chars: 0,
          })
          options.onChange(reply)
          continue
        }
        // 续读只回填给模型，不重复展示
        if (event.call.name === 'read') {
          continue
        }
        // write / edit：参数已到齐、工具还在执行，先显示文件行与正文大小，结算后再补 diff
        if (event.call.name === 'write' || event.call.name === 'edit') {
          // 参数流式阶段已经有同一调用的临时行，先移除再换成正式 id 的块
          if (event.index !== undefined) {
            const preparedId = prepareBlockId(event.index)
            reply = {
              ...reply,
              blocks: reply.blocks.filter(
                (block) => !('id' in block) || block.id !== preparedId
              ),
            }
            preparing.delete(event.index)
          }
          let args: Record<string, unknown> = {}
          try {
            args = event.call.arguments
              ? (JSON.parse(event.call.arguments) as Record<string, unknown>)
              : {}
          } catch {
            args = {}
          }
          const path = typeof args.file_path === 'string' ? args.file_path.trim() : ''
          if (path) {
            const content =
              event.call.name === 'write'
                ? typeof args.content === 'string'
                  ? args.content
                  : ''
                : [args.old_string, args.new_string]
                    .filter((value): value is string => typeof value === 'string')
                    .join('')
            pushBlock({
              type: 'workspace_file',
              id: toolUseId(event.call.id),
              path,
              action: event.call.name === 'write' ? 'write' : 'edit',
              status: 'running',
              bytes: new TextEncoder().encode(content).length,
            })
            options.onChange(reply)
          }
          continue
        }
        // 未知工具不冒充搜索，等失败结果里再显示「未知工具」
        if (event.call.name !== 'web_search' && event.call.name !== 'read_url') {
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
          round,
        } as ServerToolUseBlock)
        options.onChange(reply)
      } else if (event.type === 'tool_result') {
        if (!event.ok) {
          const failure = event.failure
          if (event.call.name === 'web_search') {
            // 搜索失败沿用搜索块，视图据此显示「暂不可用」或「未搜索到内容」
            pushBlock({
              type: 'web_search_tool_result',
              tool_use_id: toolUseId(event.call.id),
              kind: 'search',
              content: [
                {
                  type: 'web_search_tool_result_error',
                  error_code: failure?.code === 'not_found' ? 'not_found' : 'unavailable',
                },
              ],
            })
          } else {
            // 阅读失败时移除进行中的卡片，避免同时出现「正在阅读」和错误行
            const failedId = toolUseId(event.call.id)
            reply = {
              ...reply,
              blocks: reply.blocks.filter((block) => !('id' in block) || block.id !== failedId),
            }
            // 阅读、OCR、未知工具：保留一行具体错误
            pushBlock({
              type: 'tool_error',
              id: failedId,
              tool: failure?.tool ?? event.call.name,
              code: failure?.code ?? 'unavailable',
              ...(failure?.status ? { status: failure.status } : {}),
            })
          }
          options.onChange(reply)
          continue
        }
        // write / edit 的产物：把执行中的行替换成带 diff 的完成记录
        if (event.workspace) {
          const blockId = toolUseId(event.call.id)
          replaceBlock(blockId, {
            type: 'workspace_file',
            id: blockId,
            path: event.workspace.path,
            action: event.workspace.action,
            status: 'done',
            added: event.workspace.added,
            removed: event.workspace.removed,
          })
          options.onChange(reply)
          continue
        }
        // present 的交付文件：在最终回答下方显示卡片
        if (event.presented) {
          pushBlock({
            type: 'presented_files',
            id: toolUseId(event.call.id),
            files: event.presented,
          })
          options.onChange(reply)
          continue
        }
        // read 的窗口：保留一行可点开的读取记录
        if (event.read) {
          pushBlock({
            type: 'file_read',
            id: toolUseId(event.call.id),
            ...event.read,
          })
          options.onChange(reply)
          continue
        }
        // 解析完成后把「解析中」那一行替换成带页数与字符数的记录
        if (event.call.name === 'ocr_file') {
          if (event.attachment) {
            const blockId = toolUseId(event.call.id)
            replaceBlock(blockId, {
              type: 'attachment_parse',
              id: blockId,
              fileId: event.attachment.id,
              name: event.attachment.name,
              status: 'done',
              pages: event.attachment.pages,
              chars: event.attachment.chars,
            })
            options.onChange(reply)
          }
          continue
        }
        if (event.call.name === 'read') {
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
      } else if (event.type === 'done' && event.stopReason === 'error') {
        // 请求或流出错：保留已收到的块，但必须把错误抛给界面，不能静默结束
        clearPrepared()
        reply = settleReply(reply, 'error', Date.now(), {
          kind: 'stream',
          message: event.error ?? 'The model request failed',
        })
        options.onDone(reply)
        return reply
      }
    }
    // 收尾时补齐仍未结束的思考块，避免用时停在最后一次 tick
    reply = settleReply({ ...reply, stopReason: 'end_turn' }, 'done', Date.now())
  } catch (error) {
    clearPrepared()
    reply = settleReply(reply, 'error', Date.now(), {
      kind: 'stream',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  options.onDone(reply)
  return reply
}
