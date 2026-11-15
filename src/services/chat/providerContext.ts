/**
 * 非 DeepSeek 提供商的上下文组装。
 *
 * 参考 deepseek-harness 的取舍：
 * - 上下文是一份可投影的历史，超出预算时先裁剪工具输出、再把较早的轮次压成
 *   一份结构化摘要（`<compacted-summary>`），最近的部分保持原样；
 * - 摘要作为一条 user 消息落在历史里，和普通内容一样参与后续轮次；
 * - 裁剪与摘要都只在压力出现时发生，平时的请求不受影响。
 *
 * 与 harness 的差异：这里没有事件日志与“表面投影”，历史就是内存里的消息数组，
 * 因此摘要直接替换掉被压缩的那段历史。
 */
import type { ChatProvider, ProviderMessage } from '../providers/types.js'
import { getReplyText } from './reply.js'
import type { AssistantMessage, Message, UserMessage } from './types.js'

/** 上下文预算：窗口、输出预留与安全余量 */
export type ContextBudget = {
  /** 模型上下文窗口（token） */
  window: number
  /** 为输出预留的 token */
  maxOutput: number
  /** 额外余量，默认 8192（harness 用 65536，这里没有长工具输出那么夸张） */
  headroom?: number
  /** 超过窗口的这个比例就开始压缩，默认 0.8 */
  thresholdRatio?: number
  /** 压缩后保留的原样比例（相对可用窗口），默认 0.16 */
  retainRatio?: number
}

/** 工具输出裁剪的默认值，与 harness 的 pruner 一致 */
const PRUNE_THRESHOLD_CHARS = 8192
const PRUNE_HEAD_CHARS = 4096
const PRUNE_TAIL_CHARS = 1024
const PRUNE_MARKER = '\n\n[...中间内容已裁剪...]\n\n'

const SUMMARY_OPEN = '<compacted-summary>'
const SUMMARY_CLOSE = '</compacted-summary>'

/** 粗略 token 估算：CJK 每字约 1 token，拉丁字符约 4 个 1 token */
export const estimateTokens = (text: string): number => {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return cjk + Math.ceil(other / 4)
}

/** 超出阈值的工具输出裁成「头 + 标记 + 尾」 */
export const pruneToolText = (
  text: string,
  threshold = PRUNE_THRESHOLD_CHARS,
  head = PRUNE_HEAD_CHARS,
  tail = PRUNE_TAIL_CHARS
): string => {
  if (text.length <= threshold) {
    return text
  }
  return text.slice(0, head) + PRUNE_MARKER + text.slice(-tail)
}

const messageTokens = (message: ProviderMessage): number => {
  if (message.role === 'tool') {
    return estimateTokens(pruneToolText(message.content)) + 8
  }
  if (message.role === 'assistant') {
    const calls = (message.toolCalls ?? []).reduce(
      (sum, call) => sum + estimateTokens(call.name) + estimateTokens(call.arguments),
      0
    )
    return estimateTokens(message.content) + calls + 8
  }
  return estimateTokens(message.content) + 8
}

export const countTokens = (messages: ProviderMessage[]): number =>
  messages.reduce((sum, message) => sum + messageTokens(message), 0)

/** 压缩触发阈值与保留预算，公式对齐 harness：floor(min(W·r, W−O−B)) */
export const thresholds = (budget: ContextBudget) => {
  const window = budget.window
  const maxOutput = budget.maxOutput
  const headroom = budget.headroom ?? 8192
  const ratio = budget.thresholdRatio ?? 0.8
  const retainRatio = budget.retainRatio ?? 0.16
  return {
    trigger: Math.floor(Math.min(window * ratio, window - maxOutput - headroom)),
    retain: Math.floor((window - maxOutput) * retainRatio),
  }
}

const SUMMARY_INSTRUCTION = [
  '你是压缩引擎。把上面的对话压缩成一份结构化检查点，让另一个模型能无缝接手。',
  '',
  '严格按下面的 Markdown 结构输出，每一节都要保留；没有内容的写「（无）」。用短句列表，不要写散文：',
  '',
  '## 用户的核心诉求',
  '- [最初与变化后的目标；措辞重要时原样引用]',
  '',
  '## 关键事实与结论',
  '- [已经确认的信息；标注来源 URL]',
  '',
  '## 已排除或存疑的说法',
  '- [被推翻或无法核实的结论，说明原因]',
  '',
  '## 未完成的事项',
  '- [待办、待确认的问题]',
].join('\n')

/** 历史里的可用轮次：提问 + 有正文的回答 */
const usableRounds = (history: Message[]): [UserMessage, AssistantMessage][] => {
  const rounds: [UserMessage, AssistantMessage][] = []
  for (let i = 0; i + 1 < history.length; i++) {
    const [user, reply] = [history[i], history[i + 1]]
    if (user.role === 'user' && reply.role === 'assistant' && getReplyText(reply) !== '') {
      rounds.push([user, reply])
      i++
    }
  }
  return rounds
}

const toRoundMessages = (user: UserMessage, reply: AssistantMessage): ProviderMessage[] => {
  const text = reply.blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n\n')
  return [
    { role: 'user', content: user.content },
    { role: 'assistant', content: text },
  ]
}

/** 调一次模型生成摘要；失败时返回 null，由调用方退化为截断 */
const summarize = async (
  provider: ChatProvider,
  model: string,
  messages: ProviderMessage[],
  signal?: AbortSignal
): Promise<string | null> => {
  let text = ''
  try {
    for await (const event of provider.stream({
      model,
      messages: [
        ...messages,
        { role: 'user', content: SUMMARY_INSTRUCTION },
      ],
      temperature: 0.2,
    }, signal)) {
      if (event.type === 'text') {
        text += event.text
      }
    }
  } catch {
    return null
  }
  return text.trim() ? `${SUMMARY_OPEN}\n${text.trim()}\n${SUMMARY_CLOSE}` : null
}

export type BuildContextOptions = {
  provider: ChatProvider
  model: string
  systemPrompt: string
  history: Message[]
  question: UserMessage
  budget: ContextBudget
  /** 是否需要给模型补充工具使用提示 */
  toolsEnabled: boolean
  signal?: AbortSignal
}

/**
 * 组装发给模型的 messages：
 * 1. 全量历史按轮次展开，超预算时先把工具输出裁剪到 8K/4K/1K；
 * 2. 仍然超预算，就把较早的轮次压成一份摘要，保留最近的 retain 预算；
 * 3. 摘要失败（模型报错）时退化为“丢弃较早轮次”，保证请求能发出去。
 */
export const buildProviderMessages = async ({
  provider,
  model,
  systemPrompt,
  history,
  question,
  budget,
  toolsEnabled,
  signal,
}: BuildContextOptions): Promise<ProviderMessage[]> => {
  const rounds = usableRounds(history)
  const { trigger, retain } = thresholds(budget)

  const flatten = (from: number): ProviderMessage[] => {
    const out: ProviderMessage[] = []
    for (let i = from; i < rounds.length; i++) {
      out.push(...toRoundMessages(rounds[i][0], rounds[i][1]))
    }
    return out
  }

  const pruned = (messages: ProviderMessage[]): ProviderMessage[] =>
    messages.map((message) =>
      message.role === 'tool' ? { ...message, content: pruneToolText(message.content) } : message
    )

  const system: ProviderMessage = { role: 'system', content: systemPrompt }
  const toolHint: ProviderMessage | null = toolsEnabled
    ? {
        role: 'system',
        content:
          '你可以调用 web_search 和 read_url 获取实时网页信息。事实性问题先搜索再回答；引用搜索结果时给出 URL。',
      }
    : null
  const head = (messages: ProviderMessage[]): ProviderMessage[] => {
    messages.push({ role: 'user', content: question.content })
    return messages
  }

  let body = pruned(flatten(0))
  let tokens = countTokens([system, ...(toolHint ? [toolHint] : []), ...body])
  if (tokens <= trigger) {
    return [system, ...(toolHint ? [toolHint] : []), ...head(body)]
  }

  // 从最早的轮次开始切，保留最近的 retain 预算
  let keepFrom = rounds.length
  let kept = 0
  for (let i = rounds.length - 1; i >= 0; i--) {
    const round = toRoundMessages(rounds[i][0], rounds[i][1])
    kept += countTokens(round)
    if (kept > retain) {
      break
    }
    keepFrom = i
  }
  const recent = pruned(flatten(keepFrom))
  const olderMessages = pruned(flatten(0).slice(0, flatten(keepFrom).length))
  const summary = olderMessages.length ? await summarize(provider, model, olderMessages, signal) : null
  body = summary
    ? [{ role: 'user', content: summary }, ...recent]
    : recent
  tokens = countTokens([system, ...(toolHint ? [toolHint] : []), ...body])
  if (tokens > trigger) {
    // 摘要也压不下来：只保留最近一轮，保证请求可用
    body = pruned(flatten(Math.max(0, rounds.length - 1)))
  }
  return [system, ...(toolHint ? [toolHint] : []), ...head(body)]
}
