import { createContext, useContext, useLayoutEffect } from "react"
import { useConversationScroller } from "./conversation-scroll-context"

export const TranscriptRowContext = createContext<string | null>(null)

// 编辑器和已打开的插件包含未提交输入，滚出屏幕后仍需保留同一个组件实例。
export function useRetainTranscriptRow(active: boolean) {
  const scroller = useConversationScroller()
  const rowId = useContext(TranscriptRowContext)
  useLayoutEffect(() => {
    if (active && rowId && scroller) return scroller.retainRow(rowId)
    return undefined
  }, [active, rowId, scroller])
}
