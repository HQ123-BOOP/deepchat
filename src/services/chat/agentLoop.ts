/**
 * 客户端 ReAct 循环：模型发起工具调用 → 本地执行 → 结果回填 → 继续请求。
 *
 * DeepSeek 原生路径不需要它（联网由服务端在一个响应内完成）；这里只给
 * "其他提供商 + 标准 function tools" 使用。
 */
import {
  classifyToolFailure,
  runTool,
  type AttachmentSummary,
  type ParsedAttachment,
  type ToolFailureCode,
  type ToolSource,
} from '../tools/registry.js'
import type {
  ChatProvider,
  ProviderMessage,
  ReasoningEffort,
  ToolCall,
  ToolSchema,
} from '../providers/types.js'

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'reasoning_signature'; signature: string }
  /** round = ReAct 循环的第几轮，同一轮内的多个工具调用可合并展示 */
  | { type: 'tool_start'; call: ToolCall; round: number }
  | {
      type: 'tool_result'
      call: ToolCall
      round: number
      sources: ToolSource[]
      ok: boolean
      error?: string
      /** 失败分类，供 UI 显示具体原因 */
      failure?: { code: ToolFailureCode; tool: string; status: number }
      /** 附件解析结果，供 UI 显示一行可点开的记录 */
      attachment?: AttachmentSummary
      /** write / edit 的产物，供 UI 显示文件卡片 */
      workspace?: { path: string; operation: 'created' | 'updated'; chars: number }
      /** read 的窗口信息，供 UI 显示读取卡片 */
      read?: {
        kind: 'attachment' | 'workspace'
        target: string
        name: string
        from: number
        to: number
        total: number
      }
    }
  /**
   * 本轮产生的原始 function call 消息：assistant 工具调用与对应的 tool 结果。
   * 调用方按顺序追加到回复里保存，回放历史时原样送回模型。
   */
  | { type: 'trace'; messages: ProviderMessage[] }
  | { type: 'done'; stopReason: 'stop' | 'length' | 'error'; error?: string }

export type AgentOptions = {
  provider: ChatProvider
  model: string
  /** 会话历史（已按上下文策略组装） */
  messages: ProviderMessage[]
  /** 本轮声明给模型的工具；由联网开关与本轮附件决定 */
  tools?: ToolSchema[]
  /** 会话 id：write / edit 的工作区按会话隔离 */
  sessionId: string
  /** DeepSeek Key，用于执行 search/fetch/ocr；缺失时工具调用会失败 */
  toolApiKey: string
  /** 按附件 id 读取本地原件，供 ocr_file 使用 */
  loadFile: (id: string) => Promise<Blob | undefined>
  /** 保存 OCR 全文，供 read 与 UI 共用 */
  saveFileText?: (doc: ParsedAttachment) => Promise<void>
  /** 读取已保存的 OCR 全文 */
  loadFileText?: (id: string) => Promise<ParsedAttachment | undefined>
  /** 本地 id → 文件名 */
  fileNames?: Record<string, string>
  signal?: AbortSignal
  temperature?: number
  reasoningEffort?: ReasoningEffort
}

/**
 * 驱动一轮对话。事件按产生顺序产出，调用方据此更新 UI；函数结束时消息历史
 * 已被内部推进到最终回答，但不修改调用方传入的数组。
 */
export async function* runAgent(
  options: AgentOptions
): AsyncGenerator<AgentEvent> {
  const messages: ProviderMessage[] = [...options.messages]
  const tools = options.tools?.length ? options.tools : undefined

  // 不设轮次上限：模型继续调用工具就继续驱动，直到它给出正文、报错或被 signal 取消。
  for (let step = 0; ; step++) {
    const pending: ToolCall[] = []
    let finish: 'stop' | 'length' | 'tool_calls' | 'error' = 'stop'
    let text = ''
    // 这一轮的思考与签名；必须随 assistant 消息回传，否则工具续轮会丢推理
    let reasoning = ''
    let reasoningSignature = ''

    try {
      for await (const event of options.provider.stream(
        {
          model: options.model,
          messages,
          tools,
          temperature: options.temperature,
          reasoningEffort: options.reasoningEffort,
        },
        options.signal
      )) {
        if (event.type === 'text') {
          text += event.text
          yield { type: 'text', text: event.text }
        } else if (event.type === 'reasoning') {
          reasoning += event.text
          yield { type: 'reasoning', text: event.text }
        } else if (event.type === 'reasoning_signature') {
          reasoningSignature = event.signature
          yield { type: 'reasoning_signature', signature: event.signature }
        } else if (event.type === 'tool_call') {
          pending.push(event.call)
        } else if (event.type === 'done') {
          finish = event.stopReason === 'error' ? 'error' : event.stopReason
          if (event.error) {
            yield { type: 'done', stopReason: 'error', error: event.error }
            return
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield { type: 'done', stopReason: 'error', error: error instanceof Error ? error.message : String(error) }
      return
    }

    if (pending.length === 0) {
      yield { type: 'done', stopReason: finish === 'length' ? 'length' : 'stop' }
      return
    }

    // 把这一轮的助手消息（可能含正文 + 工具调用）写入历史，再逐个执行工具
    const assistant: ProviderMessage = {
      role: 'assistant',
      content: text,
      toolCalls: pending,
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningSignature ? { reasoningSignature } : {}),
    }
    messages.push(assistant)
    yield { type: 'trace', messages: [assistant] }
    for (const call of pending) {
      yield { type: 'tool_start', call, round: step }
      let content: string
      let sources: ToolSource[] = []
      let attachment: AttachmentSummary | undefined
      let workspace: { path: string; operation: 'created' | 'updated'; chars: number } | undefined
      let read:
        | { kind: 'attachment' | 'workspace'; target: string; name: string; from: number; to: number; total: number }
        | undefined
      try {
        const parsed = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {}
        const result = await runTool(call.name, parsed, {
          apiKey: options.toolApiKey,
          sessionId: options.sessionId,
          loadFile: options.loadFile,
          saveFileText: options.saveFileText,
          loadFileText: options.loadFileText,
          fileNames: options.fileNames,
          signal: options.signal,
        })
        content = result.content
        sources = result.sources
        attachment = result.attachment
        workspace = result.workspace
        read = result.read
        yield {
          type: 'tool_result',
          call,
          round: step,
          sources,
          ok: true,
          attachment,
          workspace,
          read,
        }
      } catch (error) {
        const failure = classifyToolFailure(call.name, error)
        content = `Tool ${call.name} failed: ${failure.message}`
        yield {
          type: 'tool_result',
          call,
          round: step,
          sources,
          ok: false,
          error: failure.message,
          failure: { code: failure.code, tool: failure.tool, status: failure.status },
        }
      }
      const toolMessage: ProviderMessage = { role: 'tool', toolCallId: call.id, name: call.name, content }
      messages.push(toolMessage)
      yield { type: 'trace', messages: [toolMessage] }
    }
  }
}
