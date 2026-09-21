import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopSessionView } from "@shared/session-types"
import type { DesktopAttachmentDraft } from "@shared/attachment-types"
import { beginOperation, createEmptySessionRuntime } from "./operation-state"
import {
  selectActiveSessionOpening,
  selectActiveSessionSending,
  selectNewConversationSending,
} from "./selectors"
import {
  projectDetails,
  refreshedBootstrap,
  resetDesktopSessionStore,
  sessionRuntime,
} from "./store-test-fixtures"
import { sessionEffort } from "./helpers"
import { useDesktopSessionStore } from "./store"
import type { DesktopSessionRuntime } from "./types"
import { composerDocument, emptyComposerDocument } from "./composer-document"

function emptySessionView(sessionId: string, cursor = 0): DesktopSessionView {
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
      updatedAt: 1,
    },
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    tasks: [],
    permissions: [],
  }
}

function resetNewConversationState(): void {
  useDesktopSessionStore.setState({
    projects: [],
    sessions: [],
    archivedSessions: [],
    workspaceMode: "outside_project",
    selectedProject: null,
    selectedModel: "test-model",
    selectedProvider: null,
    defaultModel: "test-model",
    defaultProvider: null,
    selectedPermissionMode: "default",
    activeSessionId: null,
    sessionView: null,
    newConversationRuntime: {
      operations: {},
      pendingPromptSubmissions: {},
      pendingPromptEdit: null,
      queuedPromptActions: {},
    },
    sessionRuntimes: {},
  })
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

describe("desktop session actions", () => {
  beforeEach(() => {
    resetDesktopSessionStore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("sends a pure-attachment first prompt and clears only its migrated snapshot", async () => {
    const session = emptySessionView("session-created").session
    const sendPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open: vi.fn(async () => emptySessionView(session.id, 1)),
          sendPrompt,
        },
      },
    })
    resetNewConversationState()
    const attachment = readyAttachment("draft-first", "asset-first")
    useDesktopSessionStore.setState({
      composerDraftsByScope: {
        "new-conversation": { document: emptyComposerDocument, attachments: [attachment] },
      },
    })

    await useDesktopSessionStore.getState().startSession("", { attachments: [attachment] })

    expect(sendPrompt).toHaveBeenCalledWith({
      id: expect.any(String),
      sessionId: session.id,
      items: [],
      attachments: [{ assetId: "asset-first", intent: "auto", displayName: "asset-first.png" }],
    })
    expect(useDesktopSessionStore.getState().composerDraftsByScope).toEqual({
      [`session:${session.id}`]: { document: emptyComposerDocument, attachments: [] },
    })
    expect(useDesktopSessionStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: session.id, title: "asset-first.png" })
    )
  })

  it("starts a session with ordered structured items through the normal prompt API", async () => {
    const session = emptySessionView("session-skill").session
    const sendPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open: vi.fn(async () => emptySessionView(session.id, 1)),
          sendPrompt,
        },
      },
    })
    resetNewConversationState()
    const document = composerDocument([
      { type: "text", text: "画" },
      { type: "skill", name: "archify", path: "D:/skills/archify/SKILL.md", displayName: "Archify" },
      { type: "text", text: "架构图" },
    ])

    await useDesktopSessionStore.getState().startSession("", { document })

    expect(sendPrompt).toHaveBeenCalledWith({
      id: expect.any(String),
      sessionId: session.id,
      items: document.items,
      attachments: [],
    })
  })

  it("clears the migrated structured draft after it is submitted", async () => {
    const session = emptySessionView("session-slash").session
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open: vi.fn(async () => emptySessionView(session.id, 1)),
          sendPrompt: vi.fn(async () => undefined),
        },
      },
    })
    resetNewConversationState()
    const document = composerDocument([
      { type: "skill", name: "archify", path: "D:/skills/archify/SKILL.md", displayName: "Archify" },
      { type: "text", text: " AI新闻" },
    ])
    useDesktopSessionStore.setState({
      composerDraftsByScope: {
        "new-conversation": {
          document,
          attachments: [],
        },
      },
    })

    await useDesktopSessionStore.getState().startSession("", { document })

    expect(useDesktopSessionStore.getState().composerDraftsByScope[`session:${session.id}`]?.document).toEqual(
      emptyComposerDocument
    )
  })

  it("clears the migrated first-prompt draft while sending is still pending", async () => {
    const session = emptySessionView("session-created").session
    let resolveSend!: () => void
    const sendPrompt = vi.fn(
      () => new Promise<void>((resolve) => (resolveSend = resolve))
    )
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open: vi.fn(async () => emptySessionView(session.id, 1)),
          sendPrompt,
        },
      },
    })
    resetNewConversationState()
    const attachment = readyAttachment("draft-first", "asset-first")
    useDesktopSessionStore.setState({
      composerDraftsByScope: {
        "new-conversation": {
          document: composerDocument([{ type: "text", text: "说明" }]),
          attachments: [attachment],
        },
      },
    })

    const starting = useDesktopSessionStore
      .getState()
      .startSession("说明", { attachments: [attachment] })
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledOnce())
    const draftWhileSending =
      useDesktopSessionStore.getState().composerDraftsByScope[`session:${session.id}`]
    resolveSend()
    await starting

    expect(draftWhileSending).toEqual({ document: emptyComposerDocument, attachments: [] })
  })

  it("keeps the new-conversation attachment draft when create fails", async () => {
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => {
            throw new Error("create failed")
          }),
        },
      },
    })
    resetNewConversationState()
    const attachment = readyAttachment("draft-first", "asset-first")
    const draft = {
      document: composerDocument([{ type: "text", text: "说明" }]),
      attachments: [attachment],
    }
    useDesktopSessionStore.setState({
      composerDraftsByScope: { "new-conversation": draft },
    })

    await expect(
      useDesktopSessionStore.getState().startSession("说明", { attachments: [attachment] })
    ).rejects.toThrow("create failed")

    expect(useDesktopSessionStore.getState().composerDraftsByScope["new-conversation"]).toEqual(
      draft
    )
  })

  it("moves the draft once to the created session when opening it fails", async () => {
    const session = emptySessionView("session-created").session
    const sendPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open: vi.fn(async () => {
            throw new Error("open failed")
          }),
          sendPrompt,
        },
      },
    })
    resetNewConversationState()
    const attachment = readyAttachment("draft-first", "asset-first")
    useDesktopSessionStore.setState({
      composerDraftsByScope: {
        "new-conversation": {
          document: composerDocument([{ type: "text", text: "说明" }]),
          attachments: [attachment],
        },
      },
    })

    await expect(
      useDesktopSessionStore.getState().startSession("说明", { attachments: [attachment] })
    ).rejects.toThrow("open failed")

    expect(sendPrompt).not.toHaveBeenCalled()
    expect(useDesktopSessionStore.getState().composerDraftsByScope).toEqual({
      [`session:${session.id}`]: {
        document: composerDocument([{ type: "text", text: "说明" }]),
        attachments: [attachment],
      },
    })
  })

  it("keeps the migrated text and ready cards when first-prompt sending fails", async () => {
    const session = emptySessionView("session-created").session
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open: vi.fn(async () => emptySessionView(session.id, 1)),
          sendPrompt: vi.fn(async () => {
            throw new Error("send failed")
          }),
        },
      },
    })
    resetNewConversationState()
    const attachment = readyAttachment("draft-first", "asset-first")
    useDesktopSessionStore.setState({
      composerDraftsByScope: {
        "new-conversation": {
          document: composerDocument([{ type: "text", text: "说明" }]),
          attachments: [attachment],
        },
      },
    })

    await expect(
      useDesktopSessionStore.getState().startSession("说明", { attachments: [attachment] })
    ).rejects.toThrow("send failed")

    expect(useDesktopSessionStore.getState().composerDraftsByScope).toEqual({
      [`session:${session.id}`]: {
        document: composerDocument([{ type: "text", text: "说明" }]),
        attachments: [attachment],
      },
    })
  })

  it("does not let a late create steal the primary subscription", async () => {
    const sessionA = emptySessionView("session-a").session
    let resolveCreate!: (session: typeof sessionA) => void
    const create = vi.fn(
      () =>
        new Promise<typeof sessionA>((resolve) => {
          resolveCreate = resolve
        })
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId, 1))
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create,
          open,
          sendPrompt: vi.fn(async () => undefined),
        },
      },
    })
    resetNewConversationState()

    const starting = useDesktopSessionStore.getState().startSession("start A")
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    await useDesktopSessionStore.getState().openSession("session-b")
    resolveCreate(sessionA)
    await starting

    expect(useDesktopSessionStore.getState().activeSessionId).toBe("session-b")
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith("session-b")
  })

  it("keeps the first optimistic prompt until the transcript projects its user message", async () => {
    const session = emptySessionView("session-created").session
    let resolvePrompt!: () => void
    const sendPrompt = vi.fn<
      (input: { id: string; sessionId: string; content: string }) => Promise<void>
    >(
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve
        })
    )
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open: vi.fn(async (sessionId: string) => emptySessionView(sessionId, 1)),
          sendPrompt,
        },
      },
    })
    resetNewConversationState()

    const starting = useDesktopSessionStore.getState().startSession("first prompt")
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledOnce())
    const inputId = sendPrompt.mock.calls[0]![0].id

    expect(useDesktopSessionStore.getState().activeSessionId).toBe(session.id)
    expect(selectActiveSessionSending(useDesktopSessionStore.getState())).toBe(true)

    useDesktopSessionStore.getState().applySessionUpdate(emptySessionView(session.id, 2))

    expect(selectActiveSessionSending(useDesktopSessionStore.getState())).toBe(true)

    resolvePrompt()
    await starting

    expect(useDesktopSessionStore.getState().sessionRuntimes[session.id]).toMatchObject({
      pendingPromptSubmissions: {
        [inputId]: expect.objectContaining({ phase: "accepted" }),
      },
    })
    expect(selectActiveSessionSending(useDesktopSessionStore.getState())).toBe(false)

    const confirmed = emptySessionView(session.id, 3)
    confirmed.inputs = [{ id: inputId }] as DesktopSessionView["inputs"]
    useDesktopSessionStore.getState().applySessionUpdate(confirmed)

    expect(
      useDesktopSessionStore.getState().sessionRuntimes[session.id]?.pendingPromptSubmissions
    ).toHaveProperty(inputId)

    confirmed.messages = [{
      id: "message-confirmed",
      sessionId: session.id,
      seq: 1,
      role: "user",
      inputId,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }]
    useDesktopSessionStore.getState().applySessionUpdate(confirmed)

    expect(
      useDesktopSessionStore.getState().sessionRuntimes[session.id]?.pendingPromptSubmissions
    ).toEqual({})
  })

  it("keeps a new blank conversation writable when an older create resolves", async () => {
    const oldSession = emptySessionView("session-old").session
    const newSession = emptySessionView("session-new").session
    const createResolvers: Array<(session: typeof oldSession) => void> = []
    const create = vi.fn(
      () =>
        new Promise<typeof oldSession>((resolve) => {
          createResolvers.push(resolve)
        })
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId, 1))
    const sendPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: { sessions: { create, open, sendPrompt, close: vi.fn(async () => undefined) } },
    })
    resetNewConversationState()

    const oldStarting = useDesktopSessionStore.getState().startSession("old prompt")
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await useDesktopSessionStore.getState().startNewConversation()

    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: null,
      newConversationRuntime: { operations: {} },
    })
    expect(selectNewConversationSending(useDesktopSessionStore.getState())).toBe(false)

    const newStarting = useDesktopSessionStore.getState().startSession("new prompt")
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    const newOperationId = Object.keys(
      useDesktopSessionStore.getState().newConversationRuntime.operations
    )[0]

    createResolvers[0]!(oldSession)
    await oldStarting

    expect(useDesktopSessionStore.getState().activeSessionId).toBeNull()
    expect(selectNewConversationSending(useDesktopSessionStore.getState())).toBe(true)
    expect(newOperationId).toBeDefined()
    expect(open).not.toHaveBeenCalledWith(oldSession.id)
    expect(sendPrompt).toHaveBeenCalledWith({
      id: expect.any(String),
      sessionId: oldSession.id,
      items: [{ type: "text", text: "old prompt" }],
      attachments: [],
    })

    createResolvers[1]!(newSession)
    await newStarting
  })

  it("cleans a background create after its first prompt is accepted", async () => {
    const session = emptySessionView("session-background").session
    let resolveCreate!: (created: DesktopSessionView["session"]) => void
    const create = vi.fn(
      () =>
        new Promise<DesktopSessionView["session"]>((resolve) => {
          resolveCreate = resolve
        })
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId, 1))
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create,
          open,
          sendPrompt: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
        },
      },
    })
    resetNewConversationState()

    const starting = useDesktopSessionStore.getState().startSession("background prompt")
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    await useDesktopSessionStore.getState().startNewConversation()
    resolveCreate(session)
    await starting

    const backgroundRuntime = useDesktopSessionStore.getState().sessionRuntimes[session.id]
    expect(backgroundRuntime?.operations).toEqual({})
    expect(backgroundRuntime?.pendingPromptSubmissions).toEqual({})
    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: null,
      newConversationRuntime: { operations: {} },
    })
    expect(selectNewConversationSending(useDesktopSessionStore.getState())).toBe(false)
  })

  it("does not let a pending create reclaim a conversation started from another session", async () => {
    const created = emptySessionView("session-created").session
    const source = emptySessionView("session-source").session
    let resolveCreate!: (session: typeof created) => void
    const create = vi.fn(
      () =>
        new Promise<typeof created>((resolve) => {
          resolveCreate = resolve
        })
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId, 1))
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create,
          open,
          sendPrompt: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
        },
      },
    })
    resetNewConversationState()

    const starting = useDesktopSessionStore.getState().startSession("older prompt")
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    await useDesktopSessionStore.getState().startConversationFrom(source)

    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: null,
      newConversationRuntime: { operations: {} },
      selectedModel: source.model,
    })
    expect(selectNewConversationSending(useDesktopSessionStore.getState())).toBe(false)

    resolveCreate(created)
    await starting

    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: null,
      sessionView: null,
    })
    expect(selectNewConversationSending(useDesktopSessionStore.getState())).toBe(false)
    expect(open).not.toHaveBeenCalledWith(created.id)
  })

  it("does not let an older open snapshot replace a newer SSE view", async () => {
    let resolveOpen!: (view: DesktopSessionView) => void
    const open = vi.fn(
      () =>
        new Promise<DesktopSessionView>((resolve) => {
          resolveOpen = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { open } } })
    resetNewConversationState()

    const opening = useDesktopSessionStore.getState().openSession("session-1")
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("session-1"))
    useDesktopSessionStore.getState().applySessionUpdate(emptySessionView("session-1", 5))
    resolveOpen(emptySessionView("session-1", 2))
    await opening

    expect(useDesktopSessionStore.getState().sessionView?.cursor).toBe(5)
  })

  it("keeps the reopened session runtime scoped to the active session", async () => {
    const oldRuntime = {
      ...createEmptySessionRuntime(),
      pendingPromptSubmissions: {
        "input-old": {
          id: "input-old",
          sessionId: "session-old",
          items: [{ type: "text" as const, text: "old prompt" }],
          content: "old prompt",
          attachments: [],
          createdAt: 1,
          phase: "failed" as const,
          placement: "transcript" as const,
          error: "old error",
        },
      },
    }
    const reopenedRuntime = beginOperation(
      {
        ...createEmptySessionRuntime(),
        pendingPromptSubmissions: {
          "input-new": {
            id: "input-new",
            sessionId: "session-new",
            items: [{ type: "text" as const, text: "new prompt" }],
            content: "new prompt",
            attachments: [],
            createdAt: 2,
            phase: "submitting",
            placement: "queue",
          },
        },
        pendingPromptEdit: {
          id: "edit-new",
          sessionId: "session-new",
          sourceMessageId: "message-new",
          items: [{ type: "text" as const, text: "edited prompt" }],
          content: "edited prompt",
          attachments: [],
        },
        queuedPromptActions: {
          "session-new:run-new": {
            sessionId: "session-new",
            inputId: "input-queued",
            runId: "run-new",
            kind: "cancel",
            phase: "failed",
            error: "cancel error",
          },
        },
      },
      {
        id: "input-new",
        kind: "send-prompt",
        sessionId: "session-new",
        startedAt: 2,
      }
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId, 1))
    vi.stubGlobal("window", { desktop: { sessions: { open } } })
    resetNewConversationState()
    useDesktopSessionStore.setState({
      activeSessionId: "session-old",
      sessionView: emptySessionView("session-old", 1),
      sessionRuntimes: {
        "session-old": oldRuntime,
        "session-new": reopenedRuntime,
      },
    })

    await useDesktopSessionStore.getState().openSession("session-new")

    expect(useDesktopSessionStore.getState().activeSessionId).toBe("session-new")
    expect(selectActiveSessionSending(useDesktopSessionStore.getState())).toBe(true)
    expect(useDesktopSessionStore.getState().sessionRuntimes["session-new"]).toMatchObject({
      pendingPromptSubmissions: {
        "input-new": expect.objectContaining({ content: "new prompt", phase: "submitting" }),
      },
      pendingPromptEdit: expect.objectContaining({ id: "edit-new" }),
      queuedPromptActions: {
        "session-new:run-new": expect.objectContaining({ phase: "failed" }),
      },
    })
    expect(
      useDesktopSessionStore.getState().sessionRuntimes["session-new"]?.pendingPromptSubmissions
    ).not.toHaveProperty("input-old")
  })

  it("only lets the latest same-session open request apply its snapshot", async () => {
    const resolvers: Array<(view: DesktopSessionView) => void> = []
    const open = vi.fn(
      () =>
        new Promise<DesktopSessionView>((resolve) => {
          resolvers.push(resolve)
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { open } } })
    resetNewConversationState()

    const firstOpening = useDesktopSessionStore.getState().openSession("session-1")
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    const secondOpening = useDesktopSessionStore.getState().openSession("session-1")
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))

    resolvers[0]!(emptySessionView("session-1", 20))
    await firstOpening

    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: "session-1",
      sessionView: null,
    })
    expect(selectActiveSessionOpening(useDesktopSessionStore.getState())).toBe(true)

    resolvers[1]!(emptySessionView("session-1", 2))
    await secondOpening

    expect(useDesktopSessionStore.getState().sessionView?.cursor).toBe(2)
  })

  it("does not let the first A open win after A/B/A navigation", async () => {
    const aResolvers: Array<(view: DesktopSessionView) => void> = []
    const open = vi.fn((sessionId: string) => {
      if (sessionId === "session-b") return Promise.resolve(emptySessionView(sessionId, 5))
      return new Promise<DesktopSessionView>((resolve) => {
        aResolvers.push(resolve)
      })
    })
    vi.stubGlobal("window", { desktop: { sessions: { open } } })
    resetNewConversationState()

    const firstA = useDesktopSessionStore.getState().openSession("session-a")
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    await useDesktopSessionStore.getState().openSession("session-b")
    const secondA = useDesktopSessionStore.getState().openSession("session-a")
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(3))

    aResolvers[0]!(emptySessionView("session-a", 30))
    await firstA
    aResolvers[1]!(emptySessionView("session-a", 3))
    await secondA

    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: "session-a",
      sessionView: { cursor: 3, session: { id: "session-a" } },
    })
  })

  it("does not let a late fork steal the primary subscription", async () => {
    const source = emptySessionView("session-a").session
    const forked = { ...emptySessionView("session-fork").session, title: "forked" }
    let resolveFork!: (session: typeof forked) => void
    const fork = vi.fn(
      () =>
        new Promise<typeof forked>((resolve) => {
          resolveFork = resolve
        })
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId, 1))
    vi.stubGlobal("window", { desktop: { sessions: { fork, open } } })
    resetNewConversationState()
    useDesktopSessionStore.setState({ sessions: [source], activeSessionId: source.id })

    const forking = useDesktopSessionStore.getState().forkSession(source.id)
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce())
    await useDesktopSessionStore.getState().openSession("session-b")
    resolveFork(forked)
    await forking

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith("session-b")
    expect(useDesktopSessionStore.getState().sessions).toContainEqual(forked)
  })

  it("does not let a late fork steal the primary subscription after A/B/A navigation", async () => {
    const source = emptySessionView("session-a").session
    const forked = { ...emptySessionView("session-fork").session, title: "forked" }
    let resolveFork!: (session: typeof forked) => void
    const fork = vi.fn(
      () =>
        new Promise<typeof forked>((resolve) => {
          resolveFork = resolve
        })
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId, 1))
    vi.stubGlobal("window", { desktop: { sessions: { fork, open } } })
    resetNewConversationState()
    useDesktopSessionStore.setState({ sessions: [source], activeSessionId: source.id })

    const forking = useDesktopSessionStore.getState().forkSession(source.id)
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce())
    await useDesktopSessionStore.getState().openSession("session-b")
    await useDesktopSessionStore.getState().openSession(source.id)
    resolveFork(forked)
    await forking

    expect(open).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenNthCalledWith(1, "session-b")
    expect(open).toHaveBeenNthCalledWith(2, source.id)
    expect(useDesktopSessionStore.getState().activeSessionId).toBe(source.id)
    expect(useDesktopSessionStore.getState().sessions).toContainEqual(forked)
  })

  it("invalidates a pending fork when archiving its current primary session", async () => {
    const source = emptySessionView("session-a").session
    const archived = { ...source, status: "archived" as const }
    const forked = emptySessionView("session-fork").session
    let resolveFork!: (session: typeof forked) => void
    let resolveArchive!: (session: typeof archived) => void
    const fork = vi.fn(
      () =>
        new Promise<typeof forked>((resolve) => {
          resolveFork = resolve
        })
    )
    const archive = vi.fn(
      () =>
        new Promise<typeof archived>((resolve) => {
          resolveArchive = resolve
        })
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId))
    vi.stubGlobal("window", { desktop: { sessions: { fork, archive, open } } })
    resetNewConversationState()
    useDesktopSessionStore.setState({ sessions: [source], activeSessionId: source.id })

    const forking = useDesktopSessionStore.getState().forkSession(source.id)
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce())
    const archiving = useDesktopSessionStore.getState().archiveSession(source.id)
    await vi.waitFor(() => expect(archive).toHaveBeenCalledWith(source.id))
    resolveFork(forked)
    await forking
    resolveArchive(archived)
    await archiving

    expect(open).not.toHaveBeenCalled()
    expect(useDesktopSessionStore.getState().activeSessionId).toBeNull()
  })

  it("invalidates a pending fork when deleting its current primary session", async () => {
    const source = emptySessionView("session-a").session
    const forked = emptySessionView("session-fork").session
    let resolveFork!: (session: typeof forked) => void
    let resolveDelete!: (sessionIds: string[]) => void
    const fork = vi.fn(
      () =>
        new Promise<typeof forked>((resolve) => {
          resolveFork = resolve
        })
    )
    const remove = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveDelete = resolve
        })
    )
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId))
    vi.stubGlobal("window", { desktop: { sessions: { fork, delete: remove, open } } })
    resetNewConversationState()
    useDesktopSessionStore.setState({ sessions: [source], activeSessionId: source.id })

    const forking = useDesktopSessionStore.getState().forkSession(source.id)
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce())
    const deleting = useDesktopSessionStore.getState().deleteSession(source.id)
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(source.id))
    resolveFork(forked)
    await forking
    resolveDelete([source.id])
    await deleting

    expect(open).not.toHaveBeenCalled()
    expect(useDesktopSessionStore.getState().activeSessionId).toBeNull()
  })

  it("does not restore fork navigation ownership after a current-session archive fails", async () => {
    const source = emptySessionView("session-a").session
    const forked = emptySessionView("session-fork").session
    let resolveFork!: (session: typeof forked) => void
    const fork = vi.fn(
      () =>
        new Promise<typeof forked>((resolve) => {
          resolveFork = resolve
        })
    )
    const archive = vi.fn(async () => {
      throw new Error("archive failed")
    })
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId))
    vi.stubGlobal("window", { desktop: { sessions: { fork, archive, open } } })
    resetNewConversationState()
    useDesktopSessionStore.setState({ sessions: [source], activeSessionId: source.id })

    const forking = useDesktopSessionStore.getState().forkSession(source.id)
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce())
    const archiving = useDesktopSessionStore.getState().archiveSession(source.id)
    await vi.waitFor(() => expect(archive).toHaveBeenCalledWith(source.id))
    resolveFork(forked)
    await forking
    await expect(archiving).rejects.toThrow("archive failed")

    expect(open).not.toHaveBeenCalled()
    expect(useDesktopSessionStore.getState().activeSessionId).toBe(source.id)
  })

  it("keeps create acknowledged and records the first prompt failure on its submission", async () => {
    const session = emptySessionView("session-created").session
    let resolveCreate!: (value: typeof session) => void
    const create = vi.fn(
      () =>
        new Promise<typeof session>((resolve) => {
          resolveCreate = resolve
        })
    )
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create,
          open: vi.fn(async (sessionId: string) => emptySessionView(sessionId)),
          sendPrompt: vi.fn(async () => {
            throw new Error("first prompt failed")
          }),
        },
      },
    })
    resetNewConversationState()

    const starting = useDesktopSessionStore.getState().startSession("first prompt")
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    await useDesktopSessionStore.getState().openSession("session-b")
    resolveCreate(session)

    await expect(starting).rejects.toThrow("first prompt failed")

    const runtime = useDesktopSessionStore.getState().sessionRuntimes[session.id]
    expect(Object.values(runtime?.operations ?? {})).toContainEqual(
      expect.objectContaining({ kind: "create-session", phase: "acknowledged" })
    )
    expect(Object.values(runtime?.pendingPromptSubmissions ?? {})).toContainEqual(
      expect.objectContaining({ phase: "failed", error: "first prompt failed" })
    )
  })

  it("keeps the latest selected model when an older default-model request fails late", async () => {
    let rejectFirst!: (error: Error) => void
    let resolveSecond!: (value: typeof refreshedBootstrap) => void
    const setDefaultModel = vi.fn(
      () =>
        new Promise<typeof refreshedBootstrap>((resolve, reject) => {
          if (setDefaultModel.mock.calls.length === 1) rejectFirst = reject
          else resolveSecond = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { setDefaultModel } } })
    resetNewConversationState()
    const first = useDesktopSessionStore.getState().selectModel({
      id: "model-a",
      label: "Model A",
      provider: "Provider A",
      providerName: "provider-a",
    })
    const second = useDesktopSessionStore.getState().selectModel({
      id: "model-b",
      label: "Model B",
      provider: "Provider B",
      providerName: "provider-b",
    })

    await vi.waitFor(() => expect(setDefaultModel).toHaveBeenCalledTimes(1))
    rejectFirst(new Error("first model failed"))
    await first
    await vi.waitFor(() => expect(setDefaultModel).toHaveBeenCalledTimes(2))
    resolveSecond({ ...refreshedBootstrap, defaultModel: "model-b", defaultProvider: "provider-b" })
    await second

    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedModel: "model-b",
      selectedProvider: "provider-b",
      defaultModel: "model-b",
      defaultProvider: "provider-b",
    })
  })

  it("passes the previous context window when refreshing after a session model switch", async () => {
    const view = emptySessionView("session-model-switch")
    const previousSnapshot = {
      model: "old-model",
      contextWindow: 200_000,
      estimatedInputTokens: 90_000,
      percentFull: 0.45,
      estimator: "heuristic_v1" as const,
      buckets: [],
      tips: [],
      computedAt: new Date().toISOString(),
      source: "session_cache" as const,
    }
    const getContextUsage = vi.fn(async () => previousSnapshot)
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          updateModel: vi.fn(async () => ({
            ...view.session,
            model: "small-model",
            metadata: { runtime: { model: "small-model", provider: "small-provider" } },
          })),
          getContextUsage,
        },
      },
    })
    useDesktopSessionStore.setState({
      activeSessionId: view.session.id,
      sessionView: view,
      sessions: [view.session],
      contextUsageSnapshot: previousSnapshot,
    })

    await useDesktopSessionStore.getState().updateSessionModel(view.session.id, {
      id: "small-model",
      label: "Small",
      provider: "Small",
      providerName: "small-provider",
    })
    await vi.waitFor(() => expect(getContextUsage).toHaveBeenCalledOnce())

    expect(getContextUsage).toHaveBeenCalledWith({
      cwd: view.session.cwd,
      sessionId: view.session.id,
      refresh: true,
      previousContextWindow: 200_000,
    })
  })

  it("keeps the newer session model when update responses arrive out of order", async () => {
    const view = emptySessionView("session-model-race")
    const resolvers: Array<(value: typeof view.session) => void> = []
    vi.stubGlobal("window", { desktop: { sessions: {
      updateModel: () => new Promise<typeof view.session>((resolve) => resolvers.push(resolve)),
      getContextUsage: vi.fn(async () => null),
    } } })
    useDesktopSessionStore.setState({
      activeSessionId: view.session.id,
      sessionView: view,
      sessions: [view.session],
    })
    const select = (id: string) => useDesktopSessionStore.getState().updateSessionModel(view.session.id, {
      id, label: id, provider: "Provider", providerName: "provider",
    })
    const older = select("model-b")
    const newer = select("model-c")
    resolvers[1]!({ ...view.session, model: "model-c", metadata: { runtime: { model: "model-c", provider: "provider" } } })
    await newer
    resolvers[0]!({ ...view.session, model: "model-b", metadata: { runtime: { model: "model-b", provider: "provider" } } })
    await older
    expect(useDesktopSessionStore.getState().selectedModel).toBe("model-c")
  })

  it("does not let an older same-session usage refresh overwrite a newer response", async () => {
    const view = emptySessionView("session-usage-race")
    const resolvers: Array<(value: unknown) => void> = []
    const getContextUsage = vi.fn(
      () => new Promise<unknown>((resolve) => resolvers.push(resolve))
    )
    vi.stubGlobal("window", { desktop: { sessions: { getContextUsage } } })
    useDesktopSessionStore.setState({
      activeSessionId: view.session.id,
      sessionView: view,
      sessions: [view.session],
    })
    const snapshot = (model: string, tokens: number) => ({
      model,
      contextWindow: 100_000,
      estimatedInputTokens: tokens,
      percentFull: tokens / 100_000,
      estimator: "heuristic_v1" as const,
      buckets: [],
      tips: [],
      computedAt: new Date().toISOString(),
      source: "live_assembly" as const,
    })

    const older = useDesktopSessionStore.getState().refreshContextUsage({ refresh: true })
    const newer = useDesktopSessionStore.getState().refreshContextUsage({ refresh: true })
    await vi.waitFor(() => expect(getContextUsage).toHaveBeenCalledTimes(2))
    resolvers[1]!(snapshot("newer", 20))
    await newer
    resolvers[0]!(snapshot("older", 10))
    await older

    expect(useDesktopSessionStore.getState().contextUsageSnapshot?.model).toBe("newer")
  })

  it("keeps the latest permission mode when an older request succeeds late", async () => {
    let resolveFirst!: (value: typeof refreshedBootstrap) => void
    let resolveSecond!: (value: typeof refreshedBootstrap) => void
    const setDefaultPermissionMode = vi.fn(
      () =>
        new Promise<typeof refreshedBootstrap>((resolve) => {
          if (setDefaultPermissionMode.mock.calls.length === 1) resolveFirst = resolve
          else resolveSecond = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { setDefaultPermissionMode } } })
    resetNewConversationState()
    const first = useDesktopSessionStore.getState().selectPermissionMode("plan")
    const second = useDesktopSessionStore.getState().selectPermissionMode("full_auto")

    await vi.waitFor(() => expect(setDefaultPermissionMode).toHaveBeenCalledTimes(1))
    resolveFirst({ ...refreshedBootstrap, defaultPermissionMode: "plan" })
    await first
    await vi.waitFor(() => expect(setDefaultPermissionMode).toHaveBeenCalledTimes(2))
    resolveSecond({ ...refreshedBootstrap, defaultPermissionMode: "full_auto" })
    await second

    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedPermissionMode: "full_auto",
      defaultPermissionMode: "full_auto",
    })
  })

  it("serializes a model selection before a later permission selection and keeps both fields", async () => {
    let resolveModel!: (value: typeof refreshedBootstrap) => void
    let resolvePermission!: (value: typeof refreshedBootstrap) => void
    const setDefaultModel = vi.fn(
      () => new Promise<typeof refreshedBootstrap>((resolve) => (resolveModel = resolve))
    )
    const setDefaultPermissionMode = vi.fn(
      () => new Promise<typeof refreshedBootstrap>((resolve) => (resolvePermission = resolve))
    )
    vi.stubGlobal("window", {
      desktop: { sessions: { setDefaultModel, setDefaultPermissionMode } },
    })
    resetNewConversationState()

    const model = useDesktopSessionStore.getState().selectModel({
      id: "model-a",
      label: "Model A",
      provider: "Provider A",
      providerName: "provider-a",
    })
    const permission = useDesktopSessionStore.getState().selectPermissionMode("full_auto")
    await vi.waitFor(() => expect(setDefaultModel).toHaveBeenCalledOnce())
    expect(setDefaultPermissionMode).not.toHaveBeenCalled()
    resolveModel({
      ...refreshedBootstrap,
      defaultModel: "model-a",
      defaultProvider: "provider-a",
      defaultPermissionMode: "default",
    })
    await vi.waitFor(() => expect(setDefaultPermissionMode).toHaveBeenCalledOnce())
    resolvePermission({
      ...refreshedBootstrap,
      defaultModel: "model-a",
      defaultProvider: "provider-a",
      defaultPermissionMode: "full_auto",
    })
    await Promise.all([model, permission])

    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedModel: "model-a",
      selectedProvider: "provider-a",
      defaultModel: "model-a",
      defaultProvider: "provider-a",
      selectedPermissionMode: "full_auto",
      defaultPermissionMode: "full_auto",
    })
  })

  it("serializes a permission selection before a later model selection and keeps both fields", async () => {
    let resolvePermission!: (value: typeof refreshedBootstrap) => void
    let resolveModel!: (value: typeof refreshedBootstrap) => void
    const setDefaultPermissionMode = vi.fn(
      () => new Promise<typeof refreshedBootstrap>((resolve) => (resolvePermission = resolve))
    )
    const setDefaultModel = vi.fn(
      () => new Promise<typeof refreshedBootstrap>((resolve) => (resolveModel = resolve))
    )
    vi.stubGlobal("window", {
      desktop: { sessions: { setDefaultModel, setDefaultPermissionMode } },
    })
    resetNewConversationState()

    const permission = useDesktopSessionStore.getState().selectPermissionMode("plan")
    const model = useDesktopSessionStore.getState().selectModel({
      id: "model-b",
      label: "Model B",
      provider: "Provider B",
      providerName: "provider-b",
    })
    await vi.waitFor(() => expect(setDefaultPermissionMode).toHaveBeenCalledOnce())
    expect(setDefaultModel).not.toHaveBeenCalled()
    resolvePermission({ ...refreshedBootstrap, defaultPermissionMode: "plan" })
    await vi.waitFor(() => expect(setDefaultModel).toHaveBeenCalledOnce())
    resolveModel({
      ...refreshedBootstrap,
      defaultModel: "model-b",
      defaultProvider: "provider-b",
      defaultPermissionMode: "plan",
    })
    await Promise.all([permission, model])

    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedModel: "model-b",
      selectedProvider: "provider-b",
      defaultModel: "model-b",
      defaultProvider: "provider-b",
      selectedPermissionMode: "plan",
      defaultPermissionMode: "plan",
    })
  })

  it("does not let an open-side project inspection overwrite a later checkout", async () => {
    const project = {
      id: "project-open-checkout",
      name: "Project Open Checkout",
      path: "D:\\code\\project-open-checkout",
      lastOpenedAt: 100,
      available: true,
    }
    const view = emptySessionView("session-open-checkout")
    view.session = {
      ...view.session,
      projectId: project.id,
      workspaceMode: "project",
      cwd: project.path,
    }
    let resolveInspect!: (value: {
      project: typeof project
      git: boolean
      branch: string
      branches: string[]
    }) => void
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          open: vi.fn(async () => view),
          inspectProject: vi.fn(
            () =>
              new Promise((resolve) => {
                resolveInspect = resolve
              })
          ),
          checkoutBranch: vi.fn(async () => ({
            project,
            git: true,
            branch: "feature/new",
            branches: ["feature/new"],
          })),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [project],
      selectedProject: project,
      workspaceMode: "project",
      projectOperations: {},
    })

    const opening = useDesktopSessionStore.getState().openSession(view.session.id)
    await vi.waitFor(() => expect(resolveInspect).toBeTypeOf("function"))
    await useDesktopSessionStore.getState().checkoutBranch("feature/new")
    resolveInspect({ project, git: true, branch: "main", branches: ["main"] })
    await opening

    expect(useDesktopSessionStore.getState()).toMatchObject({
      selectedProject: project,
      branch: "feature/new",
      branches: ["feature/new"],
    })
  })

  it("does not let a late project chooser replace the project owned by an opened session", async () => {
    const projectA = {
      id: "project-late-chooser-a",
      name: "Project Late Chooser A",
      path: "D:\\code\\project-late-chooser-a",
      lastOpenedAt: 100,
      available: true,
    }
    const projectB = {
      id: "project-open-owner-b",
      name: "Project Open Owner B",
      path: "D:\\code\\project-open-owner-b",
      lastOpenedAt: 200,
      available: true,
    }
    const view = emptySessionView("session-project-owner-b")
    view.session = {
      ...view.session,
      projectId: projectB.id,
      workspaceMode: "project",
      cwd: projectB.path,
    }
    let resolveChoose!: (value: ReturnType<typeof projectDetails>) => void
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          chooseProject: vi.fn(
            () =>
              new Promise<ReturnType<typeof projectDetails>>((resolve) => {
                resolveChoose = resolve
              })
          ),
          open: vi.fn(async () => view),
          inspectProject: vi.fn(async () => projectDetails(projectB, "branch-b")),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [projectA, projectB],
      selectedProject: projectA,
      projectOperations: {},
      appOperations: {},
    })

    const choosing = useDesktopSessionStore.getState().chooseProject()
    await useDesktopSessionStore.getState().openSession(view.session.id)
    resolveChoose(projectDetails(projectA, "branch-a"))
    await choosing

    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: view.session.id,
      selectedProject: projectB,
      branch: "branch-b",
      branches: ["branch-b"],
    })
  })

  it("binds the first submission and create operation to the created session runtime", async () => {
    const session = emptySessionView("session-created").session
    let resolvePrompt!: () => void
    let operationsWhenOpening: ReturnType<
      typeof useDesktopSessionStore.getState
    >["sessionRuntimes"][string]["operations"] = {}
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open: vi.fn(async () => {
            operationsWhenOpening = {
              ...useDesktopSessionStore.getState().sessionRuntimes[session.id]?.operations,
            }
            return emptySessionView(session.id)
          }),
          sendPrompt: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                resolvePrompt = resolve
              })
          ),
        },
      },
    })
    resetNewConversationState()

    const starting = useDesktopSessionStore.getState().startSession("first prompt")
    await vi.waitFor(() => expect(resolvePrompt).toBeTypeOf("function"))

    const runtime = useDesktopSessionStore.getState().sessionRuntimes[session.id]
    expect(Object.values(runtime?.pendingPromptSubmissions ?? {})).toContainEqual(
      expect.objectContaining({ items: [{ type: "text" as const, text: "first prompt" }],
      content: "first prompt", sessionId: session.id })
    )
    expect(Object.values(operationsWhenOpening)).toContainEqual(
      expect.objectContaining({ kind: "create-session", sessionId: session.id })
    )

    resolvePrompt()
    await starting
  })

  it("persists a session reasoning effort through sessions.updateEffort", async () => {
    const session = emptySessionView("session-1").session
    const updateEffort = vi.fn(async () => ({
      ...session,
      metadata: { runtime: { model: "m", effort: "max" } },
    }))
    vi.stubGlobal("window", { desktop: { sessions: { updateEffort } } })
    useDesktopSessionStore.setState({ activeSessionId: "session-1" })

    await useDesktopSessionStore.getState().updateSessionEffort("session-1", "max")

    expect(updateEffort).toHaveBeenCalledWith({ sessionId: "session-1", effort: "max" })
    expect(useDesktopSessionStore.getState().selectedEffort).toBe("max")
  })

  it("reads the three effort states from session metadata", () => {
    const session = emptySessionView("session-effort").session
    expect(sessionEffort({ ...session, metadata: {} })).toBeNull()
    expect(sessionEffort({ ...session, metadata: { runtime: { effort: "" } } })).toBeNull()
    expect(sessionEffort({ ...session, metadata: { runtime: { effort: "high" } } })).toBe("high")
  })

  it("normalizes the selected effort and clears it for blank input", () => {
    useDesktopSessionStore.getState().selectEffort(" high ")
    expect(useDesktopSessionStore.getState().selectedEffort).toBe("high")

    useDesktopSessionStore.getState().selectEffort("   ")
    expect(useDesktopSessionStore.getState().selectedEffort).toBeNull()
  })

  it("syncs the selected effort from the applied session view", () => {
    const view = emptySessionView("session-effort-view")
    view.session.metadata = { runtime: { effort: "high" } }
    useDesktopSessionStore.setState({ activeSessionId: view.session.id })

    useDesktopSessionStore.getState().applySessionUpdate(view)

    expect(useDesktopSessionStore.getState().selectedEffort).toBe("high")
  })

  it("syncs the selected effort when opening a session", async () => {
    const session = {
      ...emptySessionView("session-effort-open").session,
      metadata: { runtime: { effort: "high" } },
    }
    const open = vi.fn(async () => ({ ...emptySessionView("session-effort-open", 1), session }))
    vi.stubGlobal("window", { desktop: { sessions: { open } } })

    await useDesktopSessionStore.getState().openSession("session-effort-open")

    expect(useDesktopSessionStore.getState().selectedEffort).toBe("high")
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

describe("desktop session store outside-project mode", () => {
  it("lets the main process allocate the directory for a session without a project id", async () => {
    const session = {
      id: "session-outside-project",
      projectId: "auto-generated-workspace-project",
      workspaceMode: "outside_project" as const,
      cwd: "C:\\Users\\tester\\Documents\\OpenHarness\\2026-08-24\\x1",
      title: "",
      model: "deepseek-chat",
      status: "idle" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const create = vi.fn(async () => session)
    const sendPrompt = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create,
          open: vi.fn(async () => ({
            cursor: 0,
            syncStatus: "connected" as const,
            session,
            inputs: [],
            messages: [],
            parts: [],
            runs: [],
            tasks: [],
            permissions: [],
          })),
          sendPrompt,
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [],
      sessions: [],
      archivedSessions: [],
      workspaceMode: "outside_project",
      selectedProject: null,
      selectedModel: "deepseek-chat",
      selectedProvider: "deepseek",
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
      selectedPermissionMode: "default",
      selectedEffort: null,
      activeSessionId: null,
      sessionView: null,
    })

    await useDesktopSessionStore.getState().startSession("总结今天的安排")

    expect(create).toHaveBeenCalledWith({
      model: "deepseek-chat",
      provider: "deepseek",
      permissionMode: "default",
    })
    expect(sendPrompt).toHaveBeenCalledWith({
      id: expect.any(String),
      sessionId: "session-outside-project",
      items: [{ type: "text", text: "总结今天的安排" }],
      attachments: [],
    })
    expect(useDesktopSessionStore.getState()).toMatchObject({
      workspaceMode: "outside_project",
      selectedProject: null,
      activeSessionId: "session-outside-project",
      sessions: [
        {
          id: "session-outside-project",
          projectId: "auto-generated-workspace-project",
          workspaceMode: "outside_project",
        },
      ],
    })
  })

  it("marks the first prompt as failed when the new session rejects it", async () => {
    const session = {
      id: "session-first-prompt-fails",
      projectId: "auto-generated-workspace-project",
      workspaceMode: "outside_project" as const,
      cwd: "C:\\Users\\tester\\Documents\\OpenHarness\\2026-08-24\\x2",
      title: "",
      model: "deepseek-chat",
      status: "idle" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => session),
          open: vi.fn(async () => ({
            cursor: 0,
            syncStatus: "connected" as const,
            session,
            inputs: [],
            messages: [],
            parts: [],
            runs: [],
            tasks: [],
            permissions: [],
          })),
          sendPrompt: vi.fn(async () => {
            throw new Error("发送失败")
          }),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [],
      sessions: [],
      archivedSessions: [],
      workspaceMode: "outside_project",
      selectedProject: null,
      selectedModel: "deepseek-chat",
      selectedProvider: "deepseek",
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
      selectedPermissionMode: "default",
      selectedEffort: null,
      activeSessionId: null,
      sessionView: null,
    })

    await expect(useDesktopSessionStore.getState().startSession("第一条消息")).rejects.toThrow(
      "发送失败"
    )

    expect(onlyPendingPromptSubmission()).toMatchObject({
      sessionId: session.id,
      items: [{ type: "text" as const, text: "第一条消息" }],
      content: "第一条消息",
      phase: "failed",
      error: "发送失败",
    })
  })

  it("reconciles local prompt state when reopening a session snapshot", async () => {
    const view = emptySessionView("session-reopen", 4)
    view.inputs = [
      {
        id: "input-confirmed",
        sessionId: "session-reopen",
        seq: 1,
        delivery: "queue",
        items: [{ type: "text" as const, text: "confirmed" }],
        content: "confirmed",
        attachments: [],
        metadata: {},
        createdAt: 1,
      },
    ]
    view.messages = [{
      id: "message-confirmed",
      sessionId: "session-reopen",
      seq: 1,
      role: "user",
      inputId: "input-confirmed",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }]
    view.runs = [
      {
        id: "run-finished",
        sessionId: "session-reopen",
        inputId: "input-confirmed",
        status: "interrupted",
        metadata: {},
        createdAt: 1,
        updatedAt: 2,
      },
    ]
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          open: vi.fn(async () => view),
        },
      },
    })
    useDesktopSessionStore.setState({
      activeSessionId: null,
      sessionView: null,
      sessionRuntimes: {
        "session-reopen": {
          ...createEmptySessionRuntime(),
          pendingPromptSubmissions: {
            "input-confirmed": {
              id: "input-confirmed",
              sessionId: "session-reopen",
              items: [{ type: "text" as const, text: "confirmed" }],
              content: "confirmed",
              attachments: [],
              createdAt: 1,
              phase: "accepted",
              placement: "transcript",
            },
          },
          queuedPromptActions: {
            "session-reopen:run-finished": {
              sessionId: "session-reopen",
              inputId: "input-confirmed",
              runId: "run-finished",
              kind: "promote",
              phase: "acknowledged",
            },
          },
        },
      },
    })

    await useDesktopSessionStore.getState().openSession("session-reopen")

    expect(sessionRuntime("session-reopen").pendingPromptSubmissions).toEqual({})
    expect(sessionRuntime("session-reopen").queuedPromptActions).toEqual({})
  })

  it("does not let a late new-session snapshot overwrite a session opened afterward", async () => {
    const sessionA = emptySessionView("session-a").session
    const viewA = { ...emptySessionView("session-a", 1), session: sessionA }
    const viewB = emptySessionView("session-b", 2)
    let resolveViewA!: (view: DesktopSessionView) => void
    const open = vi.fn((sessionId: string) =>
      sessionId === "session-a"
        ? new Promise<DesktopSessionView>((resolve) => {
            resolveViewA = resolve
          })
        : Promise.resolve(viewB)
    )
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          create: vi.fn(async () => sessionA),
          open,
          sendPrompt: vi.fn(async () => undefined),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [],
      sessions: [],
      archivedSessions: [],
      workspaceMode: "outside_project",
      selectedProject: null,
      selectedModel: "test-model",
      selectedProvider: null,
      defaultModel: "test-model",
      defaultProvider: null,
      selectedPermissionMode: "default",
      selectedEffort: null,
      activeSessionId: null,
      sessionView: null,
    })

    const starting = useDesktopSessionStore.getState().startSession("start A")
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("session-a"))
    await useDesktopSessionStore.getState().openSession("session-b")
    resolveViewA(viewA)
    await starting

    expect(useDesktopSessionStore.getState()).toMatchObject({
      activeSessionId: "session-b",
      sessionView: { session: { id: "session-b" }, cursor: 2 },
    })
    expect(sessionRuntime("session-a").operations).toEqual({})
    expect(sessionRuntime("session-a").pendingPromptSubmissions).toEqual({})
  })

  it("keeps the internal xN workspace hidden after opening a session and starting a new one", async () => {
    const session = {
      id: "session-outside-project",
      projectId: "auto-generated-workspace-project",
      workspaceMode: "outside_project" as const,
      cwd: "C:\\Users\\tester\\Documents\\OpenHarness\\2026-08-24\\x1",
      title: "项目外会话",
      model: "deepseek-chat",
      status: "idle" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const close = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          close,
          open: vi.fn(async () => ({
            cursor: 0,
            syncStatus: "connected" as const,
            session,
            inputs: [],
            messages: [],
            parts: [],
            runs: [],
            tasks: [],
            permissions: [],
          })),
        },
      },
    })
    useDesktopSessionStore.setState({
      projects: [],
      sessions: [session],
      archivedSessions: [],
      workspaceMode: "project",
      selectedProject: {
        id: session.projectId,
        name: "x1",
        path: session.cwd,
        lastOpenedAt: 1,
        available: true,
      },
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
      defaultPermissionMode: "default",
      activeSessionId: null,
      sessionView: null,
    })

    await useDesktopSessionStore.getState().openSession(session.id)

    expect(useDesktopSessionStore.getState()).toMatchObject({
      workspaceMode: "outside_project",
      selectedProject: null,
      activeSessionId: session.id,
    })

    await useDesktopSessionStore.getState().startNewConversation()

    expect(close).toHaveBeenCalledOnce()
    expect(useDesktopSessionStore.getState()).toMatchObject({
      workspaceMode: "outside_project",
      selectedProject: null,
      activeSessionId: null,
      sessionView: null,
    })
  })
})
