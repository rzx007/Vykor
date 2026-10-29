// @vitest-environment jsdom
import { clearSubmittedDraft } from "../composer-draft-state"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pluginAppModelContexts } from "@renderer/components/desktop/shell/plugin-apps/plugin-app-model-context"
import { composerDocument } from "../composer-document"
import { createInitialRuntimeState } from "../initial-state"
import { emptySessionView, resetDesktopSessionStore } from "../store-test-fixtures"
import { useDesktopSessionStore } from "../store"
import {
  markComposerSessionTransient,
  readComposerRecovery,
  saveComposerRecovery,
} from "../composer-recovery"

describe("composer recovery", () => {
  it("does not revive a new session deleted while its initial snapshot is pending", async () => {
    let resolveOpen!: (view: ReturnType<typeof emptySessionView>) => void
    const sendPrompt = vi.fn()
    vi.stubGlobal("window", { desktop: { sessions: {
      create: vi.fn(async () => emptySessionView("deleted-first").session),
      open: vi.fn(() => new Promise(resolve => { resolveOpen = resolve })), sendPrompt,
    } } })
    useDesktopSessionStore.setState({ activeSessionId: null, sessionView: null, workspaceMode: "outside_project", selectedModel: "model" })
    const request = useDesktopSessionStore.getState().startSession("do not send")
    await vi.waitFor(() => expect(resolveOpen).toBeTypeOf("function"))
    // A confirmed deletion clears these records before the old snapshot returns.
    useDesktopSessionStore.setState({ activeSessionId: null, sessionView: null, sessions: [], sessionRuntimes: {}, composerDraftsByScope: {} })
    resolveOpen(emptySessionView("deleted-first"))
    expect(await request).toBeNull()
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(useDesktopSessionStore.getState().sessionRuntimes["deleted-first"]).toBeUndefined()
  })
  it.each(["ordinary", "first"])(
    "does not send the %s prompt if its identity cannot be saved",
    async (kind) => {
      const sendPrompt = vi.fn()
      vi.stubGlobal("window", {
        desktop: {
          sessions: {
            sendPrompt,
            create: vi.fn(async () => emptySessionView("created").session),
            open: vi.fn(async () => emptySessionView("created")),
          },
        },
      })
      useDesktopSessionStore.setState({
        activeSessionId: kind === "first" ? null : "s",
        sessionView: kind === "first" ? null : emptySessionView("s"),
        workspaceMode: "outside_project",
        selectedModel: "model",
      })
      const scope = kind === "first" ? "new-conversation" : "session:s"
      useDesktopSessionStore.getState().setComposerDraftText(scope, "retained")
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError")
      })
      const action =
        kind === "first"
          ? useDesktopSessionStore.getState().startSession("retained")
          : useDesktopSessionStore.getState().sendMessage("retained")
      await expect(action).rejects.toThrow(/保存/)
      expect(sendPrompt).not.toHaveBeenCalled()
      const actualScope = kind === "first" ? "session:created" : scope
      expect(
        useDesktopSessionStore.getState().composerDraftsByScope[actualScope]?.document.items
      ).toEqual([{ type: "text", text: "retained" }])
    }
  )

  it("does not retry an unaccepted input while storage is unavailable", async () => {
    const sendPrompt = vi.fn().mockRejectedValueOnce(new Error("offline"))
    const checkPromptAccepted = vi.fn().mockResolvedValue(false)
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt, checkPromptAccepted } } })
    useDesktopSessionStore.setState({ activeSessionId: "s", sessionView: emptySessionView("s") })
    await expect(useDesktopSessionStore.getState().sendMessage("hello")).rejects.toThrow("offline")
    const id = sendPrompt.mock.calls[0]![0].id
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    await expect(useDesktopSessionStore.getState().retryPromptSubmission(id)).rejects.toThrow(
      /保存/
    )
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it("keeps removed contexts out of ordinary sends but retains the exact payload for explicit retry", async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined)
    const checkPromptAccepted = vi.fn().mockResolvedValue(false)
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt, checkPromptAccepted } } })
    useDesktopSessionStore.setState({ activeSessionId: "s", sessionView: emptySessionView("s") })
    pluginAppModelContexts.put({ id: "ctx", source: { sessionId: "s", appId: "app" } } as never)
    await expect(useDesktopSessionStore.getState().sendMessage("hello")).rejects.toThrow()
    const original = sendPrompt.mock.calls[0]![0]
    pluginAppModelContexts.remove("ctx")
    await useDesktopSessionStore.getState().sendMessage("hello")
    expect(sendPrompt.mock.calls[1]![0].pluginAppContextIds).toBeUndefined()
    expect(sendPrompt.mock.calls[1]![0].id).not.toBe(original.id)
    await useDesktopSessionStore.getState().retryPromptSubmission(original.id)
    expect(sendPrompt.mock.calls[2]![0]).toEqual(original)
  })

  it("restores the actual empty draft without resurrecting dismissed submissions", async () => {
    vi.stubGlobal("window", {
      desktop: { sessions: { sendPrompt: vi.fn().mockRejectedValue(new Error("offline")) } },
    })
    useDesktopSessionStore.setState({ activeSessionId: "s", sessionView: emptySessionView("s") })
    useDesktopSessionStore.getState().setComposerDraftText("session:s", "obsolete")
    await expect(useDesktopSessionStore.getState().sendMessage("obsolete")).rejects.toThrow()
    const id = Object.keys(
      useDesktopSessionStore.getState().sessionRuntimes.s!.pendingPromptSubmissions
    )[0]!
    useDesktopSessionStore.getState().dismissPromptSubmission(id)
    useDesktopSessionStore.getState().setComposerDraftText("session:s", "")
    saveComposerRecovery(useDesktopSessionStore.getState())
    const recovered = readComposerRecovery()
    expect(recovered.composerDraftsByScope["session:s"]?.document.items ?? []).toEqual([])
    expect(recovered.sessionRuntimes.s?.pendingPromptSubmissions[id]).toMatchObject({
      id,
      dismissed: true,
    })
  })

  it("stores submission text once and derives display content when reading", async () => {
    vi.stubGlobal("window", {
      desktop: { sessions: { sendPrompt: vi.fn().mockRejectedValue(new Error("offline")) } },
    })
    useDesktopSessionStore.setState({ activeSessionId: "s", sessionView: emptySessionView("s") })
    await expect(useDesktopSessionStore.getState().sendMessage("one copy")).rejects.toThrow()
    saveComposerRecovery(useDesktopSessionStore.getState())
    const saved = JSON.parse(localStorage.getItem("vykor.desktop.composer-recovery.v1")!)
      .submissions[0]
    expect(saved.content).toBeUndefined()
    expect(saved.draftDocument).toBeUndefined()
    expect(
      Object.values(readComposerRecovery().sessionRuntimes.s!.pendingPromptSubmissions)[0]?.content
    ).toBe("one copy")
  })

  it("does not remove a newly added card that happens to reuse the same uploaded asset", () => {
    const attachment = {
      draftId: "new-card",
      taskId: "t",
      assetId: "same-asset",
      displayName: "a.txt",
      declaredMediaType: "text/plain",
      mediaType: "text/plain",
      sizeBytes: 1,
      bytesUploaded: 1,
      progress: 1,
      status: "ready" as const,
    }
    const result = clearSubmittedDraft(
      {
        composerDraftsByScope: {
          "session:s": {
            document: composerDocument([{ type: "text", text: "new draft" }]),
            attachments: [attachment],
          },
        },
      },
      {
        id: "input",
        sessionId: "s",
        content: "old",
        items: [{ type: "text", text: "old" }],
        createdAt: 1,
        phase: "failed",
        placement: "transcript",
        draftAttachmentIds: ["old-card"],
        attachments: [
          {
            assetId: "same-asset",
            displayName: "a.txt",
            intent: "auto",
            mediaType: "text/plain",
            sizeBytes: 1,
          },
        ],
      }
    )
    expect(result.composerDraftsByScope["session:s"]?.attachments).toEqual([attachment])
  })
  beforeEach(() => {
    localStorage.clear()
    resetDesktopSessionStore()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const entry of pluginAppModelContexts.snapshot()) pluginAppModelContexts.remove(entry.id)
  })

  it("reports an explicit status-refresh failure without sending a message", async () => {
    const sendPrompt = vi.fn()
    vi.stubGlobal("window", {
      desktop: { sessions: { sendPrompt, open: vi.fn().mockRejectedValue(new Error("offline")) } },
    })
    useDesktopSessionStore.setState({ activeSessionId: "s", sessionView: emptySessionView("s") })
    await expect(
      useDesktopSessionStore.getState().resyncActiveSessionSnapshot({ throwOnError: true })
    ).rejects.toThrow("offline")
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it("writes the original send identity before invoking IPC", async () => {
    const sendPrompt = vi.fn(async (input: { id: string }) => {
      expect(
        JSON.parse(localStorage.getItem("vykor.desktop.composer-recovery.v1")!).submissions[0].id
      ).toBe(input.id)
    })
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({ activeSessionId: "s", sessionView: emptySessionView("s") })
    await useDesktopSessionStore.getState().sendMessage("hello")
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it("does not persist temporary side-chat drafts", () => {
    markComposerSessionTransient("ephemeral")
    const value = {
      document: composerDocument([{ type: "text", text: "temporary" }]),
      attachments: [],
    }
    saveComposerRecovery({
      composerDraftsByScope: {
        "session:ephemeral": value,
        "linked-chat:source": value,
        "session:durable": value,
      },
      ...createInitialRuntimeState(),
    })
    expect(Object.keys(readComposerRecovery().composerDraftsByScope)).toEqual(["session:durable"])
  })

  it("keeps the same id on concurrent retries and does not submit while acceptance cannot be checked", async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined)
    let release!: (accepted: boolean) => void
    const checkPromptAccepted = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt, checkPromptAccepted } } })
    useDesktopSessionStore.setState({ activeSessionId: "s", sessionView: emptySessionView("s") })
    await expect(useDesktopSessionStore.getState().sendMessage("hello")).rejects.toThrow()
    const id = sendPrompt.mock.calls[0]![0].id
    const retry = useDesktopSessionStore.getState().retryPromptSubmission(id)
    const secondRetry = useDesktopSessionStore.getState().retryPromptSubmission(id)
    expect(checkPromptAccepted).toHaveBeenCalledTimes(1)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    release(false)
    await Promise.all([retry, secondRetry])
    expect(sendPrompt).toHaveBeenCalledTimes(2)
    expect(sendPrompt.mock.calls[1]![0].id).toBe(id)
  })

  it("preserves the identity even after closing the failure notice", async () => {
    const sendPrompt = vi.fn().mockRejectedValue(new Error("offline"))
    const checkPromptAccepted = vi.fn().mockRejectedValue(new Error("still offline"))
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt, checkPromptAccepted } } })
    useDesktopSessionStore.setState({ activeSessionId: "s", sessionView: emptySessionView("s") })
    await expect(useDesktopSessionStore.getState().sendMessage("hello")).rejects.toThrow()
    const id = sendPrompt.mock.calls[0]![0].id
    useDesktopSessionStore.getState().dismissPromptSubmission(id)
    await expect(useDesktopSessionStore.getState().sendMessage("hello")).rejects.toThrow(
      "still offline"
    )
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(
      useDesktopSessionStore.getState().sessionRuntimes.s!.pendingPromptSubmissions[id]
    ).toMatchObject({ id, phase: "failed", dismissed: false })
  })

  it("clears recovered text when an authoritative snapshot confirms the original input", async () => {
    const sendPrompt = vi.fn().mockRejectedValue(new Error("response lost"))
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({ activeSessionId: "s", sessionView: emptySessionView("s") })
    useDesktopSessionStore.getState().setComposerDraftText("session:s", "hello")
    await expect(useDesktopSessionStore.getState().sendMessage("hello")).rejects.toThrow()
    const id = sendPrompt.mock.calls[0]![0].id
    const state = useDesktopSessionStore.getState()
    saveComposerRecovery(state)
    useDesktopSessionStore.setState(readComposerRecovery())
    const view = emptySessionView("s", 10)
    view.inputs = [
      {
        id,
        sessionId: "s",
        seq: 1,
        items: [{ type: "text", text: "hello" }],
        content: "hello",
        delivery: "queue",
        attachments: [],
        metadata: {},
        createdAt: 1,
      },
    ]
    useDesktopSessionStore.getState().applySessionUpdate(view)
    expect(
      useDesktopSessionStore.getState().composerDraftsByScope["session:s"]?.document.items
    ).toEqual([])
    expect(sendPrompt).toHaveBeenCalledTimes(1)
  })

  it("restores structured drafts and ready assets but marks interrupted uploads for reselection", () => {
    const document = composerDocument([
      { type: "text", text: "尚未发送" },
      { type: "mention", name: "file", path: "D:/file" },
    ])
    const asset = {
      draftId: "a",
      taskId: "t",
      displayName: "a.txt",
      declaredMediaType: "text/plain",
      sizeBytes: 4,
      bytesUploaded: 4,
      progress: 1,
      status: "ready" as const,
      assetId: "asset",
      mediaType: "text/plain",
    }
    saveComposerRecovery({
      composerDraftsByScope: {
        "session:s": {
          document,
          attachments: [asset, { ...asset, draftId: "b", status: "uploading", assetId: undefined }],
        },
      },
      ...createInitialRuntimeState(),
    })
    const restored = readComposerRecovery().composerDraftsByScope["session:s"]!
    expect(restored.document).toEqual(document)
    expect(restored.attachments[0]).toEqual(asset)
    expect(restored.attachments[1]).toMatchObject({ status: "failed", error: { retryable: false } })
  })

  it("restores an in-flight send as uncertain with its original id and never sends automatically", () => {
    const sendPrompt = vi.fn()
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    const submission = {
      id: "same-id",
      sessionId: "s",
      content: "hello",
      items: [{ type: "text" as const, text: "hello" }],
      attachments: [],
      createdAt: 1,
      phase: "submitting" as const,
      placement: "transcript" as const,
    }
    const runtime = createInitialRuntimeState()
    saveComposerRecovery({
      composerDraftsByScope: {},
      ...runtime,
      sessionRuntimes: {
        s: {
          ...runtime.newConversationRuntime,
          pendingPromptSubmissions: { "same-id": submission },
        },
      },
    })
    expect(
      readComposerRecovery().sessionRuntimes.s?.pendingPromptSubmissions["same-id"]
    ).toMatchObject({ id: "same-id", phase: "failed" })
    expect(sendPrompt).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("ignores malformed records without losing other drafts", () => {
    localStorage.setItem(
      "vykor.desktop.composer-recovery.v1",
      JSON.stringify({
        version: 1,
        drafts: {
          good: {
            document: { version: 1, items: [{ type: "text", text: "saved" }] },
            attachments: [],
          },
          bad: { document: {} },
        },
        submissions: [],
      })
    )
    expect(Object.keys(readComposerRecovery().composerDraftsByScope)).toEqual(["good"])
  })

  it("blocks a second identical send while the first is pending", async () => {
    let finish!: () => void
    const sendPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({ activeSessionId: "s", sessionView: emptySessionView("s") })
    const first = useDesktopSessionStore.getState().sendMessage("hello")
    let secondFinished = false
    const second = useDesktopSessionStore
      .getState()
      .sendMessage("hello")
      .then(() => {
        secondFinished = true
      })
    await Promise.resolve()
    expect(secondFinished).toBe(false)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([first, second])
    vi.unstubAllGlobals()
  })

  it("checks acceptance before retrying and keeps a newer draft intact", async () => {
    const sendPrompt = vi.fn().mockRejectedValueOnce(new Error("response lost"))
    const checkPromptAccepted = vi.fn().mockResolvedValue(true)
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt, checkPromptAccepted } } })
    useDesktopSessionStore.setState({ activeSessionId: "s", sessionView: emptySessionView("s") })
    await expect(useDesktopSessionStore.getState().sendMessage("hello")).rejects.toThrow()
    const id = Object.keys(
      useDesktopSessionStore.getState().sessionRuntimes.s!.pendingPromptSubmissions
    )[0]!
    useDesktopSessionStore.getState().setComposerDraftText("session:s", "newer draft")
    await useDesktopSessionStore.getState().retryPromptSubmission(id)
    expect(checkPromptAccepted).toHaveBeenCalledWith({ sessionId: "s", inputId: id })
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(
      useDesktopSessionStore.getState().composerDraftsByScope["session:s"]?.document.items
    ).toEqual([{ type: "text", text: "newer draft" }])
    vi.unstubAllGlobals()
  })
})
