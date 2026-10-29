import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  addCandidates,
  applyUploadEvent,
  beginUpload,
  emptyComposerDraftState,
  removeDraftAttachment,
  selectDraftText,
  setDraftText,
} from "../composer-draft-state"
import { resetDesktopSessionStore } from "../store-test-fixtures"
import { useDesktopSessionStore } from "../store"
const scope = "session:a"
const candidate = {
  draftId: "draft",
  sourceToken: "source",
  displayName: "notes.txt",
  declaredMediaType: "text/plain",
  sizeBytes: 10,
}
beforeEach(() => {
  resetDesktopSessionStore()
  vi.unstubAllGlobals()
})
it("does not revive a cancelled or removed attachment when an old upload finishes, and keeps text", () => {
  const pending = beginUpload(
    addCandidates(setDraftText(emptyComposerDraftState(), scope, "正文草稿"), scope, [candidate]),
    scope,
    "draft",
    "task"
  )
  const cancelled = applyUploadEvent(pending, scope, {
    type: "cancelled",
    draftId: "draft",
    taskId: "task",
  })
  const success = {
    type: "success" as const,
    draftId: "draft",
    taskId: "task",
    assetId: "asset",
    displayName: "notes.txt",
    mediaType: "text/plain",
    sizeBytes: 10,
  }
  expect(applyUploadEvent(cancelled, scope, success)).toBe(cancelled)
  const removed = removeDraftAttachment(cancelled, scope, "draft")
  expect(applyUploadEvent(removed, scope, success)).toBe(removed)
  expect(selectDraftText(removed, scope)).toBe("正文草稿")
})
it("does not downgrade a ready attachment when cancellation replies late", () => {
  const pending = beginUpload(
    addCandidates(emptyComposerDraftState(), scope, [candidate]),
    scope,
    "draft",
    "task"
  )
  const ready = applyUploadEvent(pending, scope, {
    type: "success",
    draftId: "draft",
    taskId: "task",
    assetId: "asset",
    displayName: "notes.txt",
    mediaType: "text/plain",
    sizeBytes: 10,
  })
  expect(
    applyUploadEvent(ready, scope, { type: "cancelled", draftId: "draft", taskId: "task" })
  ).toBe(ready)
})
it("stops retrying an expired attachment source without clearing the document", async () => {
  const retryUpload = vi.fn().mockRejectedValue(new Error("attachment_retry_unavailable"))
  vi.stubGlobal("window", { desktop: { attachments: { retryUpload } } })
  useDesktopSessionStore.setState({
    composerDraftsByScope: {
      [scope]: {
        document: { version: 1, items: [{ type: "text", text: "正文草稿" }] },
        attachments: [
          {
            ...candidate,
            taskId: "old",
            status: "failed",
            bytesUploaded: 0,
            progress: 0,
            error: { code: "network", message: "失败", retryable: true },
          },
        ],
      },
    },
  })
  await useDesktopSessionStore.getState().retryAttachment(scope, "draft")
  expect(
    useDesktopSessionStore.getState().composerDraftsByScope[scope]!.attachments[0]?.error
  ).toMatchObject({ retryable: false })
  await useDesktopSessionStore.getState().retryAttachment(scope, "draft")
  expect(retryUpload).toHaveBeenCalledTimes(1)
  expect(selectDraftText(useDesktopSessionStore.getState(), scope)).toBe("正文草稿")
})

afterEach(() => vi.unstubAllGlobals())
it("keeps preparation with a moved draft and uploads only after all reads finish", async () => {
  let resolve!: (bytes: ArrayBuffer) => void
  const bytes = new Promise<ArrayBuffer>((done) => {
    resolve = done
  })
  const uploadClipboardImage = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal("window", { desktop: { attachments: { uploadClipboardImage } } })
  useDesktopSessionStore.setState({ attachmentSupport: { interactionEnabled: true } as never })
  useDesktopSessionStore.getState().setComposerDraftText(scope, "正文草稿")
  const pending = useDesktopSessionStore
    .getState()
    .addClipboardFiles(scope, [
      { name: "a.txt", type: "text/plain", arrayBuffer: () => bytes } as unknown as File,
    ])
  expect(
    useDesktopSessionStore.getState().composerDraftsByScope[scope]?.attachmentPreparation?.pending
  ).toHaveLength(1)
  useDesktopSessionStore.getState().migrateComposerDraft(scope, "session:b")
  resolve(new ArrayBuffer(1))
  await pending
  expect(useDesktopSessionStore.getState().composerDraftsByScope[scope]).toBeUndefined()
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:b"]).toMatchObject({
    attachmentPreparation: { pending: [] },
    attachments: [{ status: "uploading" }],
  })
  expect(uploadClipboardImage).toHaveBeenCalledOnce()
  expect(selectDraftText(useDesktopSessionStore.getState(), "session:b")).toBe("正文草稿")
})
it("reports failed reads, does not partially upload the batch, and preserves the draft", async () => {
  const uploadClipboardImage = vi.fn()
  vi.stubGlobal("window", { desktop: { attachments: { uploadClipboardImage } } })
  useDesktopSessionStore.setState({ attachmentSupport: { interactionEnabled: true } as never })
  useDesktopSessionStore.getState().setComposerDraftText(scope, "正文草稿")
  await useDesktopSessionStore.getState().addClipboardFiles(scope, [
    {
      name: "ok.txt",
      type: "text/plain",
      arrayBuffer: async () => new ArrayBuffer(1),
    } as unknown as File,
    {
      name: "bad.txt",
      type: "text/plain",
      arrayBuffer: async () => {
        throw new Error("private path")
      },
    } as unknown as File,
  ])
  expect(uploadClipboardImage).not.toHaveBeenCalled()
  expect(useDesktopSessionStore.getState().composerDraftsByScope[scope]).toMatchObject({
    attachments: [],
    attachmentPreparation: { pending: [], error: expect.stringContaining("正文草稿已保留") },
  })
  expect(selectDraftText(useDesktopSessionStore.getState(), scope)).toBe("正文草稿")
})
it("does not recreate a discarded draft after a pending picker returns", async () => {
  let resolve!: (value: (typeof candidate)[]) => void
  const selected = new Promise<(typeof candidate)[]>((done) => {
    resolve = done
  })
  const startUpload = vi.fn()
  vi.stubGlobal("window", { desktop: { attachments: { pickFiles: () => selected, startUpload } } })
  useDesktopSessionStore.setState({ attachmentSupport: { interactionEnabled: true } as never })
  const pending = useDesktopSessionStore.getState().pickAttachmentFiles(scope)
  useDesktopSessionStore.getState().resetComposerDraft(scope)
  resolve([candidate])
  await pending
  expect(useDesktopSessionStore.getState().composerDraftsByScope[scope]).toBeUndefined()
  expect(startUpload).not.toHaveBeenCalled()
})

it("routes a local upload failure to its moved draft", async () => {
  let reject!: (cause: Error) => void
  const uploading = new Promise<void>((_done, fail) => {
    reject = fail
  })
  vi.stubGlobal("window", { desktop: { attachments: { uploadClipboardImage: () => uploading } } })
  useDesktopSessionStore.setState({ attachmentSupport: { interactionEnabled: true } as never })
  const pending = useDesktopSessionStore.getState().addClipboardAttachment(scope, {
    bytes: new ArrayBuffer(1),
    displayName: "a.txt",
    mediaType: "text/plain",
  })
  useDesktopSessionStore.getState().migrateComposerDraft(scope, "session:b")
  reject(new Error("upload failed"))
  await pending
  expect(useDesktopSessionStore.getState().composerDraftsByScope[scope]).toBeUndefined()
  expect(
    useDesktopSessionStore.getState().composerDraftsByScope["session:b"]?.attachments[0]?.status
  ).toBe("failed")
})
it("keeps preparing until concurrent picks finish and carries failure feedback through migration", async () => {
  let resolve!: (value: (typeof candidate)[]) => void
  let reject!: (cause: Error) => void
  const first = new Promise<(typeof candidate)[]>((done) => {
    resolve = done
  })
  const second = new Promise<(typeof candidate)[]>((_done, fail) => {
    reject = fail
  })
  const pickFiles = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
  vi.stubGlobal("window", { desktop: { attachments: { pickFiles } } })
  useDesktopSessionStore.setState({ attachmentSupport: { interactionEnabled: true } as never })
  const a = useDesktopSessionStore.getState().pickAttachmentFiles(scope)
  const b = useDesktopSessionStore.getState().pickAttachmentFiles(scope)
  useDesktopSessionStore.getState().migrateComposerDraft(scope, "session:b")
  resolve([])
  await a
  expect(
    useDesktopSessionStore.getState().composerDraftsByScope["session:b"]?.attachmentPreparation
      ?.pending
  ).toHaveLength(1)
  reject(new Error("private path"))
  await b
  expect(useDesktopSessionStore.getState().composerDraftsByScope[scope]).toBeUndefined()
  expect(
    useDesktopSessionStore.getState().composerDraftsByScope["session:b"]?.attachmentPreparation
  ).toMatchObject({ pending: [], error: expect.stringContaining("正文草稿已保留") })
})
