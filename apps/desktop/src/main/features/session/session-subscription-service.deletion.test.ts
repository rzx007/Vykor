import { afterEach, describe, expect, it, vi } from "vitest"
import { EventEmitter, on } from "node:events"
import type { SessionEventRecord, SessionStateSnapshot } from "@vykor/client"
import { SessionSubscriptionService } from "./session-subscription-service"

afterEach(() => vi.useRealTimers())

describe("active session subscription after deletion", () => {
  it("stops the primary stream when its Activity owner reports deletion", async () => {
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
    const client = {
      sessions: {
        getState: vi.fn(async () => ({
          cursor: 1,
          session,
          inputs: [],
          messages: [],
          parts: [],
          runs: [],
          attempts: [],
          permissions: [],
        })),
      },
      events: {
        list: vi.fn(async () => []),
        stream: vi.fn(async function* () {
          await new Promise<never>(() => undefined)
          yield {
            id: "never",
            seq: 2,
            type: "daemon.test",
            schemaVersion: 1,
            payload: {},
            createdAt: 2,
          }
        }),
      },
    }
    const webContents = { id: 77, once: vi.fn(), isDestroyed: () => false, send: vi.fn() }
    const service = new SessionSubscriptionService()
    await service.openSession(client as never, webContents as never, "gone")

    expect(service.hasPrimary(77, "gone")).toBe(true)
    service.closeDeletedSessions(77, ["gone"])
    expect(service.hasPrimary(77, "gone")).toBe(false)
    expect(webContents.send).not.toHaveBeenCalled()
    service.clearAll()
  })

  it("replaces only the primary stream during resync and keeps auxiliary delivery until explicit owner close", async () => {
    vi.useFakeTimers()
    const live = new EventEmitter()
    const signals: Array<{ sessionId: string; signal: AbortSignal }> = []
    const record = (id: string) => ({
      id,
      cwd: "D:/repo",
      title: id,
      model: "m",
      status: "idle" as const,
      metadata: { desktop: { workspaceMode: "outside_project" } },
      createdAt: 1,
      updatedAt: 1,
    })
    const client = {
      sessions: {
        getState: async (
          sessionId: string,
          options: { signal: AbortSignal }
        ): Promise<SessionStateSnapshot> => {
          signals.push({ sessionId, signal: options.signal })
          return {
            cursor: 1,
            session: record(sessionId),
            inputs: [],
            messages: [],
            parts: [],
            runs: [],
            attempts: [],
            permissions: [],
            tasks: [],
          }
        },
      },
      events: {
        list: async () => [],
        stream: async function* (options: { sessionId: string; signal: AbortSignal }) {
          for await (const [event] of on(live, options.sessionId, { signal: options.signal }))
            yield event as SessionEventRecord
        },
      },
    }
    const webContents = { id: 77, once: vi.fn(), isDestroyed: () => false, send: vi.fn() }
    const service = new SessionSubscriptionService({ sessionUpdateIntervalMs: 10 })
    try {
      await service.openSession(client as never, webContents as never, "A")
      const invalidatedOwners: number[] = []
      service.onOwnerInvalidated(ownerId => invalidatedOwners.push(ownerId))
      await service.openAuxSession(client as never, webContents as never, {
        subscriptionId: "side-B",
        sessionId: "B",
      })
      await vi.advanceTimersByTimeAsync(1)
      const firstPrimary = signals[0]!.signal
      const auxiliary = signals[1]!.signal
      await service.openSession(client as never, webContents as never, "A")
      await vi.advanceTimersByTimeAsync(1)
      const nextPrimary = signals[2]!.signal
      expect(invalidatedOwners).toEqual([77])
      expect(firstPrimary.aborted).toBe(true)
      expect(nextPrimary.aborted).toBe(false)
      expect(auxiliary.aborted).toBe(false)
      live.emit("B", {
        id: "B-update",
        seq: 2,
        type: "session.updated",
        schemaVersion: 1,
        sessionId: "B",
        payload: { session: { ...record("B"), title: "side still streaming", updatedAt: 2 } },
        createdAt: 2,
      } satisfies SessionEventRecord)
      await vi.advanceTimersByTimeAsync(11)
      expect(webContents.send).toHaveBeenCalledWith(
        "session:aux-updated",
        expect.objectContaining({
          subscriptionId: "side-B",
          view: expect.objectContaining({
            cursor: 2,
            session: expect.objectContaining({ id: "B", title: "side still streaming" }),
          }),
        })
      )
      service.closeSession(webContents.id)
      expect(nextPrimary.aborted).toBe(true)
      expect(auxiliary.aborted).toBe(true)
      expect(service.hasPrimary(webContents.id, "A")).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
    } finally {
      service.clearAll()
    }
  })
})
