/**
 * 把一段 App 内的对话转换成工作会话：在选定的 DSH 工作区里新建会话，
 * 把历史记录作为第一条消息发给它，然后给本地会话打上「工作」标记。
 *
 * 转换不可逆：本地会话只保留一份只读的历史，后续对话都发生在 DSH 侧。
 */
import { getContextRounds, getReplyText } from '../chat/reply.js'
import { markSessionWork } from '../chat/store.js'
import type { Session } from '../chat/types.js'
import { createSession, sendMessage } from './bridgeClient.js'
import { useWorkStore } from './store.js'

/** 可选的 DSH 工作区：来自桥接端已有会话的 cwd，去重后按字母排序 */
export const knownWorkspaces = (): string[] => {
  const cwds = new Set<string>()
  for (const session of useWorkStore.getState().sessions) {
    if (session.cwd) {
      cwds.add(session.cwd)
    }
  }
  return [...cwds].sort((a, b) => a.localeCompare(b))
}

/** 把历史轮次压成纯文本；工具调用与引用不进入转录 */
export const buildTranscript = (session: Session): string => {
  const lines: string[] = []
  for (const [user, reply] of getContextRounds(session.messages)) {
    lines.push(`用户：${user.content}`)
    lines.push(`助手：${getReplyText(reply)}`)
    lines.push('')
  }
  return lines.join('\n').trim()
}

export const convertSessionToWork = async (session: Session, cwd: string): Promise<string> => {
  const { host, port, token } = useWorkStore.getState()
  if (!token) {
    throw new Error('not-connected')
  }
  const transcript = buildTranscript(session)
  const created = await createSession(host, port, token, cwd)
  const prompt = [
    '下面是一段此前在其他客户端产生的对话记录。请把它当作本次会话已经发生的上下文，',
    '不要复述，也不要道歉，直接在此基础上继续配合用户。',
    '',
    '<conversation>',
    transcript || '（原对话为空）',
    '</conversation>',
  ].join('\n')
  await sendMessage(host, port, token, created.sessionId, prompt)
  await markSessionWork(session.id, created.sessionId)
  return created.sessionId
}
