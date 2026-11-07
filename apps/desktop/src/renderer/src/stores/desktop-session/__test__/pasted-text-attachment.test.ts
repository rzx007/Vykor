// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { composerDocument } from "../composer-document"
import { readComposerRecovery, saveComposerRecovery } from "../composer-recovery"
import { selectDraftText } from "../composer-draft-state"
import { resetDesktopSessionStore } from "../store-test-fixtures"
import { useDesktopSessionStore } from "../store"

const scope = "session:pasted-text"
const text = "  保留缩进🙂\n" + "长文本\n".repeat(1_500) + "\n末尾  "
const attachments = {
  uploadClipboardImage: vi.fn().mockResolvedValue(undefined),
  cancelUpload: vi.fn().mockResolvedValue(undefined),
  deleteUnreferenced: vi.fn().mockResolvedValue(undefined),
  discardDraft: vi.fn().mockResolvedValue(undefined),
}

beforeEach(() => {
  resetDesktopSessionStore()
  localStorage.clear()
  vi.clearAllMocks()
  Object.assign(window, { desktop: { attachments } })
  useDesktopSessionStore.setState({ attachmentSupport: { interactionEnabled: true } as never })
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

it("keeps pasted text locally and restores it once without losing references, other cards or chats", async () => {
  const store = useDesktopSessionStore.getState()
  store.setComposerDraftDocument(
    scope,
    composerDocument([
      { type: "text", text: "现有正文 " },
      { type: "skill", name: "review", path: "D:/review/SKILL.md" },
    ])
  )
  store.setComposerDraftText("session:other", "另一个聊天")
  await store.addClipboardAttachment(scope, {
    bytes: new ArrayBuffer(1),
    displayName: "other.txt",
    mediaType: "text/plain",
  })
  await store.addPastedTextAttachment(scope, text)
  const draft = useDesktopSessionStore.getState().composerDraftsByScope[scope]!
  const pasted = draft.attachments[1]!
  expect(pasted).toMatchObject({ displayName: "pasted-text.txt", pastedText: text })
  const upload = attachments.uploadClipboardImage.mock.calls[1]![0]
  expect(new TextDecoder().decode(upload.bytes)).toBe(text)
  expect(upload).not.toHaveProperty("pastedText")

  await store.showPastedTextAttachment(scope, pasted.draftId)
  await store.showPastedTextAttachment(scope, pasted.draftId)
  const restored = useDesktopSessionStore.getState().composerDraftsByScope[scope]!
  expect(restored.document.items).toEqual([
    ...draft.document.items,
    { type: "text", text: "\n\n" + text },
  ])
  expect(restored.attachments).toEqual([draft.attachments[0]])
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:other")).toBe("另一个聊天")
  expect(attachments.cancelUpload).toHaveBeenCalledExactlyOnceWith({ taskId: pasted.taskId })
})

it("restores a moved uploading card and ignores its late upload event", async () => {
  const store = useDesktopSessionStore.getState()
  await store.addPastedTextAttachment("new-conversation", text)
  const pasted =
    useDesktopSessionStore.getState().composerDraftsByScope["new-conversation"]!.attachments[0]!
  store.migrateComposerDraft("new-conversation", scope)
  await store.showPastedTextAttachment("new-conversation", pasted.draftId)
  expect(
    useDesktopSessionStore.getState().composerDraftsByScope["new-conversation"]
  ).toBeUndefined()
  await store.showPastedTextAttachment(scope, pasted.draftId)
  store.applyAttachmentUploadEvent({
    type: "success",
    draftId: pasted.draftId,
    taskId: pasted.taskId,
    assetId: "late",
    displayName: "pasted-text.txt",
    mediaType: "text/plain",
    sizeBytes: pasted.sizeBytes,
  })
  expect(selectDraftText(useDesktopSessionStore.getState(), scope)).toBe(text)
  expect(useDesktopSessionStore.getState().composerDraftsByScope[scope]!.attachments).toEqual([])
})

it.each(["ready", "failed"] as const)(
  "restores a %s card after recovery and cleans up its old upload",
  async (status) => {
    const store = useDesktopSessionStore.getState()
    await store.addPastedTextAttachment(scope, text)
    const pasted = useDesktopSessionStore.getState().composerDraftsByScope[scope]!.attachments[0]!
    store.applyAttachmentUploadEvent(
      status === "ready"
        ? {
            type: "success",
            draftId: pasted.draftId,
            taskId: pasted.taskId,
            assetId: "ready",
            displayName: "pasted-text.txt",
            mediaType: "text/plain",
            sizeBytes: pasted.sizeBytes,
          }
        : {
            type: "failed",
            draftId: pasted.draftId,
            taskId: pasted.taskId,
            error: { code: "network", message: "上传失败", retryable: true },
          }
    )
    expect(saveComposerRecovery(useDesktopSessionStore.getState())).toBe(true)
    useDesktopSessionStore.setState(readComposerRecovery())
    await store.showPastedTextAttachment(scope, pasted.draftId)
    expect(selectDraftText(useDesktopSessionStore.getState(), scope)).toBe(text)
    expect(useDesktopSessionStore.getState().composerDraftsByScope[scope]!.attachments).toEqual([])
    if (status === "ready") {
      expect(attachments.deleteUnreferenced).toHaveBeenCalledExactlyOnceWith({ assetId: "ready" })
    } else {
      expect(attachments.discardDraft).toHaveBeenCalledExactlyOnceWith({ draftId: pasted.draftId })
    }
  }
)

it("does not convert manually attached TXT files or lose restored text if cleanup fails", async () => {
  const store = useDesktopSessionStore.getState()
  await store.addClipboardAttachment(scope, {
    bytes: new ArrayBuffer(1),
    displayName: "pasted-text.txt",
    mediaType: "text/plain",
  })
  const manual = useDesktopSessionStore.getState().composerDraftsByScope[scope]!.attachments[0]!
  await store.showPastedTextAttachment(scope, manual.draftId)
  expect(useDesktopSessionStore.getState().composerDraftsByScope[scope]!.attachments).toEqual([
    manual,
  ])
  await store.addPastedTextAttachment(scope, text)
  const pasted = useDesktopSessionStore.getState().composerDraftsByScope[scope]!.attachments[1]!
  attachments.cancelUpload.mockRejectedValueOnce(new Error("offline"))
  await store.showPastedTextAttachment(scope, pasted.draftId)
  expect(selectDraftText(useDesktopSessionStore.getState(), scope)).toBe(text)
  expect(useDesktopSessionStore.getState().composerDraftsByScope[scope]!.attachments).toEqual([
    manual,
  ])
})
