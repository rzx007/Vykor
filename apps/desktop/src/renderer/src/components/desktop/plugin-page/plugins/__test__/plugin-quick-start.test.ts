import { expect, it, vi } from "vitest"
import type { DesktopPluginInfo } from "@shared/plugin-types"
import {
  composerDocument,
  type ComposerDocument,
} from "@renderer/stores/desktop-session/composer-document"
import { preparePluginConversation } from "../plugin-quick-start"

const plugin: DesktopPluginInfo = {
  identity: { id: "dev.example", name: "example", displayName: "Example", version: "1" },
  enabled: true,
  installation: "installed",
  origin: "native",
  scope: "user",
  activation: "reload-required",
  inventory: {},
  diagnostics: [],
  permissions: { requested: [], approved: [], missing: [] },
  runtimeStatus: { state: "pending_reload", message: "下一次对话生效。", action: "reload" },
}

it("waits for new conversation setup, preserves its draft and attachments, and selects the plugin without sending", async () => {
  const attachments = [{ draftId: "existing" }] as never
  const draft = { document: composerDocument([{ type: "text", text: "已有草稿" }]), attachments }
  const state = {
    composerDraftsByScope: { "new-conversation": draft },
    startNewConversation: vi.fn(async () => {
      draft.document = composerDocument([{ type: "text", text: "切换后的草稿" }])
    }),
    setGoalMode: vi.fn(),
    setComposerDraftDocument: vi.fn(),
  }
  await preparePluginConversation(plugin, "写报告", () => state)
  expect(state.startNewConversation).toHaveBeenCalledOnce()
  expect(state.setGoalMode).toHaveBeenCalledWith("new-conversation", false)
  expect(state.setComposerDraftDocument).toHaveBeenCalledWith(
    "new-conversation",
    composerDocument([
      { type: "capability", kind: "plugin", pluginId: "dev.example", displayName: "Example" },
      { type: "text", text: " 切换后的草稿\n\n写报告" },
    ])
  )
  expect(draft.attachments).toBe(attachments)
})

it("immediate use selects only the requested plugin while keeping text", async () => {
  const state = {
    composerDraftsByScope: {
      "new-conversation": {
        attachments: [],
        document: composerDocument([
          { type: "capability", kind: "plugin", pluginId: "dev.other", displayName: "Other" },
          { type: "text", text: "未发送" },
        ]),
      },
    },
    startNewConversation: vi.fn(async () => undefined),
    setGoalMode: vi.fn(),
    setComposerDraftDocument: vi.fn<(scope: string, document: ComposerDocument) => void>(),
  }
  await preparePluginConversation(plugin, "", () => state)
  const document = state.setComposerDraftDocument.mock.calls[0]![1]
  expect(document.items.filter((item) => item.type === "capability")).toEqual([
    { type: "capability", kind: "plugin", pluginId: "dev.example", displayName: "Example" },
  ])
  expect(document.items[1]).toEqual({ type: "text", text: " 未发送" })
})

it("keeps the current conversation intact if opening a new one fails", async () => {
  const state = {
    composerDraftsByScope: {},
    startNewConversation: vi.fn(async () => {
      throw new Error("offline")
    }),
    setGoalMode: vi.fn(),
    setComposerDraftDocument: vi.fn(),
  }
  await expect(preparePluginConversation(plugin, "hello", () => state)).rejects.toThrow("offline")
  expect(state.setComposerDraftDocument).not.toHaveBeenCalled()
})

it.each([
  { ...plugin, enabled: false },
  { ...plugin, permissions: { missing: ["network"] } },
  { ...plugin, runtimeStatus: { state: "failed" } },
])("rejects unavailable plugins before opening a conversation", async (unavailable) => {
  const state = {
    composerDraftsByScope: {},
    startNewConversation: vi.fn(),
    setGoalMode: vi.fn(),
    setComposerDraftDocument: vi.fn(),
  }
  await expect(
    preparePluginConversation(unavailable as DesktopPluginInfo, "hello", () => state)
  ).rejects.toThrow("请先")
  expect(state.startNewConversation).not.toHaveBeenCalled()
})
