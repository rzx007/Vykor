import { z } from "zod"
import {
  composerDocument,
  sameComposerDocument,
  selectComposerDocumentText,
} from "./composer-document"
import type { ComposerDraftState } from "./composer-draft-state"
import { createEmptySessionRuntime } from "./operation-state"
import type { DesktopSessionRuntime, DesktopSessionState, PendingPromptSubmission } from "./types"

const key = "vykor.desktop.composer-recovery.v1"
const transientSessions = new Set<string>()

export function markComposerSessionTransient(sessionId: string): void {
  transientSessions.add(sessionId)
}
const string = z.string()
const item = z.union([
  z.object({ type: z.literal("text"), text: string }),
  z.object({
    type: z.literal("mention"),
    name: string,
    path: string,
    displayName: string.optional(),
  }),
  z.object({
    type: z.literal("skill"),
    name: string,
    path: string,
    displayName: string.optional(),
    source: z.enum(["bundled", "user", "project", "plugin"]).optional(),
  }),
  z.object({
    type: z.literal("context"),
    kind: z.literal("conversation"),
    id: string,
    displayName: string,
  }),
  z.object({
    type: z.literal("capability"),
    kind: z.literal("plugin"),
    pluginId: string,
    displayName: string,
  }),
  z.object({
    type: z.literal("capability"),
    kind: z.literal("plugin_agent"),
    pluginId: string,
    agentId: string,
    displayName: string,
  }),
])
const document = z.object({ version: z.literal(1), items: z.array(item) })
const attachment = z.object({
  draftId: string,
  taskId: string,
  displayName: string,
  declaredMediaType: string,
  sizeBytes: z.number().nonnegative(),
  bytesUploaded: z.number().nonnegative(),
  progress: z.number().nullable(),
  status: z.enum(["uploading", "ready", "failed", "cancelled"]),
  assetId: string.optional(),
  mediaType: string.optional(),
  error: z.object({ code: string, message: string, retryable: z.boolean() }).optional(),
})
const draft = z.object({
  document,
  attachments: z.array(attachment),
  textSelections: z.array(z.object({ id: string, text: string })).optional(),
})
const submission = z.object({
  id: string.min(1),
  sessionId: string.min(1),
  items: z.array(item),
  attachments: z.array(
    z.object({
      assetId: string.min(1),
      intent: z.enum(["auto", "vision", "ocr", "document", "tool_resource", "workspace_reference"]),
      displayName: string,
      mediaType: string,
      sizeBytes: z.number().nonnegative(),
    })
  ),
  createdAt: z.number(),
  placement: z.enum(["transcript", "queue"]),
  error: string.optional(),
  dismissed: z.boolean().optional(),
  pluginAppContextIds: z.array(string).optional(),
  draftDocument: document.optional(),
  draftAttachmentIds: z.array(string).optional(),
})

export function readComposerRecovery(): ComposerDraftState & {
  sessionRuntimes: Record<string, DesktopSessionRuntime>
} {
  const result: ReturnType<typeof readComposerRecovery> = {
    composerDraftsByScope: {},
    sessionRuntimes: {},
  }
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null")
    const envelope = z
      .object({
        version: z.literal(1),
        drafts: z.record(string, z.unknown()),
        submissions: z.array(z.unknown()),
      })
      .safeParse(raw)
    if (!envelope.success) return result
    result.composerDraftsByScope = Object.fromEntries(
      Object.entries(envelope.data.drafts).flatMap(([scope, value]) => {
        const parsed = draft.safeParse(value)
        if (!parsed.success) return []
        return [
          [scope, { ...parsed.data, attachments: parsed.data.attachments.map(restoredAttachment) }],
        ]
      })
    )
    for (const value of envelope.data.submissions) {
      const parsed = submission.safeParse(value)
      if (!parsed.success) continue
      const pending: PendingPromptSubmission = {
        ...parsed.data,
        content: selectComposerDocumentText(composerDocument(parsed.data.items)),
        phase: "failed",
        error: "上次发送的结果尚未确认，请核对状态后重试。",
      }
      const runtime = Object.hasOwn(result.sessionRuntimes, pending.sessionId)
        ? result.sessionRuntimes[pending.sessionId]!
        : createEmptySessionRuntime()
      result.sessionRuntimes = {
        ...result.sessionRuntimes,
        [pending.sessionId]: {
          ...runtime,
          pendingPromptSubmissions: { ...runtime.pendingPromptSubmissions, [pending.id]: pending },
        },
      }
    }
  } catch {
    /* Damaged or unavailable storage must not prevent startup. */
  }
  return result
}

function restoredAttachment(value: z.infer<typeof attachment>): z.infer<typeof attachment> {
  if (value.status === "ready" && value.assetId && value.mediaType) return value
  return {
    ...value,
    status: "failed",
    progress: null,
    error: {
      code: "source_unavailable",
      message: "上传未完成或本地文件已失效，请移除此附件后重新选择。",
      retryable: false,
    },
  }
}

type RecoveryState = ComposerDraftState & {
  sessionRuntimes: Record<string, DesktopSessionRuntime>
} & Partial<Pick<DesktopSessionState, "sessions" | "archivedSessions" | "sessionView">>

export function isTransientComposerSession(state: RecoveryState, sessionId: string): boolean {
  return (
    transientSessions.has(sessionId) ||
    (state.sessionView?.session.id === sessionId &&
      state.sessionView.session.storage === "memory") ||
    [...(state.sessions ?? []), ...(state.archivedSessions ?? [])].some(
      (session) => session.id === sessionId && session.storage === "memory"
    )
  )
}

export function saveComposerRecovery(state: RecoveryState): boolean {
  try {
    const drafts = Object.fromEntries(
      Object.entries(state.composerDraftsByScope).filter(
        ([scope, value]) =>
          !scope.startsWith("linked-chat:") &&
          !isTransientComposerSession(state, scope.replace(/^session:/, "")) &&
          (value.document.items.length || value.attachments.length || value.textSelections?.length)
      )
    )
    const submissions = Object.entries(state.sessionRuntimes)
      .filter(([id]) => !isTransientComposerSession(state, id))
      .flatMap(([, runtime]) => Object.values(runtime.pendingPromptSubmissions))
      .map((pending) => {
        const saved: Partial<PendingPromptSubmission> = { ...pending }
        delete saved.content
        delete saved.phase
        if (
          pending.draftDocument &&
          sameComposerDocument(pending.draftDocument, composerDocument(pending.items))
        )
          delete saved.draftDocument
        return saved
      })
    if (!Object.keys(drafts).length && !submissions.length) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify({ version: 1, drafts, submissions }))
    return true
  } catch {
    return false
  }
}

export function clearComposerRecovery(): void {
  transientSessions.clear()
  try {
    localStorage.removeItem(key)
  } catch {
    /* Storage may be unavailable. */
  }
}
