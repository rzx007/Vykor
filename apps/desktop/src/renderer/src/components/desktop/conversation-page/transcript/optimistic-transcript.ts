import { queuedPromptActionKey } from "@renderer/stores/desktop-session/pending-prompt-state"
import type { PendingPromptSubmission, QueuedPromptAction } from "@renderer/stores/desktop-session/types"
import type {
  DesktopSessionInput,
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
  DesktopSessionView,
} from "@shared/session-types"

const optimisticEntries = new WeakMap<PendingPromptSubmission, {
  message: DesktopSessionMessage
  parts: DesktopSessionPart[]
}>()

export function mergeSessionOptimisticTranscript(
  view: DesktopSessionView | null,
  submissions: PendingPromptSubmission[],
  queuedActions: Record<string, QueuedPromptAction>
) {
  const handoff = derivePendingHandoffSubmission(
    view?.inputs ?? [],
    view?.runs ?? [],
    queuedActions
  )
  const transcriptSubmissions =
    handoff &&
    !submissions.some(
      (submission) => submission.id === handoff.submission.id && submission.placement === "transcript" &&
        submission.phase !== "failed"
    )
      ? [...submissions, handoff.submission]
      : submissions
  return {
    ...mergeOptimisticTranscript(view?.messages ?? [], view?.parts ?? [], transcriptSubmissions),
    handoffRunId: handoff?.runId,
  }
}

export function derivePendingHandoffSubmission(
  inputs: DesktopSessionInput[],
  runs: DesktopSessionRun[],
  queuedActions: Record<string, QueuedPromptAction> = {}
): { runId: string; submission: PendingPromptSubmission } | undefined {
  if (runs.some((run) => run.status === "running")) return undefined

  const nextRun = runs
    .filter((run) => run.status === "pending" && run.inputId)
    .sort((left, right) => left.createdAt - right.createdAt)[0]
  if (!nextRun?.inputId) return undefined
  const promotion = nextRun.metadata.promotion as { kind?: string } | undefined
  if (promotion?.kind === "steering" || queuedActions[queuedPromptActionKey(nextRun.sessionId, nextRun.id)])
    return undefined

  const input = inputs.find((candidate) => candidate.id === nextRun.inputId)
  if (!input) return undefined
  return {
    runId: nextRun.id,
    submission: {
      id: input.id,
      sessionId: input.sessionId,
      content: input.content,
      items: input.items,
      attachments: [...input.attachments]
        .sort((left, right) => left.seq - right.seq)
        .map(({ assetId, intent, displayName, mediaType, sizeBytes }) => ({
          assetId,
          intent,
          displayName,
          mediaType,
          sizeBytes,
        })),
      createdAt: input.createdAt,
      phase: "accepted",
      placement: "transcript",
    },
  }
}

export function mergeOptimisticTranscript(
  messages: DesktopSessionMessage[],
  parts: DesktopSessionPart[],
  submissions: PendingPromptSubmission[]
): { messages: DesktopSessionMessage[]; parts: DesktopSessionPart[] } {
  const candidates = submissions.filter(
    (submission) => submission.placement === "transcript" && submission.phase !== "failed"
  )
  if (candidates.length === 0) return { messages, parts }

  const visibleMessageIds = new Set(
    parts
      .filter((part) => part.type === "text" || part.type === "attachment")
      .map((part) => part.messageId)
  )
  const authoritativeInputIds = new Set(
    messages.flatMap((message) =>
      message.role === "user" && message.inputId && visibleMessageIds.has(message.id)
        ? [message.inputId]
        : []
    )
  )
  const optimistic = candidates
    .filter((submission) => !authoritativeInputIds.has(submission.id))
    .map(optimisticEntry)
  if (optimistic.length === 0) return { messages, parts }

  return {
    messages: [...messages, ...optimistic.map((entry) => entry.message)],
    parts: [...parts, ...optimistic.flatMap((entry) => entry.parts)],
  }
}

function optimisticEntry(submission: PendingPromptSubmission) {
  const cached = optimisticEntries.get(submission)
  if (cached) return cached
  const message: DesktopSessionMessage = {
    id: `optimistic-message:${submission.id}`,
    sessionId: submission.sessionId,
    seq: Number.MAX_SAFE_INTEGER,
    role: "user",
    inputId: submission.id,
    metadata: {
      optimistic: true,
      ...(submission.delivery === "steer" ? { pendingFollowUp: submission.phase } : {}),
    },
    createdAt: submission.createdAt,
    updatedAt: submission.createdAt,
  }
  const entry = { message, parts: optimisticParts(submission) }
  optimisticEntries.set(submission, entry)
  return entry
}

function optimisticParts(submission: PendingPromptSubmission): DesktopSessionPart[] {
  const messageId = `optimistic-message:${submission.id}`
  const items = submission.items
  const content = submission.content + (submission.browserAnnotationContext ?? "")
  const textParts: DesktopSessionPart[] =
    content || (Array.isArray(items) && items.length > 0)
      ? [
          {
            id: `optimistic-part:${submission.id}`,
            sessionId: submission.sessionId,
            messageId,
            seq: 0,
            type: "text",
            status: "completed",
            text: content,
            metadata: {
              optimistic: true,
              ...(Array.isArray(items) ? { items } : {}),
            },
            createdAt: submission.createdAt,
            updatedAt: submission.createdAt,
          },
        ]
      : []
  const offset = textParts.length
  return [
    ...textParts,
    ...submission.attachments.map<DesktopSessionPart>((attachment, index) => {
      const seq = offset + index
      return {
        id: `optimistic-attachment:${submission.id}:${attachment.assetId}:${seq}`,
        sessionId: submission.sessionId,
        messageId,
        seq,
        type: "attachment",
        status: "completed",
        assetId: attachment.assetId,
        intent: attachment.intent,
        displayName: attachment.displayName,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        metadata: { optimistic: true },
        createdAt: submission.createdAt,
        updatedAt: submission.createdAt,
      }
    }),
  ]
}
