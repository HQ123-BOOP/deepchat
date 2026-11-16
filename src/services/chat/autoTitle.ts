/**
 * 本地自动标题：首条用户消息之后发一次独立的轻量模型请求。
 *
 * 参考 DeepSeek Harness 的 session-title-first-prompt-llm：
 * - 只用首条消息，包成 JSON 防止原文破坏提示词结构；
 * - 输出取第一个非空行，剥离整行 Markdown 强调，去控制字符并按 UTF-8 字节截断；
 * - fire-and-forget、每会话一次、专用 AbortController、任何失败都静默保留空标题；
 * - 不阻塞主轮次，写回前再次确认会话仍无标题，避免陈旧完成覆盖用户手动命名。
 */
import { createConfiguredPiProvider } from '../providers/piAi.js'
import { useSettings } from '../settings.js'

const TITLE_SYSTEM = [
  'Create a concise title for a chat session from the supplied first user message.',
  'Return only the title on one line, in plain natural language, with no quotes, prefix, explanation, Markdown, XML, or control characters.',
  'Use the language of the message. Aim for about 4-8 words, or 8-16 CJK characters.',
  'If the message gives little to name, still return a short best-effort title such as Greeting.',
].join('\n')

const TITLE_MAX_BYTES = 60
const TITLE_TIMEOUT_MS = 15_000

/** 尝试过的会话不再重试，避免失败后反复发请求 */
const attempted = new Set<string>()

const EMPHASIS_WRAPPER = /^(\*{1,3})(\S(?:.*\S)?)\1$/u
/** 控制字符与零宽/方向格式字符：用 Unicode 属性避免正则里出现字面控制字符 */
const CONTROLS = /\p{Cc}|\p{Cf}/gu

/** 取首个非空行并按字节预算规范化；模型无视单行要求时只保留第一行 */
export const normalizeTitle = (text: string): string => {
  const line = text.split(/\r?\n/u).map((item) => item.trim()).find((item) => item.length > 0) ?? ''
  const emphasis = EMPHASIS_WRAPPER.exec(line)
  const cleaned = (emphasis?.[2] ?? line)
    .replace(CONTROLS, '')
    .replace(/^["'`「『]|["'`」』]$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  const encoder = new TextEncoder()
  let used = 0
  let output = ''
  for (const character of cleaned) {
    const bytes = encoder.encode(character).length
    if (used + bytes > TITLE_MAX_BYTES) {
      break
    }
    used += bytes
    output += character
  }
  return output.trimEnd()
}

export type GenerateTitleOptions = {
  sessionId: string
  firstQuestion: string
  /** 写回前由调用方再次确认会话仍无标题 */
  writeTitle: (title: string) => void
}

/** 立即返回，不等待模型结果；失败、超时、空输出都静默 */
export const maybeGenerateTitle = ({
  sessionId,
  firstQuestion,
  writeTitle,
}: GenerateTitleOptions): void => {
  if (attempted.has(sessionId) || !firstQuestion.trim()) {
    return
  }
  attempted.add(sessionId)
  void (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
    try {
      const provider = createConfiguredPiProvider()
      const model = useSettings.getState().provider.model
      let text = ''
      for await (const event of provider.stream(
        {
          model,
          messages: [
            { role: 'system', content: TITLE_SYSTEM },
            {
              role: 'user',
              content: `Generate the session title from this JSON value of the first user message:\n${JSON.stringify(firstQuestion)}`,
            },
          ],
          maxTokens: 64,
          temperature: 0.2,
        },
        controller.signal
      )) {
        if (event.type === 'text') {
          text += event.text
        }
        if (event.type === 'done' && event.stopReason === 'error') {
          return
        }
      }
      const title = normalizeTitle(text)
      if (title) {
        writeTitle(title)
      }
    } catch {
      // 标题是辅助能力，失败时保持空标题
    } finally {
      clearTimeout(timer)
    }
  })()
}
