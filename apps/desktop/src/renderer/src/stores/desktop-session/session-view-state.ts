import type {
  DesktopSessionPart,
  DesktopSessionPartDelta,
  DesktopSessionView,
} from "@shared/session-types"
import {
  reconcilePendingPromptSubmissions,
  reconcileQueuedPromptActions,
} from "./pending-prompt-state"
import type { DesktopOperation, DesktopSessionRuntime } from "./types"

export type ApplySessionPartDeltasResult =
  | { kind: "applied"; view: DesktopSessionView }
  | { kind: "resync-required" }

export function applySessionPartDeltas(
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

export function acceptActiveSessionView(
  activeSessionId: string | null,
  current: DesktopSessionView | null,
  incoming: DesktopSessionView
): DesktopSessionView | null {
  if (activeSessionId !== incoming.session.id) return current
  if (current?.session.id === incoming.session.id && current.cursor > incoming.cursor)
    return current
  return incoming
}

export function reconcileRuntimeWithView(
  runtime: DesktopSessionRuntime,
  view: DesktopSessionView
): DesktopSessionRuntime {
  const confirmedEntityIds = new Set([
    ...view.inputs.map((input) => input.id),
    ...view.runs.map((run) => run.id),
  ])
  return {
    ...runtime,
    operations: Object.fromEntries(
      Object.entries(runtime.operations).filter(
        ([operationId, operation]) =>
          operation.sessionId !== view.session.id ||
          !operationConfirmedByView(operation, operationId, confirmedEntityIds, view)
      )
    ),
    pendingPromptSubmissions: reconcilePendingPromptSubmissions(
      runtime.pendingPromptSubmissions,
      view
    ),
    pendingPromptEdit:
      runtime.pendingPromptEdit && confirmedEntityIds.has(runtime.pendingPromptEdit.id)
        ? null
        : runtime.pendingPromptEdit,
    queuedPromptActions: reconcileQueuedPromptActions(runtime.queuedPromptActions, view),
  }
}

export function releaseAcknowledgedRuntime(runtime: DesktopSessionRuntime): DesktopSessionRuntime {
  return {
    ...runtime,
    operations: Object.fromEntries(
      Object.entries(runtime.operations).filter(
        ([, operation]) => operation.phase !== "acknowledged"
      )
    ),
    pendingPromptSubmissions: Object.fromEntries(
      Object.entries(runtime.pendingPromptSubmissions).filter(
        ([, submission]) => submission.phase !== "accepted"
      )
    ),
    queuedPromptActions: Object.fromEntries(
      Object.entries(runtime.queuedPromptActions).filter(
        ([, action]) => action.phase !== "acknowledged"
      )
    ),
  }
}

function operationConfirmedByView(
  operation: DesktopOperation,
  operationId: string,
  confirmedInputIds: Set<string>,
  view: DesktopSessionView
): boolean {
  switch (operation.kind) {
    case "create-session":
    case "open-session":
      return true
    case "send-prompt":
    case "edit-prompt":
      return confirmedInputIds.has(operationId)
    case "promote-prompt":
    case "cancel-prompt": {
      const run = view.runs.find((candidate) => candidate.id === operation.target)
      return Boolean(run && run.status !== "pending")
    }
    case "interrupt-run": {
      const run = view.runs.find((candidate) => candidate.id === operation.target)
      return Boolean(run && run.status !== "pending" && run.status !== "running")
    }
    case "reply-permission": {
      const permission = view.permissions.find((candidate) => candidate.id === operation.target)
      return Boolean(permission && permission.status !== "pending")
    }
    case "project-action":
      return false
  }
}
