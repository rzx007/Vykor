import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { DesktopSessionMessage, DesktopSessionPart } from "@shared/session-types"

import { buildConversationEntries } from "../../message/conversation-turn-model"
import {
  buildConversationRailItems,
  CONVERSATION_RAIL_MIN_CONTAINER_WIDTH,
  CONVERSATION_RAIL_MIN_TURNS,
  RAIL_ITEM_MAX_SIZE,
  RAIL_ITEM_MIN_SIZE,
  resolveRailItemSize,
  shouldShowConversationRail,
  type ConversationRailItem,
} from "../conversation-rail-items"
import { ConversationRailPreview } from "../conversation-rail-preview"

describe("buildConversationRailItems", () => {
  it("creates one tick per user turn with its prompt and reply", () => {
    const messages = [
      message("user", 1, { inputId: "input-1" }),
      message("assistant", 2, { inputId: "input-1", runId: "run-1" }),
      message("user", 3, { inputId: "input-2" }),
      message("assistant", 4, { inputId: "input-2", runId: "run-2" }),
    ]
    const parts = [
      textPart("message-1", "第一个问题"),
      textPart("message-2", "第一条回答"),
      textPart("message-3", "第二个问题"),
      textPart("message-4", "第二条回答"),
    ]

    const items = buildConversationRailItems(buildConversationEntries(messages, parts, []))

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: "input-1",
      label: "第一个问题",
      prompt: "第一个问题",
      reply: "第一条回答",
      turnIndex: 1,
      ariaLabel: "第 1 轮：第一个问题",
    })
    expect(items[1]).toMatchObject({ id: "input-2", turnIndex: 2 })
  })

  it("falls back to the message id when a turn has no input id", () => {
    const items = buildConversationRailItems(
      buildConversationEntries([message("user", 5)], [textPart("message-5", "无输入 id")], [])
    )

    expect(items[0]?.id).toBe("message-5")
  })

  it("joins multiple text parts and collapses whitespace", () => {
    const userParts = [textPart("message-7", "第一段\n换行"), textPart("message-7", "  第二段  ")]

    const items = buildConversationRailItems(
      buildConversationEntries([message("user", 7, { inputId: "input-7" })], userParts, [])
    )

    expect(items[0]?.prompt).toBe("第一段 换行 第二段")
  })

  it("truncates long prompts and labels with an ellipsis", () => {
    const long = "甲".repeat(400)

    const items = buildConversationRailItems(
      buildConversationEntries(
        [message("user", 1, { inputId: "input-1" })],
        [textPart("message-1", long)],
        []
      )
    )

    expect(items[0]?.label.endsWith("…")).toBe(true)
    expect(items[0]?.label.length).toBe(65)
    expect(items[0]?.prompt.endsWith("…")).toBe(true)
    expect(items[0]?.prompt.length).toBe(221)
  })

  it("uses a placeholder for a turn without textual prompt", () => {
    const items = buildConversationRailItems(
      buildConversationEntries([message("user", 1, { inputId: "input-1" })], [], [])
    )

    expect(items[0]?.label).toBe("（无文本提问）")
    expect(items[0]?.ariaLabel).toBe("第 1 轮：无文本提问")
    expect(items[0]?.reply).toBe("")
  })

  it("skips system entries and assistant-only turns", () => {
    const messages = [
      message("system", 1),
      message("assistant", 2, { inputId: "input-1", runId: "run-1" }),
      message("user", 3, { inputId: "input-2" }),
    ]

    const items = buildConversationRailItems(
      buildConversationEntries(messages, [textPart("message-3", "只有这一轮")], [])
    )

    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe("input-2")
  })
})

describe("resolveRailItemSize", () => {
  it("keeps the maximum size while a conversation still fits", () => {
    expect(resolveRailItemSize(700, CONVERSATION_RAIL_MIN_TURNS)).toBe(RAIL_ITEM_MAX_SIZE)
  })

  it("shrinks the ticks as the conversation grows", () => {
    expect(resolveRailItemSize(700, 40)).toBe(16)
  })

  it("never drops below the minimum size", () => {
    expect(resolveRailItemSize(700, 1000)).toBe(RAIL_ITEM_MIN_SIZE)
  })

  it("falls back to the maximum before it knows its height", () => {
    expect(resolveRailItemSize(0, 40)).toBe(RAIL_ITEM_MAX_SIZE)
  })
})

describe("shouldShowConversationRail", () => {
  it("hides the rail for a short conversation", () => {
    expect(shouldShowConversationRail(CONVERSATION_RAIL_MIN_TURNS - 1, 900)).toBe(false)
  })

  it("shows the rail for a long conversation in a wide container", () => {
    expect(shouldShowConversationRail(CONVERSATION_RAIL_MIN_TURNS, 900)).toBe(true)
  })

  it("hides the rail when the message list container is narrow", () => {
    expect(
      shouldShowConversationRail(
        CONVERSATION_RAIL_MIN_TURNS,
        CONVERSATION_RAIL_MIN_CONTAINER_WIDTH - 1
      )
    ).toBe(false)
  })

  it("shows the rail before the container width is measured", () => {
    expect(shouldShowConversationRail(CONVERSATION_RAIL_MIN_TURNS, 0)).toBe(true)
  })
})

describe("ConversationRailPreview", () => {
  it("renders the prompt above the assistant reply", () => {
    const item: ConversationRailItem = {
      id: "input-1",
      label: "帮我调研一下",
      ariaLabel: "第 1 轮：帮我调研一下",
      prompt: "帮我调研一下",
      reply: "调研结果如下",
      turnIndex: 1,
      createdAt: 1,
    }

    const html = renderToStaticMarkup(createElement(ConversationRailPreview, { item }))

    expect(html).toContain("帮我调研一下")
    expect(html).toContain("调研结果如下")
    expect(html.indexOf("帮我调研一下")).toBeLessThan(html.indexOf("调研结果如下"))
  })

  it("omits the reply block when a turn has no answer yet", () => {
    const item: ConversationRailItem = {
      id: "input-1",
      label: "还没回答",
      ariaLabel: "第 1 轮：还没回答",
      prompt: "还没回答",
      reply: "",
      turnIndex: 1,
      createdAt: 1,
    }

    const html = renderToStaticMarkup(createElement(ConversationRailPreview, { item }))

    expect(html).toContain("还没回答")
    expect(html).not.toContain('data-slot="conversation-rail-reply"')
  })
})

function message(
  role: DesktopSessionMessage["role"],
  seq: number,
  relationship: Pick<DesktopSessionMessage, "inputId" | "runId"> = {}
): DesktopSessionMessage {
  return {
    id: `message-${seq}`,
    sessionId: "session-1",
    seq,
    role,
    metadata: {},
    createdAt: seq,
    updatedAt: seq,
    ...relationship,
  }
}

function textPart(messageId: string, text: string): DesktopSessionPart {
  return {
    id: `part-${messageId}-${text.slice(0, 4)}`,
    sessionId: "session-1",
    messageId,
    seq: 0,
    type: "text",
    status: "completed",
    text,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}
