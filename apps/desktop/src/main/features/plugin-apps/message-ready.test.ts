import { expect, it, vi } from "vitest"
import type { VykorClient } from "@vykor/application-client"
import { pluginAppMessageReady } from "./message-ready"
it("requires an actual selected model and enabled runtime instead of trusting a configured label", async () => {
  const settings = { modelDisabled: false }
  const models: Array<{ id: string; providerName: string }> = []
  const client = { sessions: { get: vi.fn(async () => ({ model: "chosen", status: "idle", metadata: { runtime: { provider: "provider" } } })) },
    system: { getSettings: vi.fn(async () => settings) }, providers: { listModels: vi.fn(async () => [{ models }]) } } as unknown as VykorClient
  expect(await pluginAppMessageReady(client, "s")).toBe(false)
  models.push({ id: "chosen", providerName: "provider" })
  expect(await pluginAppMessageReady(client, "s")).toBe(true)
  settings.modelDisabled = true
  expect(await pluginAppMessageReady(client, "s")).toBe(false)
})
