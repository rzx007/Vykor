// 原生滚动事件与虚拟列表使用相同的底部判定，避免两端各自维护不同阈值。
export const conversationEndThresholdPx = 8

export interface ConversationScrollSnapshot {
  following: boolean
  atEnd: boolean
  activeMessageId: string | null
  viewportVersion: number
  retainedRowIds: readonly string[]
}

interface TranscriptNavigation {
  hasMessage(id: string): boolean
  scrollToMessage(id: string): void
  scrollToEnd(): void
}

export function createConversationScrollState() {
  const viewportRef: { current: HTMLDivElement | null } = { current: null }
  const turnExpansion = new Map<string, boolean>()
  const presentedTurns = new Set<string>()
  const retainedRows = new Map<string, number>()
  const listeners = new Set<() => void>()
  let snapshot: ConversationScrollSnapshot = {
    following: true,
    atEnd: true,
    activeMessageId: null,
    viewportVersion: 0,
    retainedRowIds: [],
  }
  let navigation: TranscriptNavigation | null = null
  let intent = 0
  let lastScrollTop = 0

  const publish = (next: ConversationScrollSnapshot): void => {
    if (
      next.following === snapshot.following &&
      next.atEnd === snapshot.atEnd &&
      next.activeMessageId === snapshot.activeMessageId &&
      next.viewportVersion === snapshot.viewportVersion &&
      next.retainedRowIds === snapshot.retainedRowIds
    )
      return
    snapshot = next
    for (const listener of listeners) listener()
  }
  return {
    viewportRef,
    turnExpansion,
    presentedTurns,
    retainRow: (id: string) => {
      retainedRows.set(id, (retainedRows.get(id) ?? 0) + 1)
      if (retainedRows.get(id) === 1)
        publish({ ...snapshot, retainedRowIds: [...retainedRows.keys()] })
      return () => {
        const remaining = (retainedRows.get(id) ?? 1) - 1
        if (remaining) retainedRows.set(id, remaining)
        else {
          retainedRows.delete(id)
          publish({ ...snapshot, retainedRowIds: [...retainedRows.keys()] })
        }
      }
    },
    setViewport: (element: HTMLDivElement | null) => {
      if (viewportRef.current === element) return
      viewportRef.current = element
      publish({ ...snapshot, viewportVersion: snapshot.viewportVersion + 1 })
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    registerNavigation: (next: TranscriptNavigation) => {
      navigation = next
      return () => {
        if (navigation === next) navigation = null
      }
    },
    setPosition: (atEnd: boolean, activeMessageId: string | null) =>
      publish({ ...snapshot, atEnd, activeMessageId }),
    setIntent: (direction: number) => {
      intent = direction
      if (direction <= 0) publish({ ...snapshot, following: false })
    },
    onScroll: () => {
      const viewport = viewportRef.current
      if (!viewport) return
      const atEnd =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
        conversationEndThresholdPx
      const movedUp = viewport.scrollTop < lastScrollTop - 1
      const movedDown = viewport.scrollTop > lastScrollTop + 1
      lastScrollTop = viewport.scrollTop
      if (atEnd && movedDown) intent = 1
      // 高度增长可能产生位置未变的 scroll 回读，它不代表用户离开底部。
      const following =
        atEnd && intent >= 0 ? true : movedUp || intent < 0 ? false : snapshot.following
      publish({ ...snapshot, atEnd, following })
    },
    scrollToMessage: (id: string): boolean => {
      if (!navigation?.hasMessage(id)) return false
      intent = -1
      publish({ ...snapshot, following: false })
      navigation.scrollToMessage(id)
      return true
    },
    scrollToEnd: () => {
      intent = 1
      publish({ ...snapshot, following: true })
      navigation?.scrollToEnd()
    },
  }
}

export type ConversationScrollState = ReturnType<typeof createConversationScrollState>
