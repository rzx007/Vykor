import { expect, it, vi } from "vitest"

vi.mock("electron", () => ({ app: { getPath: () => "C:\\Documents" } }))

import { SessionOperations } from "./session-operations"

it("marks a new session as following the default effort only when effort is not selected", async () => {
  const create = vi.fn(async (input: Record<string, any>) => ({
    ...input,
    id: "new-session",
    title: "",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  }))
  const client = {
    providers: { listModels: async () => [{
      name: "provider-a",
      models: [{ id: "model-a", providerName: "provider-a" }],
    }] },
    sessions: { create },
  }
  const operations = new SessionOperations()
  const base = {
    projectId: "project-a", cwd: "D:\\repo",
    model: "model-a", provider: "provider-a",
  }
  await operations.createSession(client as never, base)
  expect(create.mock.calls[0]![0].metadata.runtimeDefaultFields).toEqual(["effort"])
  await operations.createSession(client as never, { ...base, effort: "high" })
  expect(create.mock.calls[1]![0].metadata.runtimeDefaultFields).toBeUndefined()
})
