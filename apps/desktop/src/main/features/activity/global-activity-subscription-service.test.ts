import { describe, expect, it, vi } from "vitest"
import { createInitialClientState, type SyncEventUpdate } from "@openharness/client"
import { GlobalActivitySubscriptionService } from "./global-activity-subscription-service"

function source() {
  const callbacks: Array<{
    resolve: (value: IteratorResult<SyncEventUpdate>) => void
    reject: (error: unknown) => void
  }> = []
  const values: SyncEventUpdate[] = []
  const state = createInitialClientState()
  const iterator: AsyncIterator<SyncEventUpdate> = {
    next: () =>
      values.length
        ? Promise.resolve({ value: values.shift()!, done: false })
        : new Promise((resolve, reject) => callbacks.push({ resolve, reject })),
  }
  return {
    iterator,
    push(value: SyncEventUpdate) {
      const resolve = callbacks.shift()
      if (resolve) resolve.resolve({ value, done: false })
      else values.push(value)
    },
    fail(error: unknown) {
      callbacks.shift()?.reject(error)
    },
    state,
  }
}

describe("GlobalActivitySubscriptionService", () => {
  it("recovers the same owner when the initial replay fails once", async () => {
    const recovered = source()
    const createIterator = vi
      .fn()
      .mockImplementationOnce(() => ({
        next: async () => {
          throw new Error("temporary replay failure")
        },
      }))
      .mockImplementation(() => recovered.iterator)
    const service = new GlobalActivitySubscriptionService(createIterator)
    const webContents = {
      id: 41,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    }
    const opened = service.open({} as never, webContents as never)

    await vi.waitFor(() => expect(createIterator).toHaveBeenCalledTimes(2))
    recovered.push({ state: recovered.state, source: "snapshot" })

    expect(await opened).toMatchObject({ delivery: "baseline", cursor: 0 })
    expect(service.hasOwner(41)).toBe(true)
    expect(await service.open({} as never, webContents as never)).toMatchObject({
      delivery: "baseline",
    })
    service.clearAll()
  })

  it("restarts a failed live iterator and delivers missed events as catchup", async () => {
    const first = source()
    const recovered = source()
    const createIterator = vi
      .fn()
      .mockReturnValueOnce(first.iterator)
      .mockReturnValue(recovered.iterator)
    const service = new GlobalActivitySubscriptionService(createIterator)
    const webContents = {
      id: 42,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    }
    const opened = service.open({} as never, webContents as never)
    first.push({ state: first.state, source: "snapshot" })
    await opened
    first.fail(new Error("stream crashed"))
    await vi.waitFor(() => expect(createIterator).toHaveBeenCalledTimes(2))
    recovered.push({
      event: {
        id: "missed",
        seq: 1,
        type: "scheduled.run.created",
        schemaVersion: 1,
        payload: {
          run: {
            id: "run",
            taskId: "task",
            status: "queued",
            cause: "scheduled",
            scheduledFor: 1,
            unread: false,
            createdAt: 1,
            updatedAt: 1,
          },
        },
        createdAt: 1,
      },
      state: { ...recovered.state, lastSeq: 1 },
      source: "replay",
    })
    recovered.push({ state: { ...recovered.state, lastSeq: 1 }, source: "snapshot" })
    await vi.waitFor(() =>
      expect(webContents.send).toHaveBeenCalledWith(
        "activity:updated",
        expect.objectContaining({ delivery: "catchup", cursor: 1 })
      )
    )
    await vi.waitFor(() =>
      expect(webContents.send).toHaveBeenCalledWith(
        "activity:updated",
        expect.objectContaining({ delivery: "baseline" })
      )
    )
    service.clearAll()
  })
  it("opens one stream per owner, waits for baseline, and aborts on destruction", async () => {
    const stream = source()
    const createIterator = vi.fn(() => stream.iterator)
    const service = new GlobalActivitySubscriptionService(createIterator)
    const listeners = new Map<string, () => void>()
    const webContents = {
      id: 1,
      isDestroyed: () => false,
      send: vi.fn(),
      once: (event: string, listener: () => void) => {
        listeners.set(event, listener)
      },
      removeListener: vi.fn(),
    }
    const client = {} as never
    const opened = service.open(client, webContents as never)
    stream.push({ state: stream.state, source: "snapshot" })
    expect(await opened).toEqual({ cursor: 0, delivery: "baseline", sessions: [], scheduled: [] })
    expect(await service.open(client, webContents as never)).toEqual({
      cursor: 0,
      delivery: "baseline",
      sessions: [],
      scheduled: [],
    })
    expect(createIterator).toHaveBeenCalledTimes(1)

    listeners.get("destroyed")!()
    expect(service.hasOwner(1)).toBe(false)
  })

  it("sends a full scheduled baseline then only the changed run for catchup and live", async () => {
    const stream = source()
    const service = new GlobalActivitySubscriptionService(() => stream.iterator)
    const webContents = {
      id: 2,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    }
    const run = {
      id: "run1",
      taskId: "task1",
      cause: "manual" as const,
      status: "running" as const,
      scheduledFor: 1,
      unread: false,
      createdAt: 1,
      updatedAt: 1,
    }
    const event = (
      seq: number,
      status: typeof run.status | "succeeded",
      sourceName: "replay" | "live"
    ) =>
      ({
        event: {
          id: `e${seq}`,
          seq,
          type: seq === 1 ? "scheduled.run.created" : "scheduled.run.updated",
          schemaVersion: 1,
          payload: {
            run: { ...run, status, unread: status === "succeeded", updatedAt: seq },
            previousStatus: "running",
          },
          createdAt: seq,
        },
        state: { ...stream.state, lastSeq: seq },
        source: sourceName,
      }) as SyncEventUpdate

    const opened = service.open({} as never, webContents as never)
    stream.push(event(1, "running", "replay"))
    stream.push({ state: { ...stream.state, lastSeq: 1 }, source: "snapshot" })
    const baseline = await opened
    expect(baseline).toMatchObject({
      cursor: 1,
      delivery: "baseline",
      scheduled: [{ run: { id: "run1", status: "running" } }],
    })
    expect(webContents.send).not.toHaveBeenCalled()

    stream.push(event(2, "succeeded", "replay"))
    stream.push(event(3, "succeeded", "live"))
    await vi.waitFor(() => expect(webContents.send).toHaveBeenCalledTimes(2))
    expect(webContents.send.mock.calls[0]![1]).toMatchObject({
      delivery: "catchup",
      eventType: "scheduled.run.updated",
      previousStatus: "running",
      scheduled: [{ run: { status: "succeeded" } }],
    })
    expect(webContents.send.mock.calls[1]![1]).toMatchObject({
      delivery: "live",
      cursor: 3,
      sessions: [],
      scheduled: [{ run: { id: "run1" } }],
    })
    expect(await service.open({} as never, webContents as never)).toMatchObject({
      delivery: "baseline",
      cursor: 3,
      scheduled: [{ run: { id: "run1", status: "succeeded" } }],
    })
    service.clearAll()
    expect(webContents.removeListener).toHaveBeenCalledWith("destroyed", expect.any(Function))
  })

  it("removes a deleted task's old runs from live updates and future baselines", async () => {
    const stream = source()
    const service = new GlobalActivitySubscriptionService(() => stream.iterator)
    const webContents = {
      id: 43,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    }
    const client = {} as never
    const opened = service.open(client, webContents as never)
    stream.push({
      event: {
        id: "e1",
        seq: 1,
        type: "scheduled.run.created",
        schemaVersion: 1,
        payload: {
          run: {
            id: "run",
            taskId: "task",
            status: "queued",
            cause: "scheduled",
            scheduledFor: 1,
            unread: false,
            createdAt: 1,
            updatedAt: 1,
          },
        },
        createdAt: 1,
      },
      state: { ...stream.state, lastSeq: 1 },
      source: "replay",
    })
    stream.push({ state: { ...stream.state, lastSeq: 1 }, source: "snapshot" })
    expect((await opened).scheduled).toHaveLength(1)
    stream.push({
      event: {
        id: "e2",
        seq: 2,
        type: "scheduled.task.deleted",
        schemaVersion: 1,
        payload: { taskId: "task" },
        createdAt: 2,
      },
      state: { ...stream.state, lastSeq: 2 },
      source: "live",
    })
    await vi.waitFor(() =>
      expect(webContents.send).toHaveBeenCalledWith(
        "activity:updated",
        expect.objectContaining({ removedTaskId: "task" })
      )
    )
    expect((await service.open(client, webContents as never)).scheduled).toEqual([])
    service.clearAll()
  })

  it("removes a deleted session from every owner's next baseline", async () => {
    const stream = source()
    const closeDeletedSubscriptions = vi.fn()
    const service = new GlobalActivitySubscriptionService(
      () => stream.iterator,
      closeDeletedSubscriptions
    )
    const webContents = {
      id: 44,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    }
    const client = {} as never
    const session = {
      id: "gone",
      cwd: "D:/repo",
      title: "Gone",
      model: "m",
      status: "idle" as const,
      metadata: { desktop: { workspaceMode: "outside_project" } },
      createdAt: 1,
      updatedAt: 1,
    }
    const state = createInitialClientState()
    state.buckets.gone = {
      session,
      inputs: [],
      messages: [],
      partsByMessageId: {},
      runs: {},
      attempts: {},
      tasks: {},
      permissions: {},
    }
    const opened = service.open(client, webContents as never)
    stream.push({
      event: {
        id: "e1",
        seq: 1,
        type: "session.created",
        schemaVersion: 1,
        sessionId: "gone",
        payload: { session },
        createdAt: 1,
      },
      state: { ...state, lastSeq: 1 },
      source: "replay",
    })
    stream.push({ state: { ...state, lastSeq: 1 }, source: "snapshot" })
    expect((await opened).sessions.map((item) => item.session.id)).toEqual(["gone"])
    stream.push({
      event: {
        id: "e2",
        seq: 2,
        type: "session.deleted",
        schemaVersion: 1,
        payload: { sessionIds: ["gone"] },
        createdAt: 2,
      },
      state: { ...createInitialClientState(), lastSeq: 2 },
      source: "live",
    })
    await vi.waitFor(() =>
      expect(webContents.send).toHaveBeenCalledWith(
        "activity:updated",
        expect.objectContaining({ removedSessionIds: ["gone"] })
      )
    )
    expect(closeDeletedSubscriptions).toHaveBeenCalledWith(44, ["gone"])
    expect((await service.open(client, webContents as never)).sessions).toEqual([])
    expect((await service.open(client, webContents as never)).removedSessionIds).toEqual(["gone"])
    service.clearAll()
  })

  it("normalizes session metadata for Desktop sidebar grouping in the baseline", async () => {
    const stream = source()
    const service = new GlobalActivitySubscriptionService(() => stream.iterator)
    const webContents = {
      id: 3,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    }
    const session = {
      id: "outside",
      cwd: "D:/other",
      title: "Outside",
      model: "test",
      status: "idle" as const,
      metadata: { desktop: { workspaceMode: "outside_project" } },
      createdAt: 1,
      updatedAt: 1,
    }
    const state = createInitialClientState()
    state.lastSeq = 1
    state.buckets.outside = {
      session,
      inputs: [],
      messages: [],
      partsByMessageId: {},
      runs: {},
      attempts: {},
      tasks: {},
      permissions: {},
    }
    const opened = service.open({} as never, webContents as never)
    stream.push({
      event: {
        id: "e1",
        seq: 1,
        type: "session.created",
        schemaVersion: 1,
        sessionId: "outside",
        payload: { session },
        createdAt: 1,
      },
      state,
      source: "replay",
    })
    stream.push({ state, source: "snapshot" })
    expect(await opened).toMatchObject({
      sessions: [{ session: { id: "outside", workspaceMode: "outside_project" }, activitySeq: 0 }],
    })
    service.clearAll()
  })

  it("keeps the latest terminal activity seq through a later running replay", async () => {
    const stream = source()
    const service = new GlobalActivitySubscriptionService(() => stream.iterator)
    const webContents = {
      id: 4,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    }
    const session = {
      id: "s1",
      cwd: "D:/other",
      title: "Session",
      model: "test",
      status: "running" as const,
      metadata: { desktop: { workspaceMode: "outside_project" } },
      createdAt: 1,
      updatedAt: 1,
    }
    const state = createInitialClientState()
    state.buckets.s1 = {
      session,
      inputs: [],
      messages: [],
      partsByMessageId: {},
      runs: {},
      attempts: {},
      tasks: {},
      permissions: {},
    }
    const push = (seq: number, type: string, payload: Record<string, unknown>) => {
      stream.push({
        event: {
          id: `e${seq}`,
          seq,
          type,
          schemaVersion: 1,
          sessionId: "s1",
          payload,
          createdAt: seq,
        },
        state: { ...state, lastSeq: seq },
        source: "replay",
      })
    }
    const opened = service.open({} as never, webContents as never)
    push(1, "session.created", { session })
    push(2, "session.run.created", { run: { id: "r1", status: "running" } })
    state.buckets.s1.runs.r1 = {
      id: "r1",
      sessionId: "s1",
      status: "completed",
      metadata: {},
      createdAt: 2,
      updatedAt: 3,
    }
    push(3, "session.run.updated", { run: state.buckets.s1.runs.r1 })
    state.buckets.s1.runs.r2 = {
      id: "r2",
      sessionId: "s1",
      status: "running",
      metadata: {},
      createdAt: 4,
      updatedAt: 4,
    }
    push(4, "session.run.created", { run: state.buckets.s1.runs.r2 })
    stream.push({ state: { ...state, lastSeq: 4 }, source: "snapshot" })
    const baseline = await opened
    expect(baseline.sessions[0]).toMatchObject({ executionState: "running", activitySeq: 3 })
    service.clearAll()
  })
})
