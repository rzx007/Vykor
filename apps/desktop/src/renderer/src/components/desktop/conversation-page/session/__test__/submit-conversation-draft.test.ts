import { afterEach, expect, it, vi } from "vitest"
import type { SendDesktopPromptInput } from "@shared/session-types"
import { submitConversationDraft } from "../submit-conversation-draft"
import { pluginAppModelContexts } from "../../../shell/plugin-apps/plugin-app-model-context"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session/store"
import { emptySessionView, resetDesktopSessionStore } from "@renderer/stores/desktop-session/store-test-fixtures"
afterEach(() => { vi.unstubAllGlobals(); for (const entry of pluginAppModelContexts.snapshot()) pluginAppModelContexts.remove(entry.id) })
it("the real page submit entry admits a context-only draft through the existing store and IPC", async () => {
  resetDesktopSessionStore()
  useDesktopSessionStore.setState({ activeSessionId: "s", sessionView: emptySessionView("s") })
  pluginAppModelContexts.put({ id: "selection", source: { sessionId: "s", appId: "a" }, pluginId: "example", text: "selection", data: null })
  const sendPrompt = vi.fn<(input: SendDesktopPromptInput) => Promise<void>>(async () => {})
  vi.stubGlobal("window", { desktop: { sessions: { sendPrompt } } })
  await submitConversationDraft({ sessionId: "s", content: "", attachmentCount: 0, ready: true, blocked: false, goalMode: false },
    () => useDesktopSessionStore.getState().sendMessage(""))
  expect(sendPrompt).toHaveBeenCalledOnce()
  expect(sendPrompt.mock.calls[0]?.[0]).toMatchObject({ sessionId: "s", pluginAppContextIds: ["selection"] })
})
it("does not use another session's context or bypass attachment, busy or goal checks", async () => {
  pluginAppModelContexts.put({ id: "selection", source: { sessionId: "s", appId: "a" }, pluginId: "example", text: "selection", data: null })
  const send = vi.fn(async () => {})
  const input = { sessionId: "other", content: "", attachmentCount: 0, ready: true, blocked: false, goalMode: false }
  await submitConversationDraft(input, send)
  await submitConversationDraft({ ...input, sessionId: "s", blocked: true }, send)
  await submitConversationDraft({ ...input, sessionId: "s", ready: false }, send)
  await submitConversationDraft({ ...input, sessionId: "s", goalMode: true }, send)
  expect(send).not.toHaveBeenCalled()
})
