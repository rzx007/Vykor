import type {
  DesktopAttachmentCandidate,
  DesktopAttachmentDraft,
  DesktopAttachmentUploadEvent,
} from "@shared/attachment-types"
import {
  composerDocument,
  emptyComposerDocument,
  selectComposerDocumentText,
  type ComposerDocument,
} from "./composer-document"

export const NEW_CONVERSATION_SCOPE = "new-conversation"

export interface DesktopComposerDraft {
  document: ComposerDocument
  attachments: DesktopAttachmentDraft[]
  textSelections?: Array<{ id: string; text: string }>
}

export interface ComposerDraftState {
  composerDraftsByScope: Record<string, DesktopComposerDraft>
}

const emptyDraftAttachments: DesktopAttachmentDraft[] = []

export function emptyComposerDraftState(): ComposerDraftState {
  return { composerDraftsByScope: {} }
}

export function sessionComposerScope(sessionId: string): string {
  return `session:${sessionId}`
}

export function selectDraftText(state: ComposerDraftState, scope: string): string {
  return selectComposerDocumentText(selectDraftDocument(state, scope))
}

export function selectDraftDocument(state: ComposerDraftState, scope: string): ComposerDocument {
  return state.composerDraftsByScope[scope]?.document ?? emptyComposerDocument
}

export function selectDraftAttachments(
  state: ComposerDraftState,
  scope: string
): DesktopAttachmentDraft[] {
  return state.composerDraftsByScope[scope]?.attachments ?? emptyDraftAttachments
}

export function setDraftText(
  state: ComposerDraftState,
  scope: string,
  text: string
): ComposerDraftState {
  return setDraftDocument(state, scope, composerDocument([{ type: "text", text }]))
}

export function setDraftDocument(
  state: ComposerDraftState,
  scope: string,
  document: ComposerDocument
): ComposerDraftState {
  const current = draftForScope(state, scope)
  if (JSON.stringify(current.document) === JSON.stringify(document)) return state
  return replaceScope(state, scope, { ...current, document })
}

export function addCandidates(
  state: ComposerDraftState,
  scope: string,
  candidates: readonly DesktopAttachmentCandidate[]
): ComposerDraftState {
  if (candidates.length === 0) return state
  const current = draftForScope(state, scope)
  const additions = candidates.map<DesktopAttachmentDraft>((candidate) => ({
    draftId: candidate.draftId,
    taskId: "",
    displayName: candidate.displayName,
    declaredMediaType: candidate.declaredMediaType,
    sizeBytes: candidate.sizeBytes,
    status: "uploading",
    bytesUploaded: 0,
    progress: candidate.sizeBytes > 0 ? 0 : null,
  }))
  return replaceScope(state, scope, {
    ...current,
    attachments: [...current.attachments, ...additions],
  })
}

export function beginUpload(
  state: ComposerDraftState,
  scope: string,
  draftId: string,
  taskId: string
): ComposerDraftState {
  return updateAttachment(state, scope, draftId, (attachment) => {
    const next: DesktopAttachmentDraft = {
      ...attachment,
      taskId,
      status: "uploading",
      bytesUploaded: 0,
      progress: attachment.sizeBytes > 0 ? 0 : null,
    }
    delete next.assetId
    delete next.mediaType
    delete next.error
    return next
  })
}

export function applyUploadEvent(
  state: ComposerDraftState,
  scope: string,
  event: DesktopAttachmentUploadEvent
): ComposerDraftState {
  const attachment = selectDraftAttachments(state, scope).find(
    (item) => item.draftId === event.draftId
  )
  if (!attachment || attachment.taskId !== event.taskId) return state
  return updateAttachment(state, scope, event.draftId, (current) => {
    if (event.type === "progress") {
      const totalBytes = event.totalBytes > 0 ? event.totalBytes : current.sizeBytes
      return {
        ...current,
        bytesUploaded: Math.max(current.bytesUploaded, event.bytesRead),
        progress: totalBytes > 0 ? Math.min(1, Math.max(0, event.bytesRead / totalBytes)) : null,
      }
    }
    if (event.type === "success") {
      return {
        ...current,
        status: "ready",
        assetId: event.assetId,
        displayName: event.displayName,
        mediaType: event.mediaType,
        sizeBytes: event.sizeBytes,
        bytesUploaded: event.sizeBytes,
        progress: 1,
        error: undefined,
      }
    }
    if (event.type === "failed") {
      return { ...current, status: "failed", error: event.error }
    }
    return { ...current, status: "cancelled" }
  })
}

export function removeDraftAttachment(
  state: ComposerDraftState,
  scope: string,
  draftId: string
): ComposerDraftState {
  const current = state.composerDraftsByScope[scope]
  if (!current) return state
  const attachments = current.attachments.filter((item) => item.draftId !== draftId)
  if (attachments.length === current.attachments.length) return state
  return replaceScope(state, scope, { ...current, attachments })
}

export function resetComposerScope(state: ComposerDraftState, scope: string): ComposerDraftState {
  if (!state.composerDraftsByScope[scope]) return state
  const remaining = { ...state.composerDraftsByScope }
  delete remaining[scope]
  return { composerDraftsByScope: remaining }
}

export function migrateComposerScope(
  state: ComposerDraftState,
  fromScope: string,
  toScope: string
): ComposerDraftState {
  if (fromScope === toScope) return state
  const source = state.composerDraftsByScope[fromScope]
  if (!source) return state
  const remaining = { ...state.composerDraftsByScope }
  delete remaining[fromScope]
  return {
    composerDraftsByScope: {
      ...remaining,
      [toScope]: source,
    },
  }
}

export function findUploadEventScope(
  state: ComposerDraftState,
  draftId: string,
  taskId: string
): string | null {
  for (const [scope, draft] of Object.entries(state.composerDraftsByScope)) {
    if (draft.attachments.some((item) => item.draftId === draftId && item.taskId === taskId)) {
      return scope
    }
  }
  return null
}

function draftForScope(state: ComposerDraftState, scope: string): DesktopComposerDraft {
  return state.composerDraftsByScope[scope] ?? { document: emptyComposerDocument, attachments: [] }
}

function replaceScope(
  state: ComposerDraftState,
  scope: string,
  draft: DesktopComposerDraft
): ComposerDraftState {
  return {
    composerDraftsByScope: {
      ...state.composerDraftsByScope,
      [scope]: draft,
    },
  }
}

function updateAttachment(
  state: ComposerDraftState,
  scope: string,
  draftId: string,
  update: (attachment: DesktopAttachmentDraft) => DesktopAttachmentDraft
): ComposerDraftState {
  const current = state.composerDraftsByScope[scope]
  if (!current) return state
  const index = current.attachments.findIndex((item) => item.draftId === draftId)
  if (index < 0) return state
  const attachments = [...current.attachments]
  attachments[index] = update(attachments[index]!)
  return replaceScope(state, scope, { ...current, attachments })
}
