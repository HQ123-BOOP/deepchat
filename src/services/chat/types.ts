import type { TranslationMessage } from '../../i18n/index.js'
import type { ApiErrorKind } from '../api/client.js'
import type { ToolCall } from '../providers/types.js'
import type {
  MessageUsage,
  ServerToolBlock,
  StopDetails,
  StopReason,
  TextCitation,
} from '../api/types.js'

/**
 * 消息附件。id 是本地标识（IndexedDB files 表的主键，原件按它存储，所有引用同一 id 的消息共用一份），
 * 导入的附件沿用导出产物里的文件 ID；本地没有原件的附件只展示文件名，不进入请求。
 * serverId 是 Files API 返回的 file_id，导入的数据或尚未上传成功的文件为 null，发送前补传。
 */
export type FileAttachment = {
  id: string
  serverId: string | null
  name: string
  size: number
  /** 附件类别；导入时沿用归档的 is_image，不由 MIME 识别结果决定。 */
  isImage: boolean
  /** 具体 MIME；导入时没有原件或无法识别的为空字符串，不影响图片身份。 */
  mimeType: string
}

/** 本地消息的分支关系；字段缺省时按线性消息列表处理。 */
type MessageBranch = {
  parentId?: string | null
  /** 当前选中的下一条消息；切换版本时保留每条分支原有的选择。 */
  selectedChildId?: string
}

export type UserMessage = MessageBranch & {
  id: string
  role: 'user'
  content: string
  files: FileAttachment[]
  createdAt: number
}

/** 思考块：流式增量累积，签名随块结束到达；历史轮次按签名原样回传给模型 */
export type ThinkingPart = {
  type: 'thinking'
  thinking: string
  signature?: string
  /** content_block_start 的时间；没有事件时间的历史块缺省 */
  startedAt?: number
  /** content_block_stop（或回复结束）的时间 */
  endedAt?: number
  /** 仅有耗时、没有事件时间时保存秒数。 */
  elapsedSeconds?: number
}

/** 文本块：text_delta 累积，citations_delta 追加引用 */
export type TextPart = {
  type: 'text'
  text: string
  citations?: TextCitation[]
  /** 服务端提示文案，仅用于展示，不作为模型回答参与上下文或续写。 */
  isTemplate?: boolean
}

/** 服务端工具调用与结果块按协议原样保存；历史请求只回传 read_link 调用与结果 */
/** 工具失败类别，与执行层的 ToolFailureCode 一一对应 */
export type ToolErrorCode = 'unknown_tool' | 'invalid_arguments' | 'not_found' | 'unavailable'

/** 工具调用失败：保留一行可见的错误，tool 为模型实际调用的名字 */
export type ToolErrorPart = {
  type: 'tool_error'
  id: string
  tool: string
  code: ToolErrorCode
  status?: number
}

/** 附件解析记录：parsing 时只有文件名，done 后补上页数与字符数；全文在 fileTexts 里 */
export type AttachmentParsePart = {
  type: 'attachment_parse'
  id: string
  fileId: string
  name: string
  status: 'parsing' | 'done'
  pages: number
  chars: number
}

/** write / edit 的工作区产物：文件本体在 SQLite 工作区里，这里只记录展示信息 */
export type WorkspaceFilePart = {
  type: 'workspace_file'
  id: string
  path: string
  action?: 'create' | 'update' | 'edit'
  added?: number
  removed?: number
  /** 早期消息的字段，保留用于兼容 */
  operation?: 'created' | 'updated'
  chars?: number
}

/** read 的窗口记录：附件或工作区文件读取了哪些行 */
export type FileReadPart = {
  type: 'file_read'
  id: string
  kind: 'attachment' | 'workspace'
  target: string
  name: string
  from: number
  to: number
  total: number
}

export type ReplyBlock =
  | ThinkingPart
  | TextPart
  | ServerToolBlock
  | ToolErrorPart
  | AttachmentParsePart
  | WorkspaceFilePart
  | FileReadPart

/** 一次本地工具调用回给模型的结果；content 是当时完整的工具输出 */
export type ToolTraceResult = {
  toolCallId: string
  name: string
  content: string
}

/**
 * 回放本地 function call 需要的最小轨迹。
 * 正文与思考仍留在 blocks 里，这里只记录该步占用的字符数，回放时按顺序取回，避免重复存储。
 */
export type ToolTraceStep = {
  toolCalls: ToolCall[]
  /** 该步正文在 blocks 中占的字符数 */
  textLength: number
  /** 该步思考在 blocks 中占的字符数 */
  reasoningLength: number
  reasoningSignature?: string
  results: ToolTraceResult[]
}

/**
 * pending：已发出请求，还没收到事件；streaming：正在接收；
 * done：收到 message_stop；stopped：用户停止或页面关闭；error：请求或流出错
 */
export type ReplyStatus = 'pending' | 'streaming' | 'done' | 'stopped' | 'error'

export type AssistantMessage = MessageBranch & {
  id: string
  role: 'assistant'
  createdAt: number
  /** 未记录模型时为 null，续写使用当前设置的模型。 */
  model: string | null
  /** 请求时是否开启深度思考 */
  thinking?: boolean
  /** 请求时是否声明 deepseek_web_search；关闭时仍声明 deepseek_read_url */
  search?: boolean
  /** 本轮请求的系统信息快照；各回答版本独立保存，续写沿用。历史消息中缺省的快照保持为空。 */
  latestReminder?: string
  status: ReplyStatus
  /** 可识别的内容块按接收顺序排列 */
  blocks: ReplyBlock[]
  /**
   * 本轮本地 function call 的轨迹，按产生顺序排列；正文与思考按字符数与 blocks 对齐回放。
   * 早期没有该字段的消息退化为把检索结果拼成文本。
   */
  toolTrace?: ToolTraceStep[]
  stopReason?: StopReason
  stopDetails?: StopDetails
  /** 最近一次请求的用量，续写后更新 */
  usage?: MessageUsage
  error?: {
    /** upload：发送前补传附件失败，请求没有发出 */
    kind: ApiErrorKind | 'upload'
    message: string
    status?: number
    localMessage?: TranslationMessage
    /** 仅 upload：重新上传是否可能成功（网络、限流、服务端繁忙）；过大、格式不支持为 false */
    retryable?: boolean
  }
}

export type Message = UserMessage | AssistantMessage

export type Session = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 包含所有分支的消息，按创建顺序存储。 */
  messages: Message[]
  /** 历史字段：早期版本的工作会话标记，仅为兼容已保存的旧会话保留，不再写入 */
  mode?: 'chat' | 'work'
  /** 历史字段：早期版本导入 DSH 后的会话 id，仅为兼容已保存的旧会话保留 */
  dshSessionId?: string
  /** undefined 表示线性消息列表；null 表示空会话。 */
  rootMessageId?: string | null
}

/** 会话列表元数据；消息只在打开会话时加载。 */
export type SessionSummary = Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'mode'>

/** 显式提取字段，避免将完整会话的消息带进列表。 */
export const toSessionSummary = (session: SessionSummary): SessionSummary => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  mode: session.mode,
})
