import { useCallback, useEffect, useRef, useState } from "react"
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
  CONVERSATION_RAIL_MIN_CONTAINER_WIDTH,
  CONVERSATION_RAIL_MIN_TURNS,
  buildConversationRailItems,
  resolveRailItemSize,
  shouldShowConversationRail,
  updateConversationRailReply,
  type ConversationRailItem,
} from "./conversation-rail-items"
import { ConversationRailPreview } from "./conversation-rail-preview"
import { visibleTranscriptParts } from "./transcript-visibility"

type RailItemsCache = {
  messages: DesktopSessionMessage[]
  parts: DesktopSessionPart[]
  runs: DesktopSessionRun[]
  showReasoning: boolean
  items: ConversationRailItem[]
  visiblePartIds: Set<string>
  lastAssistantMessageId?: string
  lastAssistantParts: DesktopSessionPart[]
}

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

  const containerRef = useRef<HTMLDivElement>(null)
  const [railItemsCache, setRailItemsCache] = useState<RailItemsCache | null>(null)
  const turnCount = countUserTurns(messages, runs)
  const [viewport, setViewport] = useState({ wide: true, height: 0 })

  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === "undefined") return
    const updateSize = (width: number, height: number): void => {
      const wide = width >= CONVERSATION_RAIL_MIN_CONTAINER_WIDTH
      setViewport((current) => {
        return current.wide === wide && current.height === height ? current : { wide, height }
      })
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) updateSize(entry.contentRect.width, entry.contentRect.height)
    })
    observer.observe(element)
    updateSize(element.clientWidth, element.clientHeight)
    return () => observer.disconnect()
  }, [])

  const mayShowRail = viewport.wide && turnCount >= CONVERSATION_RAIL_MIN_TURNS
  let items: ConversationRailItem[] = []
  if (mayShowRail) {
    const nextCache = resolveRailItems(railItemsCache, { messages, parts, runs, showReasoning })
    if (nextCache !== railItemsCache) setRailItemsCache(nextCache)
    items = nextCache.items
  }
  const itemSize = resolveRailItemSize(viewport.height, items.length)

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

  const showRail = shouldShowConversationRail(
    items.length,
    viewport.wide ? CONVERSATION_RAIL_MIN_CONTAINER_WIDTH : 0
  )
  const itemIds = new Set(items.map((item) => item.id))
  const activeId = visibleMessageIds.find((id) => itemIds.has(id)) ?? items.at(-1)?.id

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

function countUserTurns(
  messages: readonly DesktopSessionMessage[],
  runs: readonly DesktopSessionRun[]
): number {
  const inputIdByRunId = new Map(runs.map((run) => [run.id, run.inputId]))
  const turnIds = new Set<string>()
  for (const message of messages) {
    if (message.role === "user") {
      turnIds.add(
        message.inputId ??
          (message.runId ? inputIdByRunId.get(message.runId) : undefined) ??
          message.id
      )
    }
  }
  return turnIds.size
}

function resolveRailItems(
  previous: RailItemsCache | null,
  input: Pick<RailItemsCache, "messages" | "parts" | "runs" | "showReasoning">
): RailItemsCache {
  if (
    previous &&
    previous.showReasoning === input.showReasoning &&
    sameReferences(previous.messages, input.messages) &&
    sameReferences(previous.runs, input.runs)
  ) {
    const updatedPart = findSingleTextAppend(previous.parts, input.parts)
    if (updatedPart === null || updatedPart?.type === "reasoning") {
      if (
        previous.messages === input.messages &&
        previous.parts === input.parts &&
        previous.runs === input.runs
      )
        return previous
      return { ...previous, ...input, items: previous.items }
    }
    if (
      updatedPart?.type === "text" &&
      previous.visiblePartIds.has(updatedPart.id) &&
      previous.lastAssistantMessageId === updatedPart.messageId
    ) {
      const partIndex = previous.lastAssistantParts.findIndex((part) => part.id === updatedPart.id)
      const lastItem = previous.items.at(-1)
      if (partIndex >= 0 && lastItem) {
        const lastAssistantParts = [...previous.lastAssistantParts]
        lastAssistantParts[partIndex] = updatedPart
        const items = [
          ...previous.items.slice(0, -1),
          updateConversationRailReply(lastItem, lastAssistantParts),
        ]
        return {
          ...input,
          items,
          visiblePartIds: previous.visiblePartIds,
          lastAssistantMessageId: previous.lastAssistantMessageId,
          lastAssistantParts,
        }
      }
    }
  }

  const visibleParts = visibleTranscriptParts(input.parts, input.showReasoning)
  const entries = buildConversationEntries(input.messages, visibleParts, input.runs)
  const items = buildConversationRailItems(entries)
  const lastTurn = [...entries]
    .reverse()
    .find((entry) => entry.type === "turn" && entry.turn.userMessage)
  return {
    ...input,
    items,
    visiblePartIds: new Set(visibleParts.map((part) => part.id)),
    lastAssistantMessageId:
      lastTurn?.type === "turn" ? lastTurn.turn.assistantMessages.at(-1)?.id : undefined,
    lastAssistantParts: lastTurn?.type === "turn" ? lastTurn.turn.assistantParts : [],
  }
}

function findSingleTextAppend(
  previous: DesktopSessionPart[],
  next: DesktopSessionPart[]
): DesktopSessionPart | null | undefined {
  if (previous.length !== next.length) return undefined
  let updated: DesktopSessionPart | undefined
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index]!
    const after = next[index]!
    if (before === after) continue
    if (updated || !isTextAppend(before, after)) return undefined
    updated = after
  }
  return updated ?? null
}

function isTextAppend(previous: DesktopSessionPart, next: DesktopSessionPart): boolean {
  if (
    (next.type !== "text" && next.type !== "reasoning") ||
    previous.type !== next.type ||
    previous.id !== next.id ||
    previous.sessionId !== next.sessionId ||
    previous.messageId !== next.messageId ||
    previous.seq !== next.seq ||
    previous.status !== next.status ||
    previous.toolUseId !== next.toolUseId ||
    previous.toolName !== next.toolName ||
    previous.input !== next.input ||
    previous.output !== next.output ||
    previous.bodyView !== next.bodyView ||
    previous.isError !== next.isError ||
    previous.metadata !== next.metadata ||
    previous.createdAt !== next.createdAt
  )
    return false
  const previousText = previous.text ?? ""
  return typeof next.text === "string" && next.text.startsWith(previousText)
}

function sameReferences<T>(previous: readonly T[], next: readonly T[]): boolean {
  if (previous === next) return true
  if (previous.length !== next.length) return false
  return previous.every((item, index) => item === next[index])
}
