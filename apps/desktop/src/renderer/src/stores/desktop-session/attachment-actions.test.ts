import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopAttachmentCandidate } from "@shared/attachment-types"
import { resetDesktopSessionStore } from "./store-test-fixtures"
import { useDesktopSessionStore } from "./store"

const candidate: DesktopAttachmentCandidate = {
  draftId: "draft-file",
  sourceToken: "source-file",
  displayName: "report.pdf",
  declaredMediaType: "application/pdf",
  sizeBytes: 100,
}

describe("desktop attachment actions", () => {
  beforeEach(() => {
    resetDesktopSessionStore()
    useDesktopSessionStore.setState({
      attachmentSupport: {
        daemonSupported: true,
        interactionEnabled: true,
        uploadModes: ["single"],
        limits: {
          maxFilesPerPrompt: 20,
          maxBytesPerFile: 1_000,
          maxBytesPerPrompt: 2_000,
          maxSessionReferencedBytes: 10_000,
          resumableThresholdBytes: 500,
          uploadSessionTtlMs: 1_000,
          stagingTtlMs: 1_000,
        },
      },
    })
  })

  it("adds numbered image feedback to its captured composer without losing references or sending", async () => {
    const scope = "session:a"
    const reference = {
      type: "mention" as const,
      displayName: "screen.tsx",
      name: "screen.tsx",
      path: "screen.tsx",
    }
    useDesktopSessionStore.setState({
      activeSessionId: "b",
      composerDraftsByScope: {
        [scope]: {
          document: { version: 1, items: [reference, { type: "text", text: "已有意见" }] },
          attachments: [],
        },
      },
    })
    vi.stubGlobal("window", {
      desktop: { attachments: { uploadClipboardImage: vi.fn(async () => {}) } },
    })
    await useDesktopSessionStore.getState().addImageFeedback(scope, {
      original: {
        bytes: new Uint8Array([1]).buffer,
        mediaType: "image/png",
        displayName: "screen.png",
      },
      marked: {
        bytes: new Uint8Array([2]).buffer,
        mediaType: "image/png",
        displayName: "screen-批注.png",
      },
      text: "1. 增加间距",
    })
    const state = useDesktopSessionStore.getState()
    expect(state.composerDraftsByScope[scope]!.document.items[0]).toEqual(reference)
    expect(state.composerDraftsByScope[scope]!.document.items[1]).toEqual({
      type: "text",
      text: "已有意见\n\n1. 增加间距",
    })
    expect(state.composerDraftsByScope[scope]!.attachments.map((a) => a.displayName)).toEqual([
      "screen.png",
      "screen-批注.png",
    ])
    expect(state.composerDraftsByScope["session:b"]).toBeUndefined()
  })

  it("does not change a draft when image feedback attachments are disabled", async () => {
    useDesktopSessionStore.setState({
      attachmentSupport: {
        ...useDesktopSessionStore.getState().attachmentSupport!,
        interactionEnabled: false,
      },
    })
    await expect(
      useDesktopSessionStore.getState().addImageFeedback("session:a", {
        original: { bytes: new ArrayBuffer(1), mediaType: "image/png", displayName: "a.png" },
        marked: { bytes: new ArrayBuffer(1), mediaType: "image/png", displayName: "b.png" },
        text: "意见",
      })
    ).rejects.toThrow()
    expect(useDesktopSessionStore.getState().composerDraftsByScope).toEqual({})
  })

  it("adds picked candidates in order and sets the task id before starting each upload", async () => {
    const startUpload = vi.fn(async (input: { taskId: string }) => ({ taskId: input.taskId }))
    vi.stubGlobal("window", {
      desktop: {
        attachments: {
          pickFiles: vi.fn(async () => [candidate]),
          startUpload,
        },
      },
    })

    await useDesktopSessionStore.getState().pickAttachmentFiles("session:a")

    const [draft] =
      useDesktopSessionStore.getState().composerDraftsByScope["session:a"]!.attachments
    expect(draft).toMatchObject({
      draftId: candidate.draftId,
      taskId: expect.any(String),
      status: "uploading",
    })
    expect(startUpload).toHaveBeenCalledWith({
      draftId: candidate.draftId,
      taskId: draft!.taskId,
      sourceToken: candidate.sourceToken,
    })
  })

  it("routes completion, retries with a new task, and ignores a late old-task failure", async () => {
    const retryUpload = vi.fn(async (input: { taskId: string }) => ({ taskId: input.taskId }))
    vi.stubGlobal("window", {
      desktop: { attachments: { retryUpload } },
    })
    useDesktopSessionStore.setState({
      composerDraftsByScope: {
        "session:a": {
          document: { version: 1, items: [] },
          attachments: [
            {
              draftId: candidate.draftId,
              taskId: "task-old",
              displayName: candidate.displayName,
              declaredMediaType: candidate.declaredMediaType,
              sizeBytes: candidate.sizeBytes,
              status: "failed",
              bytesUploaded: 10,
              progress: 0.1,
              error: { code: "offline", message: "离线", retryable: true },
            },
          ],
        },
      },
    })

    await useDesktopSessionStore.getState().retryAttachment("session:a", candidate.draftId)
    const retried =
      useDesktopSessionStore.getState().composerDraftsByScope["session:a"]!.attachments[0]!
    expect(retried.taskId).not.toBe("task-old")
    expect(retried.status).toBe("uploading")

    useDesktopSessionStore.getState().applyAttachmentUploadEvent({
      type: "failed",
      draftId: candidate.draftId,
      taskId: "task-old",
      error: { code: "late", message: "迟到", retryable: true },
    })
    expect(
      useDesktopSessionStore.getState().composerDraftsByScope["session:a"]!.attachments[0]
    ).toBe(retried)

    useDesktopSessionStore.getState().applyAttachmentUploadEvent({
      type: "success",
      draftId: candidate.draftId,
      taskId: retried.taskId,
      assetId: "asset-ready",
      displayName: candidate.displayName,
      mediaType: "application/pdf",
      sizeBytes: 100,
    })
    expect(
      useDesktopSessionStore.getState().composerDraftsByScope["session:a"]!.attachments[0]
    ).toMatchObject({ status: "ready", assetId: "asset-ready" })
  })

  it("uses the same draft pipeline for images, dropped files, and clipboard bytes", async () => {
    const image = {
      ...candidate,
      draftId: "draft-image",
      sourceToken: "source-image",
      displayName: "same.png",
      declaredMediaType: "image/png",
    }
    const dropped = {
      ...candidate,
      draftId: "draft-drop",
      sourceToken: "source-drop",
      displayName: "same.png",
      declaredMediaType: "image/png",
    }
    const startUpload = vi.fn(async (input: { taskId: string }) => ({ taskId: input.taskId }))
    const uploadClipboardImage = vi.fn(async (input: { taskId: string }) => ({
      taskId: input.taskId,
    }))
    const files = [{ name: "drop.pdf" }] as unknown as File[]
    vi.stubGlobal("window", {
      desktop: {
        attachments: {
          pickImages: vi.fn(async () => [image]),
          stageDroppedFiles: vi.fn(async () => [dropped]),
          startUpload,
          uploadClipboardImage,
        },
      },
    })

    await useDesktopSessionStore.getState().pickAttachmentImages("session:a")
    await useDesktopSessionStore.getState().addDroppedAttachments("session:a", files)
    await useDesktopSessionStore.getState().addClipboardAttachment("session:a", {
      bytes: Uint8Array.of(1, 2).buffer,
      displayName: "clipboard.png",
      mediaType: "image/png",
    })

    const drafts = useDesktopSessionStore.getState().composerDraftsByScope["session:a"]!.attachments
    expect(drafts.map((item) => item.draftId)).toEqual([
      "draft-image",
      "draft-drop",
      expect.any(String),
    ])
    expect(startUpload).toHaveBeenCalledTimes(2)
    expect(uploadClipboardImage).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: drafts[2]!.draftId,
        taskId: drafts[2]!.taskId,
        displayName: "clipboard.png",
      })
    )

    for (const draft of drafts) {
      useDesktopSessionStore.getState().applyAttachmentUploadEvent({
        type: "success",
        draftId: draft.draftId,
        taskId: draft.taskId,
        assetId: "asset-deduplicated",
        displayName: draft.displayName,
        mediaType: "image/png",
        sizeBytes: draft.sizeBytes,
      })
    }
    const readyDrafts =
      useDesktopSessionStore.getState().composerDraftsByScope["session:a"]!.attachments
    expect(readyDrafts).toHaveLength(3)
    expect(readyDrafts).toEqual([
      expect.objectContaining({ status: "ready", assetId: "asset-deduplicated" }),
      expect.objectContaining({ status: "ready", assetId: "asset-deduplicated" }),
      expect.objectContaining({ status: "ready", assetId: "asset-deduplicated" }),
    ])
  })

  it("cancels uploading drafts and discards failed draft sources without deleting an asset", async () => {
    const cancelUpload = vi.fn(async () => undefined)
    const discardDraft = vi.fn(async () => undefined)
    const deleteUnreferenced = vi.fn(async () => ({ deleted: true, inUse: false }))
    vi.stubGlobal("window", {
      desktop: { attachments: { cancelUpload, discardDraft, deleteUnreferenced } },
    })
    useDesktopSessionStore.setState({
      composerDraftsByScope: {
        "session:a": {
          document: { version: 1, items: [] },
          attachments: [
            {
              draftId: "draft-uploading",
              taskId: "task-uploading",
              displayName: "uploading.txt",
              declaredMediaType: "text/plain",
              sizeBytes: 1,
              status: "uploading",
              bytesUploaded: 0,
              progress: 0,
            },
            {
              draftId: "draft-failed",
              taskId: "task-failed",
              displayName: "failed.txt",
              declaredMediaType: "text/plain",
              sizeBytes: 1,
              status: "failed",
              bytesUploaded: 0,
              progress: 0,
              error: { code: "offline", message: "离线", retryable: true },
            },
          ],
        },
      },
    })

    await useDesktopSessionStore.getState().cancelAttachment("session:a", "draft-uploading")
    expect(cancelUpload).toHaveBeenCalledWith({ taskId: "task-uploading" })
    expect(
      useDesktopSessionStore.getState().composerDraftsByScope["session:a"]!.attachments[0]?.status
    ).toBe("cancelled")

    await useDesktopSessionStore.getState().removeAttachment("session:a", "draft-failed")
    expect(discardDraft).toHaveBeenCalledWith({ draftId: "draft-failed" })
    expect(deleteUnreferenced).not.toHaveBeenCalled()
  })

  it("removes ready assets optimistically and does not restore them when cleanup fails", async () => {
    const deleteUnreferenced = vi.fn(async () => {
      throw new Error("offline")
    })
    vi.stubGlobal("window", {
      desktop: { attachments: { deleteUnreferenced } },
    })
    useDesktopSessionStore.setState({
      composerDraftsByScope: {
        "session:a": {
          document: { version: 1, items: [{ type: "text", text: "keep text" }] },
          attachments: [
            {
              draftId: candidate.draftId,
              taskId: "task-ready",
              displayName: candidate.displayName,
              declaredMediaType: candidate.declaredMediaType,
              mediaType: "application/pdf",
              sizeBytes: candidate.sizeBytes,
              status: "ready",
              bytesUploaded: 100,
              progress: 1,
              assetId: "asset-ready",
            },
          ],
        },
      },
    })

    await useDesktopSessionStore.getState().removeAttachment("session:a", candidate.draftId)

    expect(
      useDesktopSessionStore.getState().composerDraftsByScope["session:a"]!.attachments
    ).toEqual([])
    expect(deleteUnreferenced).toHaveBeenCalledWith({ assetId: "asset-ready" })
  })

  it("keeps every attachment entry point disabled when the production capability gate is off", async () => {
    const pickFiles = vi.fn()
    const pickImages = vi.fn()
    const stageDroppedFiles = vi.fn()
    const uploadClipboardImage = vi.fn()
    vi.stubGlobal("window", {
      desktop: {
        attachments: { pickFiles, pickImages, stageDroppedFiles, uploadClipboardImage },
      },
    })
    useDesktopSessionStore.setState({
      attachmentSupport: {
        daemonSupported: true,
        interactionEnabled: false,
        uploadModes: ["single"],
        limits: null,
      },
    })

    await useDesktopSessionStore.getState().pickAttachmentFiles("session:a")
    await useDesktopSessionStore.getState().pickAttachmentImages("session:a")
    await useDesktopSessionStore.getState().addDroppedAttachments("session:a", [{} as File])
    await useDesktopSessionStore.getState().addClipboardAttachment("session:a", {
      bytes: Uint8Array.of(1).buffer,
      displayName: "clipboard.png",
      mediaType: "image/png",
    })

    expect(pickFiles).not.toHaveBeenCalled()
    expect(pickImages).not.toHaveBeenCalled()
    expect(stageDroppedFiles).not.toHaveBeenCalled()
    expect(uploadClipboardImage).not.toHaveBeenCalled()
    expect(useDesktopSessionStore.getState().composerDraftsByScope["session:a"]).toBeUndefined()
  })

  it("treats a missing attachment capability from an older bootstrap as disabled", async () => {
    const pickFiles = vi.fn()
    vi.stubGlobal("window", {
      desktop: { attachments: { pickFiles } },
    })
    useDesktopSessionStore.setState({ attachmentSupport: undefined as never })

    await expect(
      useDesktopSessionStore.getState().pickAttachmentFiles("session:a")
    ).resolves.toBeUndefined()
    expect(pickFiles).not.toHaveBeenCalled()
  })

  it("redacts rejected IPC details before storing a retryable renderer error", async () => {
    vi.stubGlobal("window", {
      desktop: {
        attachments: {
          pickFiles: vi.fn(async () => [candidate]),
          startUpload: vi.fn(async () => {
            throw new Error("Authorization: Bearer secret C:\\private\\report.pdf")
          }),
        },
      },
    })

    await useDesktopSessionStore.getState().pickAttachmentFiles("session:a")

    const [draft] =
      useDesktopSessionStore.getState().composerDraftsByScope["session:a"]!.attachments
    expect(draft).toMatchObject({
      status: "failed",
      error: {
        code: "attachment_action_failed",
        message: "附件操作失败，请重试。",
        retryable: true,
      },
    })
    expect(JSON.stringify(draft)).not.toMatch(/Authorization|secret|private/i)
  })
})
