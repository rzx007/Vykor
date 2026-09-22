import type { PendingPromptSubmission } from "@renderer/stores/desktop-session/types"
import type {
  DesktopSessionInput,
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"

export function derivePendingHandoffSubmission(
  messages: DesktopSessionMessage[],
  inputs: DesktopSessionInput[],
  runs: DesktopSessionRun[],
  excludedRunIds: ReadonlySet<string> = new Set()
): PendingPromptSubmission | undefined {
  if (runs.some((run) => run.status === "running")) return undefined

  const nextRun = runs
    .filter((run) => run.status === "pending" && run.inputId && !excludedRunIds.has(run.id))
    .sort((left, right) => left.createdAt - right.createdAt)[0]
  if (!nextRun?.inputId) return undefined
  if (messages.some((message) => message.role === "user" && message.inputId === nextRun.inputId)) {
    return undefined
  }

  const input = inputs.find((candidate) => candidate.id === nextRun.inputId)
  if (!input) return undefined
  return {
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
  }
}

export function mergeOptimisticTranscript(
  messages: DesktopSessionMessage[],
  parts: DesktopSessionPart[],
  submissions: PendingPromptSubmission[]
): { messages: DesktopSessionMessage[]; parts: DesktopSessionPart[] } {
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
  const optimistic = submissions.filter(
    (submission) =>
      submission.placement === "transcript" &&
      submission.phase !== "failed" &&
      !authoritativeInputIds.has(submission.id)
  )

  return {
    messages: [
      ...messages,
      ...optimistic.map<DesktopSessionMessage>((submission) => ({
        id: `optimistic-message:${submission.id}`,
        sessionId: submission.sessionId,
        seq: Number.MAX_SAFE_INTEGER,
        role: "user",
        inputId: submission.id,
        metadata: { optimistic: true },
        createdAt: submission.createdAt,
        updatedAt: submission.createdAt,
      })),
    ],
    parts: [...parts, ...optimistic.flatMap(optimisticParts)],
  }
}

function optimisticParts(submission: PendingPromptSubmission): DesktopSessionPart[] {
  const messageId = `optimistic-message:${submission.id}`
  const items = submission.items
  const textParts: DesktopSessionPart[] =
    submission.content || (Array.isArray(items) && items.length > 0)
      ? [
          {
            id: `optimistic-part:${submission.id}`,
            sessionId: submission.sessionId,
            messageId,
            seq: 0,
            type: "text",
            status: "completed",
            text: submission.content,
            metadata: {
              optimistic: true,
              ...(Array.isArray(items)
                ? { items }
                : {}),
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
