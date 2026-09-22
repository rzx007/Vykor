import type { DesktopSessionView } from "@shared/session-types"
import type { DesktopSessionRuntime, PendingPromptSubmission, QueuedPromptAction } from "./types"

export function classifyPromptPlacement(
  view: DesktopSessionView | null,
  runtime: DesktopSessionRuntime,
  sessionId: string
): "transcript" | "queue" {
  return sessionViewHasInFlightRun(view, sessionId) || hasUnconfirmedSubmission(runtime, sessionId)
    ? "queue"
    : "transcript"
}

export function updatePendingPromptSubmission(
  submissions: Record<string, PendingPromptSubmission>,
  submissionId: string,
  update: (submission: PendingPromptSubmission) => PendingPromptSubmission
): Record<string, PendingPromptSubmission> {
  const submission = submissions[submissionId]
  return submission ? { ...submissions, [submissionId]: update(submission) } : submissions
}

export function removePendingPromptSubmission(
  submissions: Record<string, PendingPromptSubmission>,
  submissionId: string
): Record<string, PendingPromptSubmission> {
  if (!submissions[submissionId]) return submissions
  const remaining = { ...submissions }
  delete remaining[submissionId]
  return remaining
}

export function reconcilePendingPromptSubmissions(
  submissions: Record<string, PendingPromptSubmission>,
  view: DesktopSessionView
): Record<string, PendingPromptSubmission> {
  const confirmedInputIds = new Set(view.inputs.map((input) => input.id))
  const visibleMessageIds = new Set(
    view.parts
      .filter((part) => part.type === "text" || part.type === "attachment")
      .map((part) => part.messageId)
  )
  const projectedInputIds = new Set(
    view.messages.flatMap((message) =>
      message.role === "user" && message.inputId && visibleMessageIds.has(message.id)
        ? [message.inputId]
        : []
    )
  )
  return Object.fromEntries(
    Object.entries(submissions).flatMap(([id, submission]) => {
      if (submission.sessionId !== view.session.id) return [[id, submission]]
      if (projectedInputIds.has(id)) return []
      if (confirmedInputIds.has(id)) {
        return [[id, { ...submission, phase: "accepted" as const, error: undefined }]]
      }
      return [[id, submission]]
    })
  )
}

export function reconcileQueuedPromptActions(
  actions: Record<string, QueuedPromptAction>,
  view: DesktopSessionView
): Record<string, QueuedPromptAction> {
  return Object.fromEntries(
    Object.entries(actions).filter(([, action]) => {
      if (action.sessionId !== view.session.id) return true
      const run = view.runs.find((candidate) => candidate.id === action.runId)
      return !run || run.status === "pending"
    })
  )
}

export function queuedPromptActionConfirmed(
  view: DesktopSessionView | null,
  action: QueuedPromptAction
): boolean {
  if (view?.session.id !== action.sessionId) return false
  const run = view.runs.find((candidate) => candidate.id === action.runId)
  return Boolean(run && run.status !== "pending")
}

export function queuedPromptActionKey(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`
}

function sessionViewHasInFlightRun(view: DesktopSessionView | null, sessionId: string): boolean {
  if (!view || view.session.id !== sessionId) return false
  return (
    view.session.status === "running" ||
    view.runs.some((run) => run.status === "pending" || run.status === "running")
  )
}

function hasUnconfirmedSubmission(runtime: DesktopSessionRuntime, sessionId: string): boolean {
  return Object.values(runtime.pendingPromptSubmissions).some(
    (submission) => submission.sessionId === sessionId && submission.phase !== "failed"
  )
}
