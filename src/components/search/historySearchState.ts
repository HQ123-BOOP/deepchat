import { create } from 'zustand'

/** 全对话搜索弹窗的全局开合状态：展开/折叠侧栏与快捷键共用一个入口 */
export const useHistorySearch = create<{ open: boolean }>(() => ({ open: false }))

export const openHistorySearch = () => useHistorySearch.setState({ open: true })

export const closeHistorySearch = () => useHistorySearch.setState({ open: false })
