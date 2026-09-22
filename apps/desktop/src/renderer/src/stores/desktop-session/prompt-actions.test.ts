import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopSessionView, SendDesktopPromptInput } from "@shared/session-types"
import type { DesktopAttachmentDraft } from "@shared/attachment-types"
import { createEmptySessionRuntime } from "./operation-state"
import { createQueuedPromptActions } from "./queued-prompt-actions"
import { emptySessionView, resetDesktopSessionStore, sessionRuntime } from "./store-test-fixtures"
import { useDesktopSessionStore } from "./store"
import { selectActiveSessionQueuedPromptActions, selectSessionSending } from "./selectors"
import type { DesktopSessionRuntime } from "./types"
import { composerDocument, emptyComposerDocument } from "./composer-document"

function viewContainingInput(
  sessionId: string,
  inputId: string,
  cursor: number
): DesktopSessionView {
  return {
    cursor,
    syncStatus: "connected",
    session: {
      id: sessionId,
      cwd: "D:\\repo",
      title: "test",
      model: "test-model",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: cursor,
    },
    inputs: [
      {
        id: inputId,
        sessionId,
        seq: 1,
        delivery: "queue",
        content: "confirmed",
        items: [{ type: "text", text: "confirmed" }],
        attachments: [],
        metadata: {},
        createdAt: 1,
      },
    ],
    messages: [],
    parts: [],
    runs: [],
    tasks: [],
    permissions: [],
  }
}

describe("prompt actions session runtime", () => {
  beforeEach(() => {
    resetDesktopSessionStore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("preserves a failed plugin draft and retries the same structured submission", async () => {
    const received: SendDesktopPromptInput[] = []
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt: async (input: SendDesktopPromptInput) => {
      received.push(input)
      if (received.length === 1) throw new Error("session_plugin_capability_unavailable")
    } } } })
    const document = composerDocument([
      { type: "capability", kind: "plugin", pluginId: "dev.quality", displayName: "Quality" },
      { type: "text", text: " review" },
    ])
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      composerDraftsByScope: { "session:session-1": { document, attachments: [] } },
    })
    await expect(useDesktopSessionStore.getState().sendMessage("@Quality review", { document })).rejects.toThrow("session_plugin_capability_unavailable")
    expect(received[0].items).toEqual([
      { type: "capability", kind: "plugin", pluginId: "dev.quality", displayName: "Quality" },
      { type: "text", text: " review" },
    ])
    expect(useDesktopSessionStore.getState().composerDraftsByScope["session:session-1"]?.document).toEqual(document)
    expect(onlyPendingPromptSubmission()).toMatchObject({ content: "@Quality review", phase: "failed", items: document.items })
    await useDesktopSessionStore.getState().sendMessage("@Quality review", { document })
    expect(received[1]).toEqual(received[0])
    expect(useDesktopSessionStore.getState().composerDraftsByScope["session:session-1"]?.document).toEqual(emptyComposerDocument)
  })

  it("keeps the session runtime pending until SSE confirms the submitted input", async () => {
    let resolveSend!: () => void
    const sendPrompt = vi.fn<
      (input: { id: string; sessionId: string; content: string }) => Promise<void>
    >(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: null,
      sessionRuntimes: { "session-1": createEmptySessionRuntime() },
    })

    const request = useDesktopSessionStore.getState().sendMessage("pending")
    const inputId = sendPrompt.mock.calls[0]![0].id
    useDesktopSessionStore.getState().applySessionUpdate({
      ...viewContainingInput("session-1", inputId, 1),
      inputs: [],
    })

    expect(useDesktopSessionStore.getState().sessionRuntimes["session-1"]).toMatchObject({
      operations: {
        [inputId]: expect.objectContaining({ phase: "pending" }),
      },
      pendingPromptSubmissions: {
        [inputId]: expect.objectContaining({ phase: "submitting", content: "pending" }),
      },
    })

    resolveSend()
    await request
  })

  it("sends an attachment-only snapshot in ready-card order", async () => {
    const sendPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({ activeSessionId: "session-1" })
    const attachments = [
      readyAttachment("draft-b", "asset-b"),
      readyAttachment("draft-a", "asset-a"),
    ]

    await useDesktopSessionStore.getState().sendMessage("", { attachments })

    expect(sendPrompt).toHaveBeenCalledWith({
      id: expect.any(String),
      sessionId: "session-1",
      items: [],
      attachments: [
        { assetId: "asset-b", intent: "auto", displayName: "asset-b.png" },
        { assetId: "asset-a", intent: "auto", displayName: "asset-a.png" },
      ],
    })
    expect(onlyPendingPromptSubmission()).toMatchObject({
      items: [],
      attachments: [
        { assetId: "asset-b", mediaType: "image/png", sizeBytes: 100 },
        { assetId: "asset-a", mediaType: "image/png", sizeBytes: 100 },
      ],
    })
  })

  it("does not send while any attachment is not ready", async () => {
    const sendPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({ activeSessionId: "session-1" })
    const uploading = { ...readyAttachment("draft-a", "asset-a"), status: "uploading" as const }

    await useDesktopSessionStore.getState().sendMessage("describe this", {
      attachments: [uploading],
    })

    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it("removes only the submitted attachment cards after acceptance", async () => {
    let resolveSend!: () => void
    const sendPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    const submitted = readyAttachment("draft-submitted", "asset-submitted")
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      composerDraftsByScope: {
        "session:session-1": { document: emptyComposerDocument, attachments: [submitted] },
      },
    })

    const request = useDesktopSessionStore.getState().sendMessage("", {
      attachments: [submitted],
    })
    const addedLater = readyAttachment("draft-later", "asset-later")
    useDesktopSessionStore.setState((state) => ({
      composerDraftsByScope: {
        ...state.composerDraftsByScope,
        "session:session-1": {
          document: emptyComposerDocument,
          attachments: [submitted, addedLater],
        },
      },
    }))
    resolveSend()
    await request

    expect(
      useDesktopSessionStore.getState().composerDraftsByScope["session:session-1"]?.attachments
    ).toEqual([addedLater])
  })

  it("keeps ready attachment cards when sending fails", async () => {
    const sendPrompt = vi.fn<(input: SendDesktopPromptInput) => Promise<void>>(async () => {
      throw new Error("offline")
    })
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    const attachment = readyAttachment("draft-a", "asset-a")
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      composerDraftsByScope: {
        "session:session-1": { document: emptyComposerDocument, attachments: [attachment] },
      },
    })

    await expect(
      useDesktopSessionStore.getState().sendMessage("", { attachments: [attachment] })
    ).rejects.toThrow("offline")

    expect(
      useDesktopSessionStore.getState().composerDraftsByScope["session:session-1"]?.attachments
    ).toEqual([attachment])
  })

  it("does not reuse a failed input id for a different ordered attachment snapshot", async () => {
    const sendPrompt = vi.fn<(input: SendDesktopPromptInput) => Promise<void>>(async () => {
      throw new Error("offline")
    })
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({ activeSessionId: "session-1" })
    const first = readyAttachment("draft-a", "asset-a")
    const second = readyAttachment("draft-b", "asset-b")

    await expect(
      useDesktopSessionStore.getState().sendMessage("same text", { attachments: [first] })
    ).rejects.toThrow("offline")
    await expect(
      useDesktopSessionStore.getState().sendMessage("same text", { attachments: [second] })
    ).rejects.toThrow("offline")

    expect(sendPrompt.mock.calls[0]?.[0].id).not.toBe(sendPrompt.mock.calls[1]?.[0].id)
  })

  it("submits a selected skill as an ordered item and keeps attachments", async () => {
    const sendPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({ activeSessionId: "session-1" })
    const document = composerDocument([
      { type: "text", text: "review " },
      { type: "skill", name: "review", path: "D:/skills/review/SKILL.md", displayName: "Review" },
      { type: "text", text: "this" },
    ])

    await useDesktopSessionStore.getState().sendMessage("", {
      document,
      attachments: [readyAttachment("draft-a", "asset-a")],
    })

    expect(sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        items: document.items,
        attachments: [{ assetId: "asset-a", intent: "auto", displayName: "asset-a.png" }],
      })
    )
  })

  it("submits a selected skill even when it has no task text", async () => {
    const sendPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({ activeSessionId: "session-1" })
    const document = composerDocument([
      { type: "skill", name: "archify", path: "D:/skills/archify/SKILL.md", displayName: "Archify" },
    ])

    await useDesktopSessionStore.getState().sendMessage("", { document })

    expect(sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ items: document.items })
    )
  })

  it("cleans an acknowledged send after its session loses the primary stream", async () => {
    let resolveOld!: () => void
    let resolveNew!: () => void
    const sendPrompt = vi.fn(
      ({ items }: { items: Array<{ type: string; text?: string }> }) =>
        new Promise<void>((resolve) => {
          if (items[0]?.text === "old") resolveOld = resolve
          else resolveNew = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-old",
      sessionView: null,
      sessionRuntimes: {
        "session-old": createEmptySessionRuntime(),
        "session-new": createEmptySessionRuntime(),
      },
    })

    const oldRequest = useDesktopSessionStore.getState().sendMessage("old")
    useDesktopSessionStore.setState({ activeSessionId: "session-new" })
    const newRequest = useDesktopSessionStore.getState().sendMessage("new")

    resolveOld()
    await oldRequest

    const runtimes = useDesktopSessionStore.getState().sessionRuntimes
    expect(runtimes["session-old"]!.operations).toEqual({})
    expect(runtimes["session-old"]!.pendingPromptSubmissions).toEqual({})
    expect(Object.values(runtimes["session-new"]!.operations)).toHaveLength(1)

    resolveNew()
    await newRequest
  })

  it("does not submit a second reply while the same permission is pending", async () => {
    let resolveReply!: () => void
    const replyPermission = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReply = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { replyPermission } } })
    useDesktopSessionStore.setState({ activeSessionId: "session-1" })

    const firstReply = useDesktopSessionStore.getState().replyPermission("permission-1", "approved")
    const secondReply = useDesktopSessionStore.getState().replyPermission("permission-1", "denied")

    expect(replyPermission).toHaveBeenCalledOnce()
    expect(replyPermission).toHaveBeenCalledWith({
      permissionId: "permission-1",
      status: "approved",
      decision: "once",
    })

    resolveReply()
    await Promise.all([firstReply, secondReply])
  })

  it("treats an SSE-confirmed input as success when IPC rejects later", async () => {
    let rejectSend!: (error: Error) => void
    const sendPrompt = vi.fn<
      (input: { id: string; sessionId: string; content: string }) => Promise<void>
    >(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: null,
      sessionRuntimes: { "session-1": createEmptySessionRuntime() },
    })

    const request = useDesktopSessionStore.getState().sendMessage("confirmed")
    const inputId = sendPrompt.mock.calls[0]![0].id
    useDesktopSessionStore
      .getState()
      .applySessionUpdate(viewContainingInput("session-1", inputId, 1))

    expect(useDesktopSessionStore.getState().sessionRuntimes["session-1"]).toMatchObject({
      operations: {},
      pendingPromptSubmissions: {},
    })
    rejectSend(new Error("response lost"))

    await expect(request).resolves.toBeUndefined()
    const runtime = useDesktopSessionStore.getState().sessionRuntimes["session-1"]!
    expect(runtime.pendingPromptSubmissions[inputId]).toMatchObject({ phase: "accepted" })
    expect(runtime.operations).toEqual({})
  })

  it("reconciles a queued action and its stable operation key when SSE reaches its run", async () => {
    let rejectPromote!: (error: Error) => void
    const promoteQueuedPrompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPromote = reject
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { promoteQueuedPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: null,
      sessionRuntimes: { "session-1": createEmptySessionRuntime() },
    })

    const request = useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-1", "run-1", "run-active")
    useDesktopSessionStore.getState().applySessionUpdate({
      ...viewContainingInput("session-1", "input-1", 1),
      runs: [
        {
          id: "run-1",
          sessionId: "session-1",
          inputId: "input-1",
          status: "interrupted",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })

    const runtime = useDesktopSessionStore.getState().sessionRuntimes["session-1"]!
    expect(runtime.queuedPromptActions).toEqual({})
    expect(runtime.operations).toEqual({})
    expect(createQueuedPromptActions).toBeTypeOf("function")

    rejectPromote(new Error("response lost"))
    await expect(request).resolves.toBeUndefined()
  })

  it("does not surface a late interrupt failure after SSE confirms the targeted run", async () => {
    let rejectInterrupt!: (error: Error) => void
    const interrupt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInterrupt = reject
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { interrupt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: {
        ...viewContainingInput("session-1", "input-1", 1),
        runs: [
          {
            id: "run-1",
            sessionId: "session-1",
            inputId: "input-1",
            status: "running",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      sessionRuntimes: { "session-1": createEmptySessionRuntime() },
    })

    const request = useDesktopSessionStore.getState().interrupt()
    useDesktopSessionStore.getState().applySessionUpdate({
      ...viewContainingInput("session-1", "input-1", 2),
      runs: [
        {
          id: "run-1",
          sessionId: "session-1",
          inputId: "input-1",
          status: "interrupted",
          metadata: {},
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })
    rejectInterrupt(new Error("response lost"))
    await expect(request).resolves.toBeUndefined()

    expect(useDesktopSessionStore.getState().sessionRuntimes["session-1"]!.operations).toEqual({})
  })
})
function onlyPendingPromptSubmission(
  sessionId?: string
): DesktopSessionRuntime["pendingPromptSubmissions"][string] {
  const currentSessionId = sessionId ?? useDesktopSessionStore.getState().activeSessionId
  const submissions = Object.values(
    currentSessionId
      ? (
          useDesktopSessionStore.getState().sessionRuntimes[currentSessionId] ??
          createEmptySessionRuntime()
        ).pendingPromptSubmissions
      : {}
  )
  expect(submissions).toHaveLength(1)
  return submissions[0]!
}

function readyAttachment(draftId: string, assetId: string): DesktopAttachmentDraft {
  return {
    draftId,
    taskId: `task-${draftId}`,
    displayName: `${assetId}.png`,
    declaredMediaType: "image/png",
    mediaType: "image/png",
    sizeBytes: 100,
    status: "ready",
    bytesUploaded: 100,
    progress: 1,
    assetId,
  }
}

function inputAttachment(
  id: string,
  assetId: string,
  seq: number,
  displayName: string
): DesktopSessionView["inputs"][number]["attachments"][number] {
  return {
    id,
    sessionId: "session-1",
    inputId: "input-1",
    assetId,
    seq,
    intent: "auto",
    displayName,
    mediaType: displayName.endsWith(".png") ? "image/png" : "application/pdf",
    sizeBytes: 10,
    metadata: {},
    createdAt: 1,
  }
}

describe("desktop session store prompt intent boundaries", () => {
  beforeEach(() => {
    useDesktopSessionStore.setState({
      activeSessionId: null,
      sessionView: null,
      newConversationRuntime: createEmptySessionRuntime(),
      sessionRuntimes: {},
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps normal composer sends on sendPrompt after an interrupted run", async () => {
    const sendPrompt = vi.fn(async () => undefined)
    const editLatestPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: { sessions: { sendPrompt, editLatestPrompt } },
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: {
        cursor: 1,
        syncStatus: "connected",
        session: {
          id: "session-1",
          cwd: "D:\\repo",
          title: "test",
          model: "test-model",
          status: "idle",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
        inputs: [],
        messages: [],
        parts: [],
        runs: [
          {
            id: "interrupted-run",
            sessionId: "session-1",
            status: "interrupted",
            metadata: {},
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        tasks: [],
        permissions: [],
      },
    })

    await useDesktopSessionStore.getState().sendMessage("new request")

    expect(sendPrompt).toHaveBeenCalledWith({
      id: expect.any(String),
      sessionId: "session-1",
      items: [{ type: "text", text: "new request" }],
      attachments: [],
    })
    expect(editLatestPrompt).not.toHaveBeenCalled()
  })

  it("does not let an old session request clear a newer session sending state", async () => {
    let resolveOld!: () => void
    let resolveNew!: () => void
    const sendPrompt = vi.fn(({ items }: { items: Array<{ type: string; text?: string }> }) => {
      return new Promise<void>((resolve) => {
        if (items[0]?.text === "old request") resolveOld = resolve
        else resolveNew = resolve
      })
    })
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-old",
    })

    const oldRequest = useDesktopSessionStore.getState().sendMessage("old request")
    useDesktopSessionStore.setState({ activeSessionId: "session-new" })
    const newRequest = useDesktopSessionStore.getState().sendMessage("new request")

    resolveOld()
    await oldRequest
    expect(useDesktopSessionStore.getState().activeSessionId).toBe("session-new")
    expect(selectSessionSending(useDesktopSessionStore.getState(), "session-new")).toBe(true)

    resolveNew()
    await newRequest
    expect(selectSessionSending(useDesktopSessionStore.getState(), "session-new")).toBe(false)
  })

  it("keeps a successful submission visible until the session stream confirms it", async () => {
    let resolveSend!: () => void
    const sendPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
    })

    const request = useDesktopSessionStore.getState().sendMessage("new request")

    expect(onlyPendingPromptSubmission()).toMatchObject({
      sessionId: "session-1",
      items: [{ type: "text" as const, text: "new request" }],
      content: "new request",
      phase: "submitting",
      placement: "transcript",
    })

    resolveSend()
    await request

    expect(onlyPendingPromptSubmission()).toMatchObject({
      sessionId: "session-1",
      items: [{ type: "text" as const, text: "new request" }],
      content: "new request",
      phase: "accepted",
      placement: "transcript",
    })
  })

  it("marks a submission as queued when another run is already active", async () => {
    let resolveSend!: () => void
    const sendPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    const runningView = emptySessionView("session-1")
    runningView.session.status = "running"
    runningView.runs = [
      {
        id: "run-active",
        sessionId: "session-1",
        inputId: "input-active",
        status: "running",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: runningView,
    })

    const request = useDesktopSessionStore.getState().sendMessage("queued request")

    expect(onlyPendingPromptSubmission()).toMatchObject({
      content: "queued request",
      phase: "submitting",
      placement: "queue",
    })

    resolveSend()
    await request
  })

  it("keeps multiple accepted submissions until each one is confirmed", async () => {
    const sendPrompt = vi.fn(async (input: { id: string; sessionId: string; content: string }) => {
      void input
    })
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
    })

    await useDesktopSessionStore.getState().sendMessage("first request")
    await useDesktopSessionStore.getState().sendMessage("second request")

    const firstCall = sendPrompt.mock.calls[0]!
    const secondCall = sendPrompt.mock.calls[1]!
    expect(Object.values(sessionRuntime("session-1").pendingPromptSubmissions)).toHaveLength(2)
    expect(sessionRuntime("session-1").pendingPromptSubmissions[firstCall[0].id]).toMatchObject({
      placement: "transcript",
    })
    expect(sessionRuntime("session-1").pendingPromptSubmissions[secondCall[0].id]).toMatchObject({
      placement: "queue",
    })

    useDesktopSessionStore.getState().applySessionUpdate({
      ...emptySessionView("session-1", 1),
      inputs: [
        {
          id: firstCall[0].id,
          sessionId: "session-1",
          seq: 1,
          delivery: "queue",
          items: [{ type: "text" as const, text: "first request" }],
          content: "first request",
          attachments: [],
          metadata: {},
          createdAt: 1,
        },
      ],
    })

    expect(Object.keys(sessionRuntime("session-1").pendingPromptSubmissions)).toEqual([
      firstCall[0].id,
      secondCall[0].id,
    ])

    useDesktopSessionStore.getState().applySessionUpdate({
      ...emptySessionView("session-1", 2),
      messages: [{
        id: "message-first",
        sessionId: "session-1",
        seq: 1,
        role: "user",
        inputId: firstCall[0].id,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }],
    })

    expect(Object.keys(sessionRuntime("session-1").pendingPromptSubmissions)).toEqual([
      firstCall[0].id,
      secondCall[0].id,
    ])
    useDesktopSessionStore.getState().applySessionUpdate({
      ...emptySessionView("session-1", 3),
      messages: [{
        id: "message-first",
        sessionId: "session-1",
        seq: 1,
        role: "user",
        inputId: firstCall[0].id,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }],
      parts: [{
        id: "part-first",
        sessionId: "session-1",
        messageId: "message-first",
        seq: 1,
        type: "text",
        status: "completed",
        text: "first request",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }],
    })

    expect(Object.keys(sessionRuntime("session-1").pendingPromptSubmissions)).toEqual([
      secondCall[0].id,
    ])
  })

  it("treats an SSE-confirmed submission as successful when the IPC response is lost", async () => {
    let rejectSend!: (error: Error) => void
    const sendPrompt = vi.fn((input: { id: string; sessionId: string; content: string }) => {
      void input
      return new Promise<void>((_resolve, reject) => {
        rejectSend = reject
      })
    })
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
    })

    const request = useDesktopSessionStore.getState().sendMessage("confirmed request")
    const inputId = sendPrompt.mock.calls[0]![0].id
    useDesktopSessionStore.getState().applySessionUpdate({
      ...emptySessionView("session-1", 1),
      inputs: [
        {
          id: inputId,
          sessionId: "session-1",
          seq: 1,
          delivery: "queue",
          items: [{ type: "text" as const, text: "confirmed request" }],
          content: "confirmed request",
          attachments: [],
          metadata: {},
          createdAt: 1,
        },
      ],
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-2",
      sessionView: emptySessionView("session-2", 1),
    })
    rejectSend(new Error("response lost"))

    await expect(request).resolves.toBeUndefined()
    expect(sessionRuntime("session-1").pendingPromptSubmissions).toEqual({})
  })

  it("reuses the same input id when an uncertain send is retried", async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(undefined)
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
    })

    await expect(useDesktopSessionStore.getState().sendMessage("retry me")).rejects.toThrow(
      "response lost"
    )
    await useDesktopSessionStore.getState().sendMessage("retry me")

    expect(sendPrompt).toHaveBeenCalledTimes(2)
    expect(sendPrompt.mock.calls[1]?.[0].id).toBe(sendPrompt.mock.calls[0]?.[0].id)
    expect(onlyPendingPromptSubmission()).toMatchObject({
      content: "retry me",
      phase: "accepted",
    })
  })

  it("includes the selected source message when explicitly editing", async () => {
    const editLatestPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: { sessions: { editLatestPrompt } },
    })
    useDesktopSessionStore.setState({ activeSessionId: "session-1" })

    await useDesktopSessionStore.getState().editLatestMessage("message-1", "replacement")

    expect(editLatestPrompt).toHaveBeenCalledWith({
      id: expect.any(String),
      sessionId: "session-1",
      sourceMessageId: "message-1",
      items: [{ type: "text", text: "replacement" }],
      attachments: [],
    })
  })

  it("preserves structured items when editing a task with a selected skill", async () => {
    const editLatestPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", { desktop: { sessions: { editLatestPrompt } } })
    const view = emptySessionView("session-1", 1)
    const originalItems = [
      { type: "skill" as const, name: "archify", path: "D:/skills/archify/SKILL.md" },
      { type: "text" as const, text: "旧任务" },
    ]
    const editedDocument = composerDocument([
      { type: "skill", name: "archify", path: "D:/skills/archify/SKILL.md" },
      { type: "text", text: "新任务" },
    ])
    view.messages = [
      {
        id: "message-skill",
        sessionId: "session-1",
        seq: 1,
        role: "user",
        inputId: "input-skill",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    view.inputs = [
      {
        id: "input-skill",
        sessionId: "session-1",
        seq: 1,
        delivery: "queue",
        items: originalItems,
        content: "旧任务",
        attachments: [],
        metadata: {},
        createdAt: 1,
      },
    ]
    useDesktopSessionStore.setState({ activeSessionId: "session-1", sessionView: view })

    await useDesktopSessionStore.getState().editLatestMessage("message-skill", "", editedDocument)

    expect(editLatestPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMessageId: "message-skill",
        items: editedDocument.items,
      })
    )
  })

  it("preserves authoritative ordered attachment refs when editing a pure-attachment message", async () => {
    const editLatestPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", { desktop: { sessions: { editLatestPrompt } } })
    const view = emptySessionView("session-1", 1)
    view.messages = [
      {
        id: "message-1",
        sessionId: "session-1",
        seq: 1,
        role: "user",
        inputId: "input-1",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    view.inputs = [
      {
        id: "input-1",
        sessionId: "session-1",
        seq: 1,
        delivery: "queue",
        items: [{ type: "text" as const, text: "" }],
        content: "",
        attachments: [
          inputAttachment("attachment-b", "asset-b", 0, "b.png"),
          inputAttachment("attachment-a", "asset-a", 1, "a.pdf"),
        ],
        metadata: {},
        createdAt: 1,
      },
    ]
    useDesktopSessionStore.setState({ activeSessionId: "session-1", sessionView: view })

    await useDesktopSessionStore.getState().editLatestMessage("message-1", "")

    expect(editLatestPrompt).toHaveBeenCalledWith({
      id: expect.any(String),
      sessionId: "session-1",
      sourceMessageId: "message-1",
      items: [],
      attachments: [
        { assetId: "asset-b", intent: "auto", displayName: "b.png" },
        { assetId: "asset-a", intent: "auto", displayName: "a.pdf" },
      ],
    })
  })

  it("reuses the same edit id when an uncertain edit is retried", async () => {
    const editLatestPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(undefined)
    vi.stubGlobal("window", {
      desktop: { sessions: { editLatestPrompt } },
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
    })

    await expect(
      useDesktopSessionStore.getState().editLatestMessage("message-1", "replacement")
    ).rejects.toThrow("response lost")
    await useDesktopSessionStore.getState().editLatestMessage("message-1", "replacement")

    expect(editLatestPrompt).toHaveBeenCalledTimes(2)
    expect(editLatestPrompt.mock.calls[1]?.[0].id).toBe(editLatestPrompt.mock.calls[0]?.[0].id)
    expect(sessionRuntime("session-1").pendingPromptEdit).toBeNull()
  })

  it("does not let an old edit settle a newer session send", async () => {
    let resolveEdit!: () => void
    let resolveSend!: () => void
    const editLatestPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveEdit = resolve
        })
    )
    const sendPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        })
    )
    vi.stubGlobal("window", {
      desktop: { sessions: { editLatestPrompt, sendPrompt } },
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
    })

    const editing = useDesktopSessionStore.getState().editLatestMessage("message-1", "replacement")
    useDesktopSessionStore.setState({
      activeSessionId: "session-2",
    })
    const sending = useDesktopSessionStore.getState().sendMessage("new session request")

    resolveEdit()
    await editing
    expect(useDesktopSessionStore.getState().activeSessionId).toBe("session-2")
    expect(selectSessionSending(useDesktopSessionStore.getState(), "session-2")).toBe(true)

    resolveSend()
    await sending
    expect(selectSessionSending(useDesktopSessionStore.getState(), "session-2")).toBe(false)
  })

  it("binds stop to the active run visible at click time", async () => {
    const interrupt = vi.fn(async () => undefined)
    vi.stubGlobal("window", { desktop: { sessions: { interrupt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: {
        ...emptySessionView("session-1"),
        runs: [
          {
            id: "run-at-click",
            sessionId: "session-1",
            status: "running",
            metadata: {},
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
    })

    await useDesktopSessionStore.getState().interrupt()

    expect(interrupt).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedRunId: "run-at-click",
    })
  })

  it("promotes and cancels the exact durable queued prompt", async () => {
    const promoteQueuedPrompt = vi.fn(async () => undefined)
    const cancelQueuedPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: { sessions: { promoteQueuedPrompt, cancelQueuedPrompt } },
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
    })

    await useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")
    await useDesktopSessionStore.getState().cancelQueuedPrompt("input-other", "run-other")

    expect(promoteQueuedPrompt).toHaveBeenCalledWith({
      sessionId: "session-1",
      inputId: "input-queued",
      queuedRunId: "run-queued",
      expectedActiveRunId: "run-active",
    })
    expect(cancelQueuedPrompt).toHaveBeenCalledWith({
      sessionId: "session-1",
      inputId: "input-other",
      queuedRunId: "run-other",
    })
    expect(Object.values(sessionRuntime("session-1").queuedPromptActions)).toEqual([
      expect.objectContaining({ runId: "run-queued", phase: "acknowledged" }),
      expect.objectContaining({ runId: "run-other", phase: "acknowledged" }),
    ])
  })

  it("keeps a promoted run acknowledged until the session stream confirms it", async () => {
    let resolvePromote!: () => void
    const promoteQueuedPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePromote = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { promoteQueuedPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
    })

    const request = useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")

    expect(sessionRuntime("session-1").queuedPromptActions).toMatchObject({
      "session-1:run-queued": {
        sessionId: "session-1",
        runId: "run-queued",
        kind: "promote",
        phase: "pending",
      },
    })

    resolvePromote()
    await request

    expect(sessionRuntime("session-1").queuedPromptActions).toMatchObject({
      "session-1:run-queued": {
        sessionId: "session-1",
        runId: "run-queued",
        kind: "promote",
        phase: "acknowledged",
      },
    })
  })

  it("cleans an acknowledged queue action after its session loses the primary stream", async () => {
    let resolvePromote!: () => void
    const promoteQueuedPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePromote = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { promoteQueuedPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
    })

    const request = useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")
    useDesktopSessionStore.setState({ activeSessionId: "session-2" })
    resolvePromote()
    await request

    expect(sessionRuntime("session-1").queuedPromptActions).toEqual({})
    expect(sessionRuntime("session-1").operations).toEqual({})
  })

  it("does not report an action failure after SSE already confirmed it", async () => {
    let rejectPromote!: (error: Error) => void
    const promoteQueuedPrompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPromote = reject
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { promoteQueuedPrompt } } })
    const pendingView = emptySessionView("session-1", 1)
    pendingView.runs = [
      {
        id: "run-queued",
        sessionId: "session-1",
        inputId: "input-queued",
        status: "pending",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: pendingView,
    })

    const request = useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")
    useDesktopSessionStore.getState().applySessionUpdate({
      ...pendingView,
      cursor: 2,
      runs: [{ ...pendingView.runs[0], status: "interrupted", updatedAt: 2 }],
    })
    useDesktopSessionStore.setState({
      activeSessionId: "session-2",
      sessionView: emptySessionView("session-2", 1),
    })
    rejectPromote(new Error("response lost"))
    await request

    expect(sessionRuntime("session-1").queuedPromptActions).toEqual({})
  })

  it("keeps an action failure on its queued run with a readable message", async () => {
    const promoteQueuedPrompt = vi.fn(async () => {
      throw new Error("Active run changed")
    })
    vi.stubGlobal("window", { desktop: { sessions: { promoteQueuedPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
    })

    await useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")

    expect(sessionRuntime("session-1").queuedPromptActions).toMatchObject({
      "session-1:run-queued": {
        phase: "failed",
        error: "当前回答已经切换，这条消息仍保留在待处理队列中。",
      },
    })
  })

  it("does not leak an old session action error into the newly opened session", async () => {
    let rejectPromote!: (error: Error) => void
    const promoteQueuedPrompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPromote = reject
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { promoteQueuedPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
    })

    const request = useDesktopSessionStore
      .getState()
      .promoteQueuedPrompt("input-queued", "run-queued", "run-active")
    useDesktopSessionStore.setState({ activeSessionId: "session-2" })
    rejectPromote(new Error("Active run changed"))
    await request

    expect(selectActiveSessionQueuedPromptActions(useDesktopSessionStore.getState())).toEqual({})
    expect(
      useDesktopSessionStore.getState().sessionRuntimes["session-1"]?.queuedPromptActions
    ).toMatchObject({
      "session-1:run-queued": { phase: "failed" },
    })
  })

  it("clears an acknowledged queue action when SSE reports the run terminal", () => {
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionRuntimes: {
        "session-1": {
          ...createEmptySessionRuntime(),
          queuedPromptActions: {
            "session-1:run-queued": {
              sessionId: "session-1",
              inputId: "input-queued",
              runId: "run-queued",
              kind: "promote",
              phase: "acknowledged",
            },
          },
        },
      },
      sessionView: null,
    })

    useDesktopSessionStore.getState().applySessionUpdate({
      cursor: 9,
      syncStatus: "connected",
      session: {
        id: "session-1",
        cwd: "D:\\repo",
        title: "test",
        model: "test-model",
        status: "running",
        metadata: {},
        createdAt: 1,
        updatedAt: 9,
      },
      inputs: [],
      messages: [],
      parts: [],
      runs: [
        {
          id: "run-queued",
          sessionId: "session-1",
          inputId: "input-queued",
          status: "interrupted",
          metadata: {},
          createdAt: 2,
          updatedAt: 9,
        },
      ],
      tasks: [],
      permissions: [],
    })

    expect(sessionRuntime("session-1").queuedPromptActions).toEqual({})
  })
})
