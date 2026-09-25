import { beforeEach, describe, expect, it, vi } from "vitest"

import { emptySessionView, resetDesktopSessionStore } from "./store-test-fixtures"
import { attachDesktopSessionEvents, useDesktopSessionStore } from "./store"
import { createActivityState } from "./activity-state"

beforeEach(() => {
  resetDesktopSessionStore()
  vi.unstubAllGlobals()
})

describe("desktop session store composition", () => {
  it("provides every action from the composed store", () => {
    const state = useDesktopSessionStore.getState()

    expect(state.initialize).toEqual(expect.any(Function))
    expect(state.selectProject).toEqual(expect.any(Function))
    expect(state.openSession).toEqual(expect.any(Function))
    expect(state.sendMessage).toEqual(expect.any(Function))
    expect(state.promoteQueuedPrompt).toEqual(expect.any(Function))
    expect(state.applySessionUpdate).toEqual(expect.any(Function))
  })
})

describe("desktop session store event lifecycle", () => {
  it("shares one Activity listener under two mounted bridges and removes it on final detach", async () => {
    const listeners = new Set<
      (value: import("@shared/activity-types").DesktopActivityUpdate) => void
    >()
    const open = vi.fn(async () => ({
      cursor: 0,
      delivery: "baseline" as const,
      sessions: [],
      scheduled: [],
    }))
    vi.stubGlobal("window", {
      desktop: {
        sessions: {
          onUpdated: () => () => undefined,
          onDaemonStatusChanged: () => () => undefined,
        },
        activity: {
          open,
          onUpdated: (
            listener: (value: import("@shared/activity-types").DesktopActivityUpdate) => void
          ) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
        },
      },
    })
    useDesktopSessionStore.setState({ activity: createActivityState() })
    const first = attachDesktopSessionEvents()
    const second = attachDesktopSessionEvents()
    expect(listeners.size).toBe(1)
    expect(open).toHaveBeenCalledOnce()
    first()
    expect(listeners.size).toBe(1)
    second()
    expect(listeners.size).toBe(0)
  })

  it("shares subscriptions until the last cleanup and can attach again", () => {
    const sessionSubscribers = new Set<(view: ReturnType<typeof emptySessionView>) => void>()
    const daemonSubscribers = new Set<
      (status: { phase: "ready"; message: string; updatedAt: number }) => void
    >()
    const unsubscribeSession = vi.fn()
    const unsubscribeDaemon = vi.fn()
    const unsubscribeAttachment = vi.fn()
    const onUpdated = vi.fn((listener: (view: ReturnType<typeof emptySessionView>) => void) => {
      sessionSubscribers.add(listener)
      return () => {
        unsubscribeSession()
        sessionSubscribers.delete(listener)
      }
    })
    const onDaemonStatusChanged = vi.fn(
      (listener: (status: { phase: "ready"; message: string; updatedAt: number }) => void) => {
        daemonSubscribers.add(listener)
        return () => {
          unsubscribeDaemon()
          daemonSubscribers.delete(listener)
        }
      }
    )
    const onUploadEvent = vi.fn(() => unsubscribeAttachment)
    const publishSession = (view: ReturnType<typeof emptySessionView>): void => {
      sessionSubscribers.forEach((listener) => listener(view))
    }
    const publishDaemon = (status: {
      phase: "ready"
      message: string
      updatedAt: number
    }): void => {
      daemonSubscribers.forEach((listener) => listener(status))
    }
    vi.stubGlobal("window", {
      desktop: {
        sessions: { onUpdated, onDaemonStatusChanged },
        attachments: { onUploadEvent },
      },
    })
    useDesktopSessionStore.setState({ activeSessionId: "session-1" })

    const firstCleanup = attachDesktopSessionEvents()
    const secondCleanup = attachDesktopSessionEvents()

    expect(onUpdated).toHaveBeenCalledOnce()
    expect(onDaemonStatusChanged).toHaveBeenCalledOnce()
    expect(onUploadEvent).toHaveBeenCalledOnce()

    publishDaemon({ phase: "ready", message: "connected", updatedAt: 1 })
    publishSession(emptySessionView("session-1", 1))
    expect(useDesktopSessionStore.getState().daemonStatus.message).toBe("connected")
    expect(useDesktopSessionStore.getState().sessionView?.cursor).toBe(1)

    firstCleanup()
    firstCleanup()
    publishDaemon({ phase: "ready", message: "still connected", updatedAt: 2 })
    expect(useDesktopSessionStore.getState().daemonStatus.message).toBe("still connected")
    expect(unsubscribeSession).not.toHaveBeenCalled()
    expect(unsubscribeDaemon).not.toHaveBeenCalled()
    expect(unsubscribeAttachment).not.toHaveBeenCalled()

    secondCleanup()
    publishDaemon({ phase: "ready", message: "detached", updatedAt: 3 })
    publishSession(emptySessionView("session-1", 3))
    expect(unsubscribeSession).toHaveBeenCalledOnce()
    expect(unsubscribeDaemon).toHaveBeenCalledOnce()
    expect(unsubscribeAttachment).toHaveBeenCalledOnce()
    expect(useDesktopSessionStore.getState().daemonStatus.message).toBe("still connected")
    expect(useDesktopSessionStore.getState().sessionView?.cursor).toBe(1)

    const thirdCleanup = attachDesktopSessionEvents()
    expect(onUpdated).toHaveBeenCalledTimes(2)
    expect(onDaemonStatusChanged).toHaveBeenCalledTimes(2)
    expect(onUploadEvent).toHaveBeenCalledTimes(2)
    publishDaemon({ phase: "ready", message: "reattached", updatedAt: 4 })
    expect(useDesktopSessionStore.getState().daemonStatus.message).toBe("reattached")

    thirdCleanup()
    expect(unsubscribeSession).toHaveBeenCalledTimes(2)
    expect(unsubscribeDaemon).toHaveBeenCalledTimes(2)
    expect(unsubscribeAttachment).toHaveBeenCalledTimes(2)
  })

  it("resnapshots the active session after the final listener reattaches", async () => {
    const sessionSubscribers = new Set<(view: ReturnType<typeof emptySessionView>) => void>()
    const onUpdated = vi.fn((listener: (view: ReturnType<typeof emptySessionView>) => void) => {
      sessionSubscribers.add(listener)
      return () => sessionSubscribers.delete(listener)
    })
    const onDaemonStatusChanged = vi.fn(() => () => undefined)
    const open = vi.fn(async (sessionId: string) => emptySessionView(sessionId, 2))
    vi.stubGlobal("window", { desktop: { sessions: { onUpdated, onDaemonStatusChanged, open } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1", 1),
    })

    const firstCleanup = attachDesktopSessionEvents()
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    firstCleanup()
    const secondCleanup = attachDesktopSessionEvents()
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))

    expect(useDesktopSessionStore.getState().sessionView?.cursor).toBe(2)
    secondCleanup()
  })

  it("debounces goal refreshes across a burst of session updates", async () => {
    vi.useFakeTimers()
    const sessionSubscribers = new Set<(view: ReturnType<typeof emptySessionView>) => void>()
    const onUpdated = vi.fn((listener: (view: ReturnType<typeof emptySessionView>) => void) => {
      sessionSubscribers.add(listener)
      return () => sessionSubscribers.delete(listener)
    })
    const getGoal = vi.fn(async () => null)
    vi.stubGlobal("window", {
      desktop: { sessions: { onUpdated, onDaemonStatusChanged: () => () => undefined, getGoal } },
    })
    useDesktopSessionStore.setState({ activeSessionId: "session-1" })

    const cleanup = attachDesktopSessionEvents()
    try {
      for (const cursor of [2, 3, 4]) {
        sessionSubscribers.forEach((listener) => listener(emptySessionView("session-1", cursor)))
      }
      expect(getGoal).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1_000)
      expect(getGoal).toHaveBeenCalledTimes(1)
      expect(getGoal).toHaveBeenCalledWith({ sessionId: "session-1" })
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })
})

describe("desktop session store integration races", () => {
  it("queues a rapid second send before the first SSE confirmation", async () => {
    const sendPrompt = vi.fn<
      (input: { id: string; sessionId: string; content: string }) => Promise<void>
    >(async () => undefined)
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({
      activeSessionId: "session-1",
      sessionView: emptySessionView("session-1"),
    })

    await useDesktopSessionStore.getState().sendMessage("first")
    await useDesktopSessionStore.getState().sendMessage("second")

    const [firstCall, secondCall] = sendPrompt.mock.calls
    const submissions =
      useDesktopSessionStore.getState().sessionRuntimes["session-1"]?.pendingPromptSubmissions
    expect(submissions?.[firstCall![0].id]).toMatchObject({ placement: "transcript" })
    expect(submissions?.[secondCall![0].id]).toMatchObject({ placement: "queue" })
  })

  it("keeps an SSE-confirmed send successful when its IPC response arrives as an error", async () => {
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
      sessionView: emptySessionView("session-1"),
    })

    const request = useDesktopSessionStore.getState().sendMessage("confirmed")
    const inputId = sendPrompt.mock.calls[0]![0].id
    const confirmedView = emptySessionView("session-1", 1)
    confirmedView.inputs = [
      {
        id: inputId,
        sessionId: "session-1",
        seq: 1,
        delivery: "queue",
        items: [{ type: "text" as const, text: "confirmed" }],
        content: "confirmed",
        attachments: [],
        metadata: {},
        createdAt: 1,
      },
    ]
    useDesktopSessionStore.getState().applySessionUpdate(confirmedView)
    rejectSend(new Error("response lost"))

    await expect(request).resolves.toBeUndefined()
    expect(
      useDesktopSessionStore.getState().sessionRuntimes["session-1"]?.pendingPromptSubmissions[
        inputId
      ]
    ).toMatchObject({ phase: "accepted" })
  })

  it("keeps a background session failure out of the active session error scope", async () => {
    let rejectSend!: (error: Error) => void
    const sendPrompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
    useDesktopSessionStore.setState({ activeSessionId: "session-old" })

    const request = useDesktopSessionStore.getState().sendMessage("old request")
    useDesktopSessionStore.setState({ activeSessionId: "session-new" })
    rejectSend(new Error("old request failed"))

    await expect(request).rejects.toThrow("old request failed")
    expect(
      Object.values(
        useDesktopSessionStore.getState().sessionRuntimes["session-old"]
          ?.pendingPromptSubmissions ?? {}
      )
    ).toContainEqual(expect.objectContaining({ phase: "failed", error: "old request failed" }))
    expect(useDesktopSessionStore.getState().sessionRuntimes["session-new"]).toBeUndefined()
  })
})
