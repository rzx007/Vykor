import { expect, it } from "vitest"
import type { DesktopSessionMessage, DesktopSessionPart } from "@shared/session-types"
import { findConversationMatches } from "../conversation-find-model"
const base = { sessionId: "s", metadata: {}, createdAt: 1, updatedAt: 1 }
const messages = [
  { ...base, id: "a", seq: 2, role: "assistant" },
  { ...base, id: "u", seq: 1, role: "user" },
] as DesktopSessionMessage[]
const part = { ...base, seq: 1, type: "text", status: "completed" } as DesktopSessionPart
it("matches all tokens within each public message in reading order, including separate parts", () => {
  const parts = [
    { ...part, id: "a1", messageId: "a", text: "HELLO" },
    { ...part, id: "a2", messageId: "a", text: "世界" },
    { ...part, id: "u1", messageId: "u", text: "hello 世界" },
  ]
  expect(
    findConversationMatches(messages, parts, "hello 世界").map((hit) => [
      hit.messageId,
      hit.partIds,
    ])
  ).toEqual([
    ["u", ["u1"]],
    ["a", ["a1", "a2"]],
  ])
  expect(findConversationMatches(messages, parts, "missing")).toEqual([])
  expect(findConversationMatches(messages, parts, " ")).toEqual([])
  expect(findConversationMatches(messages, parts, "x".repeat(257))).toEqual([])
})
it("does not search reasoning, tool bodies or replaced model attempts", () => {
  const parts = [
    { ...part, id: "reasoning", messageId: "a", type: "reasoning" as const, text: "secret" },
    { ...part, id: "tool", messageId: "a", type: "tool" as const, output: "secret" },
    {
      ...part,
      id: "old",
      messageId: "a",
      text: "secret",
      metadata: {
        modelGeneration: { generationId: "g", attempt: 1, committed: true, superseded: true },
      },
    },
  ]
  expect(findConversationMatches(messages, parts, "secret")).toEqual([])
})

const annotationContext =
  '\n\n<browser_annotations>\n{"url":"http://localhost/design","annotations":[{"target":"提交按钮","selector":"#submit","comment":"增加留白"}]}\n</browser_annotations>'

it.each([false, true])(
  "does not match hidden annotation payloads in user messages (split=%s)",
  (split) => {
    const parts = split
      ? [
          { ...part, id: "u1", messageId: "u", text: "修改页面" },
          { ...part, id: "u2", messageId: "u", text: annotationContext },
        ]
      : [{ ...part, id: "u1", messageId: "u", text: `修改页面${annotationContext}` }]
    expect(findConversationMatches(messages, parts, "修改页面")).toEqual([
      { messageId: "u", partIds: ["u1"], tokens: ["修改页面"] },
    ])
    expect(findConversationMatches(messages, parts, "#submit")).toEqual([])
    expect(findConversationMatches(messages, parts, "browser_annotations")).toEqual([])
    expect(findConversationMatches(messages, parts, "增加留白")).toEqual([])
  }
)

it("still searches annotation examples in assistant messages and non-trailing user text", () => {
  const parts = [
    { ...part, id: "a1", messageId: "a", text: annotationContext },
    { ...part, id: "u1", messageId: "u", text: `${annotationContext}\n保留这个示例` },
  ]
  expect(findConversationMatches(messages, parts, "#submit").map((hit) => hit.messageId)).toEqual([
    "u",
    "a",
  ])
})
