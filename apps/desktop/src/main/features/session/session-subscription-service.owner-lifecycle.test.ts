import { afterEach, describe, expect, it, vi } from "vitest"
import type { SessionEventRecord } from "@vykor/client"
import { SessionSubscriptionService } from "./session-subscription-service"

afterEach(() => vi.useRealTimers())

function makeClient() {
  const session = (id: string) => ({
    id,
    cwd: "D:/repo",
    title: id,
    model: "m",
    status: "idle" as const,
    metadata: { desktop: { workspaceMode: "outside_project" } },
    createdAt: 1,
    updatedAt: 1,
  })
  return {
    sessions: {
      getState: vi.fn(async (sessionId: string) => ({
        cursor: 1,
        session: session(sessionId),
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
        } satisfies SessionEventRecord
      }),
    },
  }
}

function makeWebContents(id = 77) {
  return { id, once: vi.fn(), isDestroyed: () => false, send: vi.fn() }
}

describe("session subscription owner lifecycle", () => {
  it("每个 webContents 只注册一次 destroyed 回收钩子", async () => {
    const client = makeClient()
    const webContents = makeWebContents()
    const service = new SessionSubscriptionService()

    await service.openSession(client as never, webContents as never, "A")
    await service.openSession(client as never, webContents as never, "B")
    await service.openSession(client as never, webContents as never, "C")

    const destroyedRegistrations = webContents.once.mock.calls.filter(
      ([event]) => event === "destroyed"
    )
    expect(destroyedRegistrations).toHaveLength(1)
    service.clearAll()
  })

  it("destroyed 钩子仍然回收该 owner 的订阅", async () => {
    const client = makeClient()
    const webContents = makeWebContents()
    const service = new SessionSubscriptionService()

    await service.openSession(client as never, webContents as never, "A")
    await service.openSession(client as never, webContents as never, "B")
    expect(service.hasPrimary(77, "B")).toBe(true)

    const registration = webContents.once.mock.calls.find(([event]) => event === "destroyed")
    expect(registration).toBeDefined()
    const handler = registration![1] as () => void
    handler()

    expect(service.hasPrimary(77, "B")).toBe(false)
    service.clearAll()
  })
})
