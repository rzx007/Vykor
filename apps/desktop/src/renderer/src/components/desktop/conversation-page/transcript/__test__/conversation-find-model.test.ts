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
