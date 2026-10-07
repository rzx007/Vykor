import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createActivityState } from "./activity-state"
import { useDesktopSessionStore } from "./store"
import { emptySessionView } from "./store-test-fixtures"

afterEach(() => vi.unstubAllGlobals())

beforeEach(() => {
  useDesktopSessionStore.setState({
    activity: createActivityState(),
    sessions: [],
    activeSessionId: null,
  })
})

describe("Desktop Activity store", () => {
  it("plays the saved sound selection for a completed run", async () => {
    const play = vi.fn(async () => undefined)
    const audio = vi.fn(function () {
      return { play, pause: vi.fn() }
    })
    vi.stubGlobal("Audio", audio)
    vi.stubGlobal("window", {
      desktop: {
        settings: {
          snapshot: async () => ({
            notificationMode: "never",
            notificationSounds: {
              completed: "bip-bop-08",
              needs_input: "none",
              failed: "nope-03",
            },
          }),
        },
        tray: { notify: vi.fn(async () => undefined) },
      },
    })
    const activity = {
      session: emptySessionView("other").session,
      executionState: "running" as const,
      attentionState: "read" as const,
      activitySeq: 1,
      updatedAt: 1,
    }
    useDesktopSessionStore
      .getState()
      .applyActivityUpdate({ cursor: 1, delivery: "baseline", sessions: [activity], scheduled: [] })
    useDesktopSessionStore
      .getState()
      .applyActivityUpdate({
        cursor: 2,
        delivery: "live",
        sessions: [{ ...activity, executionState: "completed", activitySeq: 2 }],
        scheduled: [],
      })
    await vi.waitFor(() => expect(play).toHaveBeenCalledOnce())
    expect(audio).toHaveBeenCalledWith(expect.stringContaining("bip-bop-08"))
  })

  it.each(["completed", "needs_input", "failed"] as const)(
    "plays %s once for the current chat even when system notifications are off",
    async (executionState) => {
      const play = vi.fn(async () => undefined)
      const audio = vi.fn(function () {
        return { play, pause: vi.fn(), volume: 1, currentTime: 0 }
      })
      const notify = vi.fn(async () => undefined)
      vi.stubGlobal("Audio", audio)
      vi.stubGlobal("window", {
        desktop: {
          settings: { snapshot: async () => ({ notificationMode: "never" }) },
          tray: { notify },
        },
      })
      const view = emptySessionView("current")
      useDesktopSessionStore.setState({ activeSessionId: "current", sessionView: view })
      const activity = {
        session: view.session,
        executionState: "running" as const,
        attentionState: "read" as const,
        activitySeq: 1,
        updatedAt: 1,
      }
      useDesktopSessionStore.getState().applyActivityUpdate({
        cursor: 1,
        delivery: "baseline",
        sessions: [activity],
        scheduled: [],
      })
      expect(play).not.toHaveBeenCalled()
      const finished = { ...activity, executionState, activitySeq: 2, permissionId: "p1" }
      const update = { cursor: 2, delivery: "live" as const, sessions: [finished], scheduled: [] }
      useDesktopSessionStore.getState().applyActivityUpdate(update)
      useDesktopSessionStore.getState().applyActivityUpdate(update)
      useDesktopSessionStore.getState().applyActivityUpdate({ ...update, cursor: 3 })
      await vi.waitFor(() => expect(play).toHaveBeenCalledOnce())
      expect(audio).toHaveBeenCalledWith(
        expect.stringContaining(
          executionState === "completed"
            ? "staplebops-01"
            : executionState === "needs_input"
              ? "staplebops-02"
              : "nope-03"
        )
      )
      expect(notify).not.toHaveBeenCalled()
    }
  )

  it("honors a disabled error sound while still sending a silent system notification", async () => {
    const play = vi.fn(async () => undefined)
    vi.stubGlobal(
      "Audio",
      vi.fn(function () {
        return { play }
      })
    )
    const notify = vi.fn(async () => undefined)
    vi.stubGlobal("window", {
      desktop: {
        settings: {
          snapshot: async () => ({
            notificationMode: "always",
            notificationSounds: {
              completed: "staplebops-01",
              needs_input: "staplebops-02",
              failed: "none",
            },
          }),
        },
        tray: { notify },
      },
    })
    const activity = {
      session: emptySessionView("other").session,
      executionState: "running" as const,
      attentionState: "read" as const,
      activitySeq: 1,
      updatedAt: 1,
    }
    useDesktopSessionStore.getState().applyActivityUpdate({
      cursor: 1,
      delivery: "baseline",
      sessions: [activity],
      scheduled: [],
    })
    useDesktopSessionStore.getState().applyActivityUpdate({
      cursor: 2,
      delivery: "live",
      sessions: [{ ...activity, executionState: "failed", activitySeq: 2 }],
      scheduled: [],
    })
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ silent: true }))
    )
    expect(play).not.toHaveBeenCalled()
  })

  it.each(["when_unfocused", "always", "never"])(
    "routes current-chat approval using %s notification mode",
    async (notificationMode) => {
      const notify = vi.fn(async () => undefined)
      vi.stubGlobal("window", {
        desktop: {
          settings: { snapshot: async () => ({ notificationMode }) },
          tray: { notify },
        },
      })
      const view = emptySessionView("current")
      useDesktopSessionStore.setState({ activeSessionId: "current", sessionView: view })
      const activity = {
        session: view.session,
        executionState: "running" as const,
        attentionState: "read" as const,
        activitySeq: 1,
        updatedAt: 1,
      }
      useDesktopSessionStore.getState().applyActivityUpdate({
        cursor: 1,
        delivery: "baseline",
        sessions: [activity],
        scheduled: [],
      })
      useDesktopSessionStore.getState().applyActivityUpdate({
        cursor: 2,
        delivery: "live",
        sessions: [
          { ...activity, executionState: "needs_input", permissionId: "p1", activitySeq: 2 },
        ],
        scheduled: [],
      })
      await Promise.resolve()
      if (notificationMode === "never") expect(notify).not.toHaveBeenCalled()
      else
        expect(notify).toHaveBeenCalledWith({
          title: "Vykor 需要处理",
          body: `${view.session.title} 正在等待处理。`,
          sessionId: "current",
          silent: true,
          eventStatus: "needs_input",
          eventId: "session:current:1:p1:needs_input",
          ...(notificationMode === "always" ? { showWhenFocused: true } : {}),
        })
    }
  )
  it("upserts a new IM session on a live event without refreshing bootstrap", () => {
    const refreshBootstrap = vi.fn(async () => undefined)
    useDesktopSessionStore.setState({ refreshBootstrap })
    useDesktopSessionStore.getState().applyActivityUpdate({
      cursor: 1,
      delivery: "live",
      scheduled: [],
      sessions: [
        {
          session: {
            id: "im-1",
            cwd: "/channels/feishu",
            title: "new IM",
            model: "test",
            status: "idle",
            metadata: { externalConversation: { connector: "feishu" } },
            createdAt: 1,
            updatedAt: 1,
          },
          activitySeq: 1,
          updatedAt: 1,
          executionState: "idle",
          attentionState: "read",
        },
      ],
      eventType: "session.created",
    })
    expect(useDesktopSessionStore.getState().sessions.map((session) => session.id)).toContain(
      "im-1"
    )
    expect(refreshBootstrap).not.toHaveBeenCalled()
  })

  it("does not add a sub-agent child session to the history list", () => {
    useDesktopSessionStore.getState().applyActivityUpdate({
      cursor: 1,
      delivery: "live",
      scheduled: [],
      sessions: [
        {
          session: {
            id: "child-1",
            parentId: "parent-1",
            cwd: "/repo",
            title: "worker@default",
            model: "test",
            status: "running",
            metadata: { childId: "child-1" },
            createdAt: 1,
            updatedAt: 1,
          },
          activitySeq: 1,
          updatedAt: 1,
          executionState: "running",
          attentionState: "read",
        },
      ],
      eventType: "session.created",
    })
    expect(useDesktopSessionStore.getState().sessions.map((session) => session.id)).not.toContain(
      "child-1"
    )
  })

  it("does not reorder a live session backwards when an older baseline fills other sessions", () => {
    const row = (id: string, updatedAt: number) => ({
      id,
      cwd: "/repo",
      title: id,
      model: "m",
      status: "idle" as const,
      metadata: {},
      createdAt: 1,
      updatedAt,
    })
    useDesktopSessionStore.getState().applyActivityUpdate({
      cursor: 11,
      delivery: "live",
      scheduled: [],
      sessions: [
        {
          session: row("a", 11),
          executionState: "completed",
          attentionState: "read",
          activitySeq: 11,
          updatedAt: 11,
        },
      ],
    })
    useDesktopSessionStore.getState().applyActivityUpdate({
      cursor: 10,
      delivery: "baseline",
      scheduled: [],
      sessions: [
        {
          session: row("a", 1),
          executionState: "running",
          attentionState: "read",
          activitySeq: 0,
          updatedAt: 1,
        },
        {
          session: row("b", 2),
          executionState: "idle",
          attentionState: "read",
          activitySeq: 0,
          updatedAt: 2,
        },
      ],
    })
    expect(useDesktopSessionStore.getState().sessions.map(({ id }) => id)).toEqual(["a", "b"])
  })

  it("does not auto-read a session whose open request has not produced a view", () => {
    useDesktopSessionStore.setState({
      activeSessionId: "opening",
      sessionView: null,
      activity: createActivityState({ lastObservedCursor: 1, readSeqBySessionId: { opening: 1 } }),
    })
    useDesktopSessionStore.getState().applyActivityUpdate({
      cursor: 2,
      delivery: "catchup",
      scheduled: [],
      sessions: [
        {
          session: {
            id: "opening",
            cwd: "/repo",
            title: "opening",
            model: "m",
            status: "idle",
            metadata: {},
            createdAt: 1,
            updatedAt: 2,
          },
          executionState: "failed",
          attentionState: "read",
          activitySeq: 2,
          updatedAt: 2,
        },
      ],
    })
    expect(useDesktopSessionStore.getState().activity.sessions.opening.attentionState).toBe(
      "unread"
    )
  })

  it("removes a deleted session from the visible list and persisted read map", () => {
    const row = {
      id: "gone",
      cwd: "/repo",
      title: "Gone",
      model: "m",
      status: "idle" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    useDesktopSessionStore.setState({
      sessions: [row],
      activity: {
        ...createActivityState({ readSeqBySessionId: { gone: 1 } }),
        sessions: {
          gone: {
            session: row,
            executionState: "completed",
            attentionState: "unread",
            activitySeq: 2,
            updatedAt: 2,
          },
        },
      },
    })
    useDesktopSessionStore.getState().applyActivityUpdate({
      cursor: 3,
      delivery: "live",
      sessions: [],
      scheduled: [],
      removedSessionIds: ["gone"],
    })
    expect(useDesktopSessionStore.getState().sessions).toEqual([])
    expect(useDesktopSessionStore.getState().activity.sessions.gone).toBeUndefined()
    expect(useDesktopSessionStore.getState().activity.readSeqBySessionId.gone).toBeUndefined()
  })

  it("does not reinsert a tombstoned session from a delayed baseline", () => {
    const row = {
      id: "gone",
      cwd: "/repo",
      title: "Gone",
      model: "m",
      status: "idle" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    useDesktopSessionStore.getState().applyActivityUpdate({
      cursor: 2,
      delivery: "live",
      sessions: [],
      scheduled: [],
      removedSessionIds: ["gone"],
    })
    useDesktopSessionStore.getState().applyActivityUpdate({
      cursor: 1,
      delivery: "baseline",
      sessions: [
        {
          session: row,
          executionState: "idle",
          attentionState: "read",
          activitySeq: 0,
          updatedAt: 1,
        },
      ],
      scheduled: [],
    })
    expect(useDesktopSessionStore.getState().sessions).toEqual([])
  })

  it("uses the next full baseline to remove a deletion delta missed during remount", () => {
    const row = {
      id: "gone",
      cwd: "/repo",
      title: "Gone",
      model: "m",
      status: "idle" as const,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    useDesktopSessionStore.setState({
      sessions: [row],
      activity: {
        ...createActivityState(),
        initialized: true,
        cursor: 1,
        sessions: {
          gone: {
            session: row,
            executionState: "idle",
            attentionState: "read",
            activitySeq: 0,
            updatedAt: 1,
          },
        },
      },
    })
    useDesktopSessionStore.getState().applyActivityUpdate({
      cursor: 2,
      delivery: "baseline",
      sessions: [],
      scheduled: [],
      removedSessionIds: ["gone"],
    })
    expect(useDesktopSessionStore.getState().sessions).toEqual([])
  })
})
