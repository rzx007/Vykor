import type { DesktopAttachmentDraft } from "@shared/attachment-types"
import type { DesktopSessionMessage, DesktopSessionPart } from "@shared/session-types"
import type { ImageGallery, ImageSource } from "./image-source"

/** Called on open: the loaded transcript data includes images outside the virtual DOM. */
export function collectConversationImageGallery(
  messages: readonly DesktopSessionMessage[],
  parts: readonly DesktopSessionPart[],
  composerScope?: string,
  canFeedback?: () => boolean
): ImageGallery | undefined {
  const sessionId = messages[0]?.sessionId
  if (!sessionId) return undefined
  const messageOrder = new Map(
    messages
      .filter((message) => message.sessionId === sessionId)
      .map((message) => [message.id, message.seq])
  )
  const seen = new Set<string>()
  const sources: ImageSource[] = []
  const images = parts
    .filter(
      (part) =>
        part.type === "attachment" &&
        part.status === "completed" &&
        part.sessionId === sessionId &&
        messageOrder.has(part.messageId) &&
        part.mediaType.startsWith("image/") &&
        Boolean(part.assetId)
    )
    .sort(
      (left, right) =>
        messageOrder.get(left.messageId)! - messageOrder.get(right.messageId)! ||
        left.seq - right.seq
    )
  for (const part of images) {
    if (part.type !== "attachment" || seen.has(part.assetId)) continue
    seen.add(part.assetId)
    sources.push({
      kind: "attachment",
      assetId: part.assetId,
      name: part.displayName,
      readOnly: !composerScope,
    })
  }
  return { id: `conversation:${sessionId}`, sources, composerScope, canFeedback }
}

export function collectDraftImageGallery(
  attachments: readonly DesktopAttachmentDraft[],
  composerScope?: string,
  readOnly = false,
  canFeedback?: () => boolean
): ImageGallery | undefined {
  if (!composerScope) return undefined
  const seen = new Set<string>()
  const sources: ImageSource[] = []
  for (const attachment of attachments) {
    if (
      attachment.status !== "ready" ||
      !attachment.assetId ||
      seen.has(attachment.assetId) ||
      !(attachment.mediaType ?? attachment.declaredMediaType).startsWith("image/")
    )
      continue
    seen.add(attachment.assetId)
    sources.push({
      kind: "attachment",
      assetId: attachment.assetId,
      name: attachment.displayName,
      draftId: attachment.draftId,
      readOnly,
    })
  }
  return { id: `draft:${composerScope}`, sources, composerScope, canFeedback }
}
