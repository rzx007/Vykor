import { expect, it, vi } from "vitest"

vi.mock("electron", () => ({ app: { getPath: () => "C:\\Documents" } }))

import { SessionOperations } from "./session-operations"

function clientFixture() {
  let metadata: Record<string, unknown> = {
    activePluginId: "dev.quality",
    runtime: { model: "model-a", effort: "high" },
    source: "desktop",
  }
  return {
    sessions: {
      update: async (id: string, input: { metadata: Record<string, unknown> }) => {
        metadata = {
          ...metadata,
          ...input.metadata,
          runtime: { ...(metadata.runtime as object), ...(input.metadata.runtime as object) },
        }
        return {
          id,
          cwd: "D:\\repo",
          title: "Test",
          model: "model-a",
          status: "idle",
          metadata,
          createdAt: 1,
          updatedAt: 2,
        }
      },
    },
  }
}

it("persists automatic selection independently from the manually selected plugin", async () => {
  const result = await new SessionOperations().updateSessionPluginSelection(
    clientFixture() as never,
    {
      sessionId: "session-a",
      pluginAutoSelectionEnabled: false,
    }
  )
  expect(result.metadata).toEqual({
    activePluginId: "dev.quality",
    source: "desktop",
    runtime: { model: "model-a", effort: "high", pluginAutoSelectionEnabled: false },
  })
})

it("clears the manual plugin and resumes automatic selection in one update", async () => {
  const result = await new SessionOperations().updateSessionPluginSelection(
    clientFixture() as never,
    {
      sessionId: "session-a",
      clearActivePlugin: true,
    }
  )
  expect(result.metadata).toEqual({
    activePluginId: null,
    source: "desktop",
    runtime: { model: "model-a", effort: "high", pluginAutoSelectionEnabled: true },
  })
})

it.each([{ pluginAutoSelectionEnabled: "false" }, { clearActivePlugin: "true" }, {}])(
  "rejects malformed or empty plugin selection updates: %j",
  async (input) => {
    await expect(
      new SessionOperations().updateSessionPluginSelection(
        clientFixture() as never,
        {
          sessionId: "session-a",
          ...input,
        } as never
      )
    ).rejects.toThrow()
  }
)
