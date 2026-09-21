import { describe, expect, it, vi } from "vitest"
import { SessionSubscriptionService } from "./session-subscription-service"

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
})
