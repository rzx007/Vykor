import { z } from "zod"
import {
  composerAttachmentSchema as attachment,
  composerDraftSchema as draft,
  composerSubmissionSchema as submission,
} from "@shared/business-data-schema"
import { recoveryRecord, resetBusinessDataCache } from "@renderer/lib/business-data"
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
type RecoveredComposer = ComposerDraftState & {
  sessionRuntimes: Record<string, DesktopSessionRuntime>
}
export async function readComposerRecovery(): Promise<RecoveredComposer> {
  const storage = recoveryRecord({ kind: "composer" })
  const raw = localStorage.getItem(key)
  if (raw) {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error("business-data composer import INVALID_JSON")
    }
    const restored = decodeComposerRecovery(value)
    const ids = [
      ...new Set([
        ...Object.keys(restored.composerDraftsByScope)
          .filter((scope) => scope.startsWith("session:"))
          .map((scope) => scope.slice(8)),
        ...Object.keys(restored.sessionRuntimes),
      ]),
    ]
    const classes: Record<string, "persistent" | "memory" | "unknown"> = Object.create(null)
    for (let offset = 0; offset < ids.length; offset += 500)
      Object.assign(
        classes,
        await window.desktop.businessData.classifySessions(ids.slice(offset, offset + 500))
      )
    const unresolved = ids.filter((id) => classes[id] === "unknown")
    const filtered = {
      ...restored,
      composerDraftsByScope: Object.fromEntries(
        Object.entries(restored.composerDraftsByScope).filter(
          ([scope]) =>
            scope === "new-conversation" ||
            (scope.startsWith("session:") && classes[scope.slice(8)] === "persistent")
        )
      ),
      sessionRuntimes: Object.fromEntries(
        Object.entries(restored.sessionRuntimes).filter(([id]) => classes[id] === "persistent")
      ),
    }
    await storage.importLegacy(raw, exportComposerRecovery(filtered), unresolved)
  }
  return decodeComposerRecovery((await storage.read())?.value)
}
export function decodeComposerRecovery(raw: unknown): RecoveredComposer {
  const result: RecoveredComposer = {
    composerDraftsByScope: {},
    sessionRuntimes: {},
  }
  try {
    const envelope = z
      .object({
        version: z.literal(1),
        drafts: z.record(z.string(), z.unknown()),
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

export function exportComposerRecovery(state: RecoveryState) {
  const drafts = Object.fromEntries(
    Object.entries(state.composerDraftsByScope).filter(
      ([scope, value]) =>
        !scope.startsWith("linked-chat:") &&
        !isTransientComposerSession(state, scope.replace(/^session:/, "")) &&
        (value.document.items.length ||
          value.attachments.length ||
          value.textSelections?.length ||
          value.browserAnnotations?.length)
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
  return { version: 1 as const, drafts, submissions }
}

export async function saveComposerRecovery(state: RecoveryState): Promise<boolean> {
  try {
    await recoveryRecord({ kind: "composer" }).write(exportComposerRecovery(state))
    return true
  } catch {
    return false
  }
}

export function clearComposerRecovery(): void {
  // A data-root switch clears only runtime classification; old source copies stay intact.
  transientSessions.clear()
  resetBusinessDataCache()
}
