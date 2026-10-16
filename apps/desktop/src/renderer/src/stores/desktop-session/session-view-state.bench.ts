// Frozen pre-optimization reducer, retained only as a performance comparison.
import { bench, describe, expect } from "vitest"
import type {
  DesktopSessionPart,
  DesktopSessionPartDelta,
  DesktopSessionView,
} from "@shared/session-types"
import { applySessionPartDeltas, type ApplySessionPartDeltasResult } from "./session-view-state"

function applyLinearSessionPartDeltas(
  view: DesktopSessionView,
  update: { sessionId: string; deltas: readonly DesktopSessionPartDelta[] }
): ApplySessionPartDeltasResult {
  if (update.sessionId !== view.session.id) return { kind: "resync-required" }

  let parts: DesktopSessionPart[] | null = null
  let cursor = view.cursor
  let previousSeq = Number.NEGATIVE_INFINITY
  let addedPart = false

  for (const delta of update.deltas) {
    if (
      !Number.isSafeInteger(delta.seq) ||
      delta.seq <= previousSeq ||
      !Number.isSafeInteger(delta.baseLength) ||
      delta.baseLength < 0 ||
      !Number.isFinite(delta.createdAt) ||
      typeof delta.delta !== "string" ||
      (delta.field !== "text" && delta.field !== "reasoning")
    ) {
      return { kind: "resync-required" }
    }
    previousSeq = delta.seq
    if (delta.seq <= cursor) continue

    const message = view.messages.find((candidate) => candidate.id === delta.messageId)
    if (!message || message.sessionId !== update.sessionId) return { kind: "resync-required" }

    const currentParts = parts ?? view.parts
    const partIndex = currentParts.findIndex((candidate) => candidate.id === delta.partId)
    if (partIndex < 0) {
      if (
        delta.baseLength !== 0 ||
        delta.partSeq === undefined ||
        !Number.isSafeInteger(delta.partSeq) ||
        delta.partSeq < 0
      ) {
        return { kind: "resync-required" }
      }
      if (parts === null) parts = [...view.parts]
      parts.push({
        id: delta.partId,
        sessionId: update.sessionId,
        messageId: delta.messageId,
        seq: delta.partSeq,
        type: delta.field,
        status: "running",
        text: delta.delta,
        metadata: {},
        createdAt: delta.createdAt,
        updatedAt: delta.createdAt,
      })
      addedPart = true
    } else {
      const part = currentParts[partIndex]
      if (
        !part ||
        part.sessionId !== update.sessionId ||
        part.messageId !== delta.messageId ||
        part.type !== delta.field ||
        typeof part.text !== "string" ||
        part.text.length !== delta.baseLength
      ) {
        return { kind: "resync-required" }
      }
      if (parts === null) parts = [...view.parts]
      parts[partIndex] = {
        ...part,
        text: part.text + delta.delta,
        updatedAt: delta.createdAt,
      }
    }
    cursor = delta.seq
  }

  if (parts === null) return { kind: "applied", view }
  if (addedPart) parts.sort((left, right) => left.seq - right.seq)
  return {
    kind: "applied",
    view: { ...view, parts, cursor, syncStatus: "connected" },
  }
}

function fixture(count: number) {
  const view: DesktopSessionView = {
    cursor: 0,
    syncStatus: "connected",
    session: {
      id: "s",
      cwd: "/",
      title: "bench",
      model: "test",
      status: "idle",
      metadata: {},
      createdAt: 0,
      updatedAt: 0,
    },
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    tasks: [],
    permissions: [],
  }
  for (let index = 0; index < count; index++) {
    view.messages.push({
      id: `m${index}`,
      sessionId: "s",
      seq: index,
      role: "assistant",
      metadata: {},
      createdAt: 0,
      updatedAt: 0,
    })
    view.parts.push({
      id: `p${index}`,
      sessionId: "s",
      messageId: `m${index}`,
      seq: index,
      type: "text",
      status: "running",
      text: "",
      metadata: {},
      createdAt: 0,
      updatedAt: 0,
    })
  }
  const update = {
    sessionId: "s",
    deltas: Array.from({ length: 64 }, (_, index): DesktopSessionPartDelta => ({
      seq: index + 1,
      partId: `p${count - 1}`,
      messageId: `m${count - 1}`,
      field: "text",
      delta: "😀",
      baseLength: index * 2,
      createdAt: index,
    })),
  }
  return { view, update }
}
describe.each([2000, 20000])("64 deltas / %i history entries", (count) => {
  const { view, update } = fixture(count)
  expect(applySessionPartDeltas(view, update)).toEqual(applyLinearSessionPartDeltas(view, update))
  bench(
    "previous linear lookup",
    () => {
      applyLinearSessionPartDeltas(view, update)
    },
    { time: 300, iterations: 10 }
  )
  bench(
    "indexed batch",
    () => {
      applySessionPartDeltas(view, update)
    },
    { time: 300, iterations: 10 }
  )
})
