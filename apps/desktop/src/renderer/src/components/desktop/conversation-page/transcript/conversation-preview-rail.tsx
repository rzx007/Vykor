import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useReducedMotion } from "motion/react"
import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"

import { PreviewRail, type PreviewRailItem } from "@renderer/components/motion/preview-rail"
import {
  useMessageScroller,
  useMessageScrollerVisibility,
} from "@renderer/components/ui/message-scroller"
import { buildConversationEntries } from "../message/conversation-turn-model"
import {
  buildConversationRailItems,
  resolveRailItemSize,
  shouldShowConversationRail,
  type ConversationRailItem,
} from "./conversation-rail-items"
import { ConversationRailPreview } from "./conversation-rail-preview"
import { visibleTranscriptParts } from "./transcript-visibility"

export function ConversationPreviewRail({
  messages,
  parts,
  runs,
  showReasoning,
}: {
  messages: DesktopSessionMessage[]
  parts: DesktopSessionPart[]
  runs: DesktopSessionRun[]
  showReasoning: boolean
}): React.JSX.Element | null {
  const reduce = useReducedMotion()
  const { scrollToMessage } = useMessageScroller()
  const { visibleMessageIds } = useMessageScrollerVisibility()

  const items = useMemo(() => {
    const visibleParts = visibleTranscriptParts(parts, showReasoning)
    const entries = buildConversationEntries(messages, visibleParts, runs)
    return buildConversationRailItems(entries)
  }, [messages, parts, runs, showReasoning])

  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    setSize({ width: element.clientWidth, height: element.clientHeight })
    return () => observer.disconnect()
  }, [])

  const itemSize = resolveRailItemSize(size.height, items.length)

  const handleSelect = useCallback(
    (item: PreviewRailItem) => {
      scrollToMessage(item.id, {
        align: "start",
        behavior: reduce ? "auto" : "smooth",
      })
    },
    [reduce, scrollToMessage]
  )

  const renderPreview = useCallback(
    (item: PreviewRailItem) => <ConversationRailPreview item={item as ConversationRailItem} />,
    []
  )

  const showRail = shouldShowConversationRail(items.length, size.width)
  const activeId =
    visibleMessageIds.find((id) => items.some((item) => item.id === id)) ?? items.at(-1)?.id

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-20">
      {showRail ? (
        <PreviewRail
          items={items}
          label="对话轮次导航"
          orientation="vertical"
          activeId={activeId}
          highlightActive
          activeScale={0.3}
          tickClassName="text-muted-foreground/50"
          activeTickClassName="text-foreground/50"
          itemSize={itemSize}
          onItemSelect={handleSelect}
          renderPreview={renderPreview}
          className="h-full items-center"
          railClassName="pointer-events-auto ml-4"
        />
      ) : null}
    </div>
  )
}
