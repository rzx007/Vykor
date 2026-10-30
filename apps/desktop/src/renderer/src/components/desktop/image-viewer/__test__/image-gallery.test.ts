import { describe, expect, it } from "vitest"
import type { DesktopAttachmentDraft } from "@shared/attachment-types"
import type { DesktopAttachmentSessionPart, DesktopSessionMessage } from "@shared/session-types"
import { collectConversationImageGallery, collectDraftImageGallery } from "../image-gallery"

const message = (id: string, seq: number, sessionId = "side-real"): DesktopSessionMessage => ({
  id,
  seq,
  sessionId,
  role: "user",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
})
const image = (
  assetId: string,
  messageId: string,
  seq: number,
  extra: Partial<DesktopAttachmentSessionPart> = {}
): DesktopAttachmentSessionPart => ({
  id: `${messageId}-${seq}`,
  sessionId: "side-real",
  messageId,
  seq,
  type: "attachment",
  status: "completed",
  assetId,
  displayName: `${assetId}.png`,
  mediaType: "image/png",
  sizeBytes: 1,
  intent: "vision",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
  ...extra,
})
const draft = (
  assetId: string,
  extra: Partial<DesktopAttachmentDraft> = {}
): DesktopAttachmentDraft => ({
  draftId: `draft-${assetId}`,
  taskId: "upload",
  assetId,
  displayName: `${assetId}.png`,
  declaredMediaType: "image/png",
  mediaType: "image/png",
  sizeBytes: 1,
  status: "ready",
  bytesUploaded: 1,
  progress: 1,
  ...extra,
})

describe("conversation image snapshots", () => {
  it("sorts loaded images by message then part sequence, deduplicates assets, and excludes foreign or unfinished parts", () => {
    const gallery = collectConversationImageGallery(
      [message("later", 20), message("first", 10), message("foreign", 1, "main")],
      [
        image("last", "later", 2),
        image("second", "first", 3),
        image("first", "first", 1),
        image("first", "later", 1),
        image("streaming", "later", 3, { status: "running" }),
        image("failed", "later", 4, { status: "failed" }),
        image("document", "first", 2, { mediaType: "application/pdf" }),
        image("foreign", "foreign", 1, { sessionId: "main" }),
        image("orphan", "missing", 1),
      ],
      "session:side-real"
    )!
    expect(gallery.id).toBe("conversation:side-real")
    expect(gallery.composerScope).toBe("session:side-real")
    expect(gallery.sources.map((source) => source.kind === "attachment" && source.assetId)).toEqual(
      ["first", "second", "last"]
    )
  })

  it("keeps child-session images read-only when no feedback composer scope was supplied", () => {
    const gallery = collectConversationImageGallery(
      [message("child", 1)],
      [image("result", "child", 1)]
    )!
    expect(gallery.composerScope).toBeUndefined()
    expect(gallery.sources[0]?.readOnly).toBe(true)
    expect(collectConversationImageGallery([], [image("orphan", "child", 1)])).toBeUndefined()
  })
})

describe("draft image snapshots", () => {
  it("uses only ready image assets in the supplied draft scope and retains their draft IDs", () => {
    const gallery = collectDraftImageGallery(
      [
        draft("first"),
        draft("uploading", { status: "uploading" }),
        draft("failed", { status: "failed" }),
        draft("no-asset", { assetId: undefined }),
        draft("pdf", { mediaType: "application/pdf" }),
        draft("first", { draftId: "duplicate" }),
        draft("last"),
      ],
      "linked-chat:source"
    )!
    expect(gallery.id).toBe("draft:linked-chat:source")
    expect(gallery.composerScope).toBe("linked-chat:source")
    expect(gallery.sources).toEqual([
      {
        kind: "attachment",
        assetId: "first",
        name: "first.png",
        draftId: "draft-first",
        readOnly: false,
      },
      {
        kind: "attachment",
        assetId: "last",
        name: "last.png",
        draftId: "draft-last",
        readOnly: false,
      },
    ])
    expect(collectDraftImageGallery([draft("other")], "session:other")?.id).toBe(
      "draft:session:other"
    )
  })

  it("does not infer an unknown draft scope and retains explicit read-only access", () => {
    expect(collectDraftImageGallery([draft("first")])).toBeUndefined()
    expect(
      collectDraftImageGallery([draft("first")], "session:read-only", true)?.sources[0]?.readOnly
    ).toBe(true)
  })

  it("retains the caller's live feedback guard in each snapshot", () => {
    let valid = true
    const canFeedback = () => valid
    const conversation = collectConversationImageGallery(
      [message("message", 1)],
      [image("result", "message", 1)],
      "session:side",
      canFeedback
    )!
    const unsent = collectDraftImageGallery([draft("result")], "session:side", false, canFeedback)!
    expect(conversation.canFeedback).toBe(canFeedback)
    expect(unsent.canFeedback).toBe(canFeedback)
    valid = false
    expect(conversation.canFeedback?.()).toBe(false)
    expect(unsent.canFeedback?.()).toBe(false)
  })
})
