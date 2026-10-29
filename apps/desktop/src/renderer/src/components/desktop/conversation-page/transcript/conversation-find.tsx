import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { DesktopSessionMessage, DesktopSessionPart } from "@shared/session-types"
import { FileSearchControls } from "../../tools/files/file-search-controls"
import { useConversationScroller } from "./conversation-scroll-context"
import { findConversationMatches, type ConversationSearchTarget } from "./conversation-find-model"
import { observeConversationMatch } from "./conversation-find-highlight"

export function ConversationFind({
  messages,
  parts,
  target,
  onTargetConsumed,
}: {
  messages: readonly DesktopSessionMessage[]
  parts: readonly DesktopSessionPart[]
  target?: ConversationSearchTarget
  onTargetConsumed?: () => void
}) {
  const scroller = useConversationScroller()!
  const viewportVersion = useSyncExternalStore(
    scroller.subscribe,
    () => scroller.getSnapshot().viewportVersion,
    () => 0
  )
  const [find, setFind] = useState(() => ({
    open: Boolean(target),
    query: target?.query ?? "",
    selectedId: target?.messageId ?? (null as string | null),
    requestVersion: 0,
    target,
  }))
  // 新的全局定位请求只更新本组件；不通过 effect 逐项同步四份状态。
  if (target && target !== find.target) {
    setFind({
      open: true,
      query: target.query,
      selectedId: target.messageId,
      requestVersion: find.requestVersion + 1,
      target,
    })
  }
  const { open, query, selectedId, requestVersion } = find
  const controls = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const highlightName = `conversation-find-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`
  const matches = useMemo(
    () => (open ? findConversationMatches(messages, parts, query) : []),
    [messages, parts, query, open]
  )
  const index = selectedId
    ? matches.findIndex((match) => match.messageId === selectedId)
    : matches.length
      ? 0
      : -1
  const active = matches[index] ?? null
  const matchKey = JSON.stringify(active)

  useEffect(() => {
    if (target) onTargetConsumed?.()
  }, [target, onTargetConsumed])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "f"
      )
        return
      const viewport = scroller.viewportRef.current
      const scope = viewport?.closest(".conversation-surface") ?? viewport?.parentElement
      if (
        !(event.target instanceof Node) ||
        !scope?.contains(event.target) ||
        scope.closest("[hidden], .hidden")
      )
        return
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"][aria-modal="true"]')
      )
        return
      event.preventDefault()
      if (!controls.current?.contains(document.activeElement))
        previousFocus.current = document.activeElement as HTMLElement | null
      setFind((current) => ({ ...current, open: true }))
      const input = controls.current?.querySelector("input")
      input?.focus()
      input?.select()
    }
    window.addEventListener("keydown", keydown, true)
    return () => window.removeEventListener("keydown", keydown, true)
  }, [scroller])

  useEffect(() => {
    if (!viewportVersion) return
    const match = JSON.parse(matchKey) as typeof active
    scroller.setSearchMatch(match)
    if (!match) return
    scroller.scrollToMessage(match.messageId)
    const viewport = scroller.viewportRef.current
    if (viewport)
      return observeConversationMatch(
        viewport,
        match,
        highlightName,
        scroller.recordScrollAdjustment
      )
    return undefined
  }, [matchKey, scroller, highlightName, requestVersion, viewportVersion])
  useEffect(() => () => scroller.setSearchMatch(null), [scroller])

  const close = () => {
    setFind((current) => ({ ...current, open: false }))
    const focus = previousFocus.current
    if (focus?.isConnected && !controls.current?.contains(focus))
      focus.focus({ preventScroll: true })
    else scroller.viewportRef.current?.focus({ preventScroll: true })
  }
  const move = (direction: number) => {
    if (matches.length)
      setFind((current) => ({
        ...current,
        selectedId:
          matches[
            index < 0
              ? direction > 0
                ? 0
                : matches.length - 1
              : (index + direction + matches.length) % matches.length
          ]!.messageId,
      }))
  }
  if (!open) return null
  return (
    <div
      ref={controls}
      role="search"
      aria-label="查找当前聊天"
      className="absolute top-2 right-3 left-3 z-20 ml-auto max-w-sm"
    >
      <style>{`::highlight(${highlightName}) { background-color: var(--selection); color: var(--foreground); } [data-search-active=true] { outline: 2px solid var(--ring); outline-offset: 4px; border-radius: var(--radius); }`}</style>
      <FileSearchControls
        query={query}
        placeholder="查找聊天正文"
        maxLength={256}
        emptyLabel="无匹配消息"
        matchCount={matches.length}
        matchIndex={index}
        disabled={false}
        onQueryChange={(value) => {
          setFind((current) => ({ ...current, query: value, selectedId: null }))
        }}
        onPrevious={() => move(-1)}
        onNext={() => move(1)}
        onClose={close}
      />
      <p
        className={
          selectedId && index < 0
            ? "mt-1 rounded-md bg-popover px-2 py-1 text-xs text-ui-muted"
            : "sr-only"
        }
        role="status"
      >
        {selectedId && index < 0
          ? "这条消息已不可用或不再包含关键词"
          : `${index + 1}/${matches.length} 条匹配消息`}
      </p>
    </div>
  )
}
