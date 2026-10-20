import { expect, it, vi } from "vitest"

vi.mock("electron", () => ({ app: { getPath: () => "C:\\Documents" } }))

import { SessionOperations } from "./session-operations"

it("writes approval and work modes independently when creating a session", async () => {
  const create = vi.fn(async (input: Record<string, any>) => ({
    ...input, id: "new", title: "", status: "idle", createdAt: 1, updatedAt: 1,
  }))
  const client = {
    system: { getSettings: async () => ({}) },
    providers: { listModels: async () => [{ models: [{ id: "model", providerName: "local" }] }] },
    sessions: { create },
  }
  await new SessionOperations().createSession(client as never, {
    projectId: "project", cwd: "D:\\repo", model: "model", provider: "local",
    permissionMode: "full_access", workMode: "plan",
  })
  expect(create.mock.calls[0]![0].metadata.runtime).toEqual({
    model: "model", provider: "local", approvalMode: "full_access", workMode: "plan",
  })
})

it("leaves approval unchanged when removing plan mode", async () => {
  const update = vi.fn(async (_id: string, input: Record<string, any>) => ({
    id: "session", title: "", cwd: "D:\\repo", model: "model", status: "idle",
    ...input, createdAt: 1, updatedAt: 1,
  }))
  await new SessionOperations().updateSessionPermissionMode({ sessions: { update } } as never, {
    sessionId: "session", workMode: "execute",
  })
  expect(update).toHaveBeenCalledWith("session", { metadata: { runtime: { workMode: "execute" } } })
})

it("rejects unknown work modes before updating a session", async () => {
  const update = vi.fn()
  await expect(new SessionOperations().updateSessionPermissionMode({ sessions: { update } } as never, {
    sessionId: "session", workMode: "other" as never,
  })).rejects.toThrow()
  expect(update).not.toHaveBeenCalled()
})
