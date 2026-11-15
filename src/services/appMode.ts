import { create } from 'zustand'

/** 应用有两种模式：普通对话（现有能力）与工作（遥控局域网里的 DSH） */
export type AppMode = 'chat' | 'work'

type ModeState = {
  mode: AppMode
}

export const useModeStore = create<ModeState>(() => ({
  mode: localStorage.getItem('chat-demo:mode') === 'work' ? 'work' : 'chat',
}))

export const setMode = (mode: AppMode) => {
  localStorage.setItem('chat-demo:mode', mode)
  useModeStore.setState({ mode })
}
