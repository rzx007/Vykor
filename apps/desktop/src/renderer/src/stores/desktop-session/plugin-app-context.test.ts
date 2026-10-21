import type { SendDesktopPromptInput } from "@shared/session-types"
import { afterEach, expect, it, vi } from "vitest"
import { pluginAppModelContexts } from "@renderer/components/desktop/shell/plugin-apps/plugin-app-model-context"
import { emptySessionView, resetDesktopSessionStore } from "./store-test-fixtures"
import { useDesktopSessionStore } from "./store"
import { composerDocument } from "./composer-document"
afterEach(() => {
  vi.unstubAllGlobals()
  for (const entry of pluginAppModelContexts.snapshot()) pluginAppModelContexts.remove(entry.id)
})
it("keeps draft and visible selection on rejected source; removing it restores ordinary send", async () => {
  resetDesktopSessionStore()
  const view = emptySessionView("session")
  useDesktopSessionStore.setState({ activeSessionId: "session", sessionView: view })
  const draft = composerDocument([{ type: "text", text: "already typed" }])
  pluginAppModelContexts.put({
    id: "selection",
    source: { sessionId: "session", appId: "app" },
    pluginId: "example",
    text: "selected",
    data: null,
  })
  const sendPrompt = vi.fn<(input: SendDesktopPromptInput) => Promise<void>>(async () => {
    throw new Error("plugin_app_context_expired")
  })
  vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
  await expect(
    useDesktopSessionStore.getState().sendMessage("already typed", { document: draft })
  ).rejects.toThrow("context_expired")
  expect(draft.items).toEqual([{ type: "text", text: "already typed" }])
  expect(pluginAppModelContexts.forSession("session")).toHaveLength(1)
  expect(sendPrompt.mock.calls[0]?.[0]).toMatchObject({ pluginAppContextIds: ["selection"] })
  pluginAppModelContexts.remove("selection")
  sendPrompt.mockImplementation(async () => undefined)
  await useDesktopSessionStore.getState().sendMessage("already typed", { document: draft })
  expect(sendPrompt.mock.calls[1]?.[0]).not.toHaveProperty("pluginAppContextIds")
})
