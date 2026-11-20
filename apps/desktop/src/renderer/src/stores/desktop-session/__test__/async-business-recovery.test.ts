// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { useDesktopSessionStore } from "../store"
import { emptySessionView, resetDesktopSessionStore } from "../store-test-fixtures"
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it("waits for original identity persistence, retains failed text and retries the same identity", async () => {
  resetDesktopSessionStore()
  const writes: unknown[] = [],
    sent: unknown[] = []
  let rejectWrite!: (error: Error) => void
  let resolveWrite!: (record: unknown) => void
  let revision = 0
  const businessData = {
    read: async () => null,
    write: (_key: unknown, value: unknown) => {
      writes.push(value)
      return new Promise((resolve, reject) => {
        resolveWrite = resolve
        rejectWrite = reject
      })
    },
    flush: async () => undefined,
  }
  vi.stubGlobal("window", {
    desktop: {
      businessData,
      sessions: {
        sendPrompt: async (value: unknown) => {
          sent.push(value)
        },
        checkPromptAccepted: async () => false,
      },
    },
  })
  useDesktopSessionStore.setState({
    activeSessionId: "s",
    sessionView: emptySessionView("s"),
    loadStatus: "ready",
  })
  useDesktopSessionStore.getState().setComposerDraftText("session:s", "retain me")
  const attachments = ["second", "first"].map((assetId) => ({
    draftId: assetId,
    taskId: assetId,
    assetId,
    displayName: `${assetId}.txt`,
    declaredMediaType: "text/plain",
    mediaType: "text/plain",
    sizeBytes: 1,
    bytesUploaded: 1,
    progress: 1,
    status: "ready" as const,
  }))
  const request = useDesktopSessionStore.getState().sendMessage("retain me", { attachments })
  const rejected = request.catch((error) => error)
  await vi.waitFor(() => expect(writes).toHaveLength(1))
  expect(sent).toEqual([])
  const id = Object.keys(
    useDesktopSessionStore.getState().sessionRuntimes.s!.pendingPromptSubmissions
  )[0]!
  rejectWrite(new Error("disk full"))
  expect(String(await rejected)).toMatch(/保存/)
  expect(
    useDesktopSessionStore.getState().composerDraftsByScope["session:s"]?.document.items
  ).toEqual([{ type: "text", text: "retain me" }])
  expect(sent).toEqual([])
  const retry = useDesktopSessionStore.getState().retryPromptSubmission(id)
  await vi.waitFor(() => expect(writes).toHaveLength(2))
  expect(sent).toEqual([])
  resolveWrite({ version: 1, revision: ++revision, value: writes[1] })
  await retry
  expect(sent).toMatchObject([
    {
      id,
      items: [{ type: "text", text: "retain me" }],
      attachments: [{ assetId: "second" }, { assetId: "first" }],
    },
  ])
  expect(writes[0]).toMatchObject({
    submissions: [{ id, attachments: [{ assetId: "second" }, { assetId: "first" }] }],
  })
})
