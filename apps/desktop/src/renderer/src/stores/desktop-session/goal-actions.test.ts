import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SessionGoal } from "@shared/session-types"
import type { DesktopAttachmentDraft } from "@shared/attachment-types"
import { useDesktopSessionStore } from "./store"
import { emptySessionView, resetDesktopSessionStore } from "./store-test-fixtures"
import { composerDocument, selectComposerDocumentText } from "./composer-document"
import {
  NEW_CONVERSATION_SCOPE,
  selectDraftAttachments,
  selectDraftDocument,
  sessionComposerScope,
} from "./composer-draft-state"

const goal = (sessionId = "s1", patch: Partial<SessionGoal> = {}): SessionGoal => ({
  id: "g1",
  sessionId,
  objective: "完成测试",
  revision: 0,
  status: "active",
  maxAutoTurns: 20,
  autoTurnsUsed: 0,
  noProgressCount: 0,
  evidence: [],
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})
const attachment = (id = "a1"): DesktopAttachmentDraft => ({
  draftId: id,
  taskId: id,
  assetId: id,
  displayName: `${id}.png`,
  declaredMediaType: "image/png",
  mediaType: "image/png",
  sizeBytes: 1,
  status: "ready",
  bytesUploaded: 1,
  progress: 1,
})
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe("goal actions", () => {
  beforeEach(() => {
    resetDesktopSessionStore()
    useDesktopSessionStore.setState({ selectedModel: "test", workspaceMode: "outside_project" })
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          getGoal: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(emptySessionView("s1").session),
          createGoal: vi.fn().mockResolvedValue(goal()),
          updateGoal: vi.fn().mockResolvedValue(goal("s1", { revision: 1 })),
          goalAction: vi.fn().mockResolvedValue(goal("s1", { status: "paused", revision: 1 })),
        },
      },
    })
    useDesktopSessionStore.setState({ openSession: vi.fn().mockResolvedValue(undefined) })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetDesktopSessionStore()
  })
  const draft = (scope: string, text: string, files: DesktopAttachmentDraft[] = []): void => {
    useDesktopSessionStore.setState((state) => ({
      composerDraftsByScope: {
        ...state.composerDraftsByScope,
        [scope]: { document: composerDocument([{ type: "text", text }]), attachments: files },
      },
    }))
  }

  it("keeps new-goal text on exit, and restores ordinary text and files after editing", () => {
    const scope = sessionComposerScope("s1")
    draft(scope, "原草稿", [attachment()])
    useDesktopSessionStore.getState().setGoalMode(scope, true)
    draft(scope, "新目标", [attachment()])
    useDesktopSessionStore.getState().setGoalMode(scope, false)
    expect(
      selectComposerDocumentText(selectDraftDocument(useDesktopSessionStore.getState(), scope))
    ).toBe("新目标")
    useDesktopSessionStore.setState({ goalsBySession: { s1: goal() } })
    useDesktopSessionStore.getState().setGoalMode(scope, true)
    expect(selectDraftAttachments(useDesktopSessionStore.getState(), scope)).toEqual([])
    expect(
      selectComposerDocumentText(selectDraftDocument(useDesktopSessionStore.getState(), scope))
    ).toBe("完成测试")
    useDesktopSessionStore.getState().setGoalMode(scope, false)
    expect(
      selectComposerDocumentText(selectDraftDocument(useDesktopSessionStore.getState(), scope))
    ).toBe("新目标")
    expect(selectDraftAttachments(useDesktopSessionStore.getState(), scope)).toHaveLength(1)
  })

  it("retries a failed new goal in its already-created session with the same request", async () => {
    const scope = NEW_CONVERSATION_SCOPE
    draft(scope, "目标正文", [attachment()])
    useDesktopSessionStore.getState().setGoalMode(scope, true)
    vi.mocked(window.desktop.sessions.createGoal).mockRejectedValueOnce(new Error("offline"))
    await useDesktopSessionStore.getState().submitGoal(scope)
    expect(useDesktopSessionStore.getState().goalComposersByScope[scope]).toMatchObject({
      mode: true,
      busy: false,
      error: "offline",
      createdSessionId: "s1",
    })
    expect(selectDraftAttachments(useDesktopSessionStore.getState(), scope)).toHaveLength(1)
    await useDesktopSessionStore.getState().submitGoal(scope)
    expect(window.desktop.sessions.create).toHaveBeenCalledTimes(1)
    const calls = vi.mocked(window.desktop.sessions.createGoal).mock.calls
    expect(calls[0]![0]).toEqual(calls[1]![0])
    expect(calls[1]![0]).toMatchObject({
      items: [{ type: "text", text: "目标正文" }],
      attachments: [{ assetId: "a1" }],
    })
    expect(selectDraftDocument(useDesktopSessionStore.getState(), scope).items).toEqual([])
    expect(selectDraftAttachments(useDesktopSessionStore.getState(), scope)).toEqual([])
  })

  it("shows the maintenance operation while preserving the goal draft", async () => {
    const scope = NEW_CONVERSATION_SCOPE
    draft(scope, "目标正文", [attachment()])
    useDesktopSessionStore.getState().setGoalMode(scope, true)
    vi.mocked(window.desktop.sessions.createGoal).mockRejectedValueOnce(
      new Error("VykorApiError: Daemon operation is blocked by maintenance: 压缩上下文")
    )
    await useDesktopSessionStore.getState().submitGoal(scope)
    expect(useDesktopSessionStore.getState().goalComposersByScope[scope]?.error).toBe(
      "正在压缩上下文，请稍后重试。"
    )
    expect(
      selectComposerDocumentText(selectDraftDocument(useDesktopSessionStore.getState(), scope))
    ).toBe("目标正文")
    expect(selectDraftAttachments(useDesktopSessionStore.getState(), scope)).toHaveLength(1)
  })

  it("preserves ordinary attachment upload results while goal editing uses a separate draft", async () => {
    const scope = sessionComposerScope("s1")
    draft(scope, "原草稿", [{ ...attachment(), status: "uploading", assetId: undefined }])
    useDesktopSessionStore.setState({ goalsBySession: { s1: goal() } })
    useDesktopSessionStore.getState().setGoalMode(scope, true)
    useDesktopSessionStore.getState().applyAttachmentUploadEvent({
      type: "success",
      draftId: "a1",
      taskId: "a1",
      assetId: "uploaded",
      displayName: "a1.png",
      mediaType: "image/png",
      sizeBytes: 1,
    })
    await useDesktopSessionStore.getState().submitGoal(scope)
    expect(window.desktop.sessions.updateGoal).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [] })
    )
    expect(
      selectComposerDocumentText(selectDraftDocument(useDesktopSessionStore.getState(), scope))
    ).toBe("原草稿")
    expect(selectDraftAttachments(useDesktopSessionStore.getState(), scope)).toEqual([
      expect.objectContaining({ status: "ready", assetId: "uploaded" }),
    ])
  })

  it("changes request identity when attachments change but reuses the new session", async () => {
    const scope = NEW_CONVERSATION_SCOPE
    draft(scope, "目标正文", [attachment()])
    useDesktopSessionStore.getState().setGoalMode(scope, true)
    vi.mocked(window.desktop.sessions.createGoal).mockRejectedValue(new Error("offline"))
    await useDesktopSessionStore.getState().submitGoal(scope)
    draft(scope, "目标正文", [attachment("a2")])
    await useDesktopSessionStore.getState().submitGoal(scope)
    const calls = vi.mocked(window.desktop.sessions.createGoal).mock.calls
    expect(calls[0]![0].requestId).not.toBe(calls[1]![0].requestId)
    expect(window.desktop.sessions.create).toHaveBeenCalledTimes(1)
  })

  it("settles a submission only in its original scope after navigation", async () => {
    const waiting = deferred<SessionGoal>()
    vi.mocked(window.desktop.sessions.createGoal).mockReturnValue(waiting.promise)
    const scope = sessionComposerScope("s1")
    draft(scope, "目标正文", [attachment()])
    useDesktopSessionStore.getState().setGoalMode(scope, true)
    const submit = useDesktopSessionStore.getState().submitGoal(scope)
    const nextScope = sessionComposerScope("s2")
    useDesktopSessionStore.setState({ activeSessionId: "s2" })
    draft(nextScope, "不要清空这个输入", [attachment("a2")])
    waiting.resolve(goal())
    await submit
    expect(
      selectComposerDocumentText(selectDraftDocument(useDesktopSessionStore.getState(), nextScope))
    ).toBe("不要清空这个输入")
    expect(selectDraftAttachments(useDesktopSessionStore.getState(), nextScope)).toHaveLength(1)
    expect(useDesktopSessionStore.getState().goalsBySession.s2).toBeUndefined()
  })

  it("does not allow a stale read to overwrite a successful action", async () => {
    const waiting = deferred<SessionGoal>()
    vi.mocked(window.desktop.sessions.getGoal).mockReturnValue(waiting.promise)
    useDesktopSessionStore.setState({ goalsBySession: { s1: goal() } })
    const read = useDesktopSessionStore.getState().refreshGoal("s1")
    await useDesktopSessionStore.getState().applyGoalAction("s1", { action: "pause" })
    waiting.resolve(goal())
    await read
    expect(useDesktopSessionStore.getState().goalsBySession.s1?.status).toBe("paused")
  })

  it("ignores goal refresh when the desktop bridge is unavailable", async () => {
    vi.stubGlobal("window", {})

    await expect(useDesktopSessionStore.getState().refreshGoal("s1")).resolves.toBeUndefined()
  })

  it("replays the original action revision after a lost response and newer snapshot", async () => {
    useDesktopSessionStore.setState({ goalsBySession: { s1: goal("s1", { status: "paused" }) } })
    vi.mocked(window.desktop.sessions.goalAction).mockRejectedValueOnce(new Error("lost response"))
    vi.mocked(window.desktop.sessions.getGoal).mockResolvedValue(goal("s1", { revision: 1 }))
    await useDesktopSessionStore
      .getState()
      .applyGoalAction("s1", { action: "resume", additionalAutoTurns: 20 })
    await useDesktopSessionStore.getState().refreshGoal("s1")
    await useDesktopSessionStore
      .getState()
      .applyGoalAction("s1", { action: "resume", additionalAutoTurns: 20 })
    const calls = vi.mocked(window.desktop.sessions.goalAction).mock.calls
    expect(calls[0]![0]).toEqual(calls[1]![0])
    expect(calls[1]![0].expectedRevision).toBe(0)
  })

  it("rejects a reference-only objective without creating a session", async () => {
    const scope = NEW_CONVERSATION_SCOPE
    useDesktopSessionStore
      .getState()
      .setComposerDraftDocument(
        scope,
        composerDocument([{ type: "context", kind: "conversation", id: "s2", displayName: "历史" }])
      )
    useDesktopSessionStore.getState().setGoalMode(scope, true)
    await useDesktopSessionStore.getState().submitGoal(scope)
    expect(window.desktop.sessions.create).not.toHaveBeenCalled()
    expect(window.desktop.sessions.createGoal).not.toHaveBeenCalled()
  })

  it("carries the selected effort into a goal-created session", async () => {
    const scope = NEW_CONVERSATION_SCOPE
    draft(scope, "目标正文")
    useDesktopSessionStore.getState().setGoalMode(scope, true)
    useDesktopSessionStore.getState().selectEffort("high")

    await useDesktopSessionStore.getState().submitGoal(scope)

    expect(window.desktop.sessions.create).toHaveBeenCalledWith({
      model: "test",
      permissionMode: "default",
      effort: "high",
    })
  })
})
