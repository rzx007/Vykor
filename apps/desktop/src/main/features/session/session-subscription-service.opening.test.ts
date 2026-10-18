import { afterEach, describe, expect, it, vi } from "vitest"
import type { SessionStateSnapshot } from "@vykor/client"

import { SessionSubscriptionService } from "./session-subscription-service"

afterEach(() => vi.useRealTimers())

function snapshot(sessionId: string): SessionStateSnapshot {
  return {
    cursor: 1,
    session: {
      id: sessionId,
      cwd: "D:/repo",
      title: sessionId,
      model: "m",
      status: "idle",
      metadata: { desktop: { workspaceMode: "outside_project" } },
      createdAt: 1,
      updatedAt: 1,
    },
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    attempts: [],
    permissions: [],
    tasks: [],
  }
}

function harness() {
  vi.useFakeTimers()
  const service = new SessionSubscriptionService()
  const owner = { id: 77, once: vi.fn(), isDestroyed: () => false, send: vi.fn() }
  const reads: Array<{
    sessionId: string
    signal: AbortSignal
    resolve: (value: SessionStateSnapshot) => void
    reject: (error: Error) => void
  }> = []
  const client = {
    sessions: {
      getState: vi.fn((sessionId: string, options?: { signal?: AbortSignal }) =>
        new Promise<SessionStateSnapshot>((resolve, reject) => {
          const signal = options?.signal
          if (!signal) throw new Error("Expected a cancellable snapshot request")
          signal.throwIfAborted()
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          reads.push({ sessionId, signal, resolve, reject })
        })
      ),
    },
    events: { list: async () => [], stream: async function* () {} },
  }
  const open = (sessionId: string, window = owner) =>
    service.openSession(client, window as never, sessionId)
  return { service, owner, client, reads, open }
}

describe("opening a primary session", () => {
  it("shares a pending snapshot when the same window opens the same session twice", async () => {
    const h = harness()
    try {
      const first = h.open("A")
      const firstOutcome = Promise.allSettled([first])
      await vi.waitFor(() => expect(h.reads).toHaveLength(1))
      const second = h.open("A")
      const secondOutcome = Promise.allSettled([second])
      await Promise.resolve()
      for (const read of h.reads) read.resolve(snapshot(read.sessionId))

      expect((await firstOutcome)[0]).toMatchObject({
        status: "fulfilled",
        value: { session: { id: "A" } },
      })
      expect((await secondOutcome)[0]).toMatchObject({
        status: "fulfilled",
        value: { session: { id: "A" } },
      })
      expect(h.reads).toHaveLength(1)
      expect(h.reads[0]!.signal.aborted).toBe(false)
    } finally {
      h.service.clearAll()
    }
  })

  it("still cancels a pending snapshot when the window switches to another session", async () => {
    const h = harness()
    try {
      const firstOutcome = Promise.allSettled([h.open("A")])
      await vi.waitFor(() => expect(h.reads).toHaveLength(1))
      const second = h.open("B")
      await vi.waitFor(() => expect(h.reads).toHaveLength(2))
      h.reads[1]!.resolve(snapshot("B"))

      expect((await firstOutcome)[0]).toMatchObject({ status: "rejected" })
      await expect(second).resolves.toMatchObject({ session: { id: "B" } })
      expect(h.service.getOwnerSessionId(77)).toBe("B")
    } finally {
      h.service.clearAll()
    }
  })

  it("starts a fresh snapshot when a closed pending session is reopened", async () => {
    const h = harness()
    try {
      const firstOutcome = Promise.allSettled([h.open("A")])
      await vi.waitFor(() => expect(h.reads).toHaveLength(1))
      h.service.closeSession(77)
      const second = h.open("A")
      await vi.waitFor(() => expect(h.reads).toHaveLength(2))
      h.reads[1]!.resolve(snapshot("A"))

      expect((await firstOutcome)[0]).toMatchObject({ status: "rejected" })
      await expect(second).resolves.toMatchObject({ session: { id: "A" } })
      expect(h.reads[1]!.signal.aborted).toBe(false)
    } finally {
      h.service.clearAll()
    }
  })

  it("releases a failed open so another attempt can load the session", async () => {
    const h = harness()
    try {
      const firstOutcome = Promise.allSettled([h.open("A")])
      await vi.waitFor(() => expect(h.reads).toHaveLength(1))
      h.reads[0]!.reject(new Error("connection failed"))
      expect((await firstOutcome)[0]).toMatchObject({
        status: "rejected",
        reason: { message: "connection failed" },
      })
      const second = h.open("A")
      await vi.waitFor(() => expect(h.reads).toHaveLength(2))
      h.reads[1]!.resolve(snapshot("A"))

      await expect(second).resolves.toMatchObject({ session: { id: "A" } })
    } finally {
      h.service.clearAll()
    }
  })

  it("fetches a new snapshot when a completed open is refreshed", async () => {
    const h = harness()
    try {
      const first = h.open("A")
      await vi.waitFor(() => expect(h.reads).toHaveLength(1))
      h.reads[0]!.resolve(snapshot("A"))
      await first

      const refresh = h.open("A")
      await vi.waitFor(() => expect(h.reads).toHaveLength(2))
      const updated = snapshot("A")
      updated.session.title = "Updated title"
      h.reads[1]!.resolve(updated)

      await expect(refresh).resolves.toMatchObject({ session: { title: "Updated title" } })
    } finally {
      h.service.clearAll()
    }
  })

  it("loads the same session independently in different windows", async () => {
    const h = harness()
    try {
      const first = h.open("A")
      const second = h.open("A", { ...h.owner, id: 78 })
      await vi.waitFor(() => expect(h.reads).toHaveLength(2))
      for (const read of h.reads) read.resolve(snapshot("A"))

      await expect(Promise.all([first, second])).resolves.toHaveLength(2)
      h.service.closeSession(77)
      expect(h.service.getOwnerSessionId(77)).toBeUndefined()
      expect(h.service.getOwnerSessionId(78)).toBe("A")
    } finally {
      h.service.clearAll()
    }
  })
})
