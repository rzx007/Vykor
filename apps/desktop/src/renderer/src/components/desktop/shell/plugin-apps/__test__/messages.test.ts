import { afterEach, expect, it, vi } from "vitest"
import type { DesktopPluginAppsAPI, PluginAppConfirmation } from "@shared/plugin-app-types"
import { PluginAppController } from "../controller"
import { pluginAppModelContexts } from "../plugin-app-model-context"
import { mount } from "./fixtures.test-support"
afterEach(() => { for (const entry of pluginAppModelContexts.snapshot()) pluginAppModelContexts.remove(entry.id) })
function fixture(confirm: (request: PluginAppConfirmation, signal: AbortSignal) => Promise<boolean> = async () => true) {
  let count = 0
  const calls = { prepareMessage: vi.fn(async () => ({ requestId: `m${++count}`, text: "hello", data: null, expectedRevision: 2 })),
    submitMessage: vi.fn(async () => ({ source: mount.state.source, inputId: "i", runId: "r", requestId: "m1", expectedRevision: 2, status: "completed" })),
    getMessageSubmission: vi.fn(async () => ({})), cancelMessage: vi.fn(async () => {}),
    updateModelContext: vi.fn(async () => ({ id: "c", source: mount.state.source, pluginId: "example", text: "selection", data: { selected: 1 } })),
    prepareTool: vi.fn(), cancelTool: vi.fn(async () => {}),
    refresh: vi.fn(async () => mount.state), close: vi.fn(async () => ({ app: mount.state.app })), release: vi.fn(async () => {}) }
  return { calls, controller: new PluginAppController(mount, calls as unknown as DesktopPluginAppsAPI, confirm) }
}
it("sends two independent confirmed messages, reads a lost acknowledgement, and never closes the page", async () => {
  const f = fixture(), signal = new AbortController().signal
  f.calls.submitMessage.mockRejectedValueOnce(new Error("lost response"))
  await f.controller.sendMessage("user", [{ type: "text", text: "hello" }], signal)
  await f.controller.sendMessage("user", [{ type: "text", text: "second" }], signal)
  expect(f.calls.submitMessage.mock.calls).toEqual([[{ mountId: "mount", requestId: "m1" }], [{ mountId: "mount", requestId: "m2" }]])
  expect(f.calls.getMessageSubmission).toHaveBeenCalledExactlyOnceWith({ mountId: "mount", requestId: "m1" })
  expect(f.calls.close).not.toHaveBeenCalled()
})
it("refuses hidden script actions and isolates visible context from another session", async () => {
  const f = fixture(), signal = new AbortController().signal
  f.controller.setVisible(false)
  await expect(f.controller.callTool("save", {}, signal)).rejects.toThrow("隐藏")
  await expect(f.controller.sendMessage("user", [], signal)).rejects.toThrow("隐藏")
  await expect(f.controller.updateModelContext([{ type: "text", text: "hidden" }])).rejects.toThrow("隐藏")
  expect(f.calls.prepareTool).not.toHaveBeenCalled(); expect(f.calls.prepareMessage).not.toHaveBeenCalled(); expect(f.calls.updateModelContext).not.toHaveBeenCalled()
  f.controller.setVisible(true)
  await f.controller.updateModelContext([{ type: "text", text: "selection" }])
  expect(pluginAppModelContexts.forSession("current")).toEqual([])
  expect(pluginAppModelContexts.forSession("original")).toHaveLength(1)
  expect(f.calls.submitMessage).not.toHaveBeenCalled()
})
it("cancels pending confirmation on hide and preserves existing composer selections", async () => {
  let entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  const f = fixture(async (_request, signal) => { entered(); return new Promise(resolve => signal.addEventListener("abort", () => resolve(false), { once: true })) })
  pluginAppModelContexts.put({ id: "keep", source: mount.state.source, pluginId: "example", text: "keep me", data: null })
  const pending = f.controller.sendMessage("user", [{ type: "text", text: "hello" }], new AbortController().signal)
  await enteredPromise; f.controller.setVisible(false)
  await expect(pending).rejects.toThrow("取消")
  expect(f.calls.submitMessage).not.toHaveBeenCalled()
  expect(pluginAppModelContexts.forSession("original")[0]?.text).toBe("keep me")
})
it("settles already sent messages after hiding without cancelling their durable input", async () => {
  const f = fixture()
  let resolve!: () => void
  f.calls.submitMessage.mockImplementationOnce(async () => { await new Promise<void>(done => { resolve = done }); return { source: mount.state.source, inputId: "i", runId: "r", requestId: "m1", expectedRevision: 2, status: "completed" } })
  const pending = f.controller.sendMessage("user", [{ type: "text", text: "hello" }], new AbortController().signal)
  while (!resolve) await new Promise(done => setTimeout(done, 0))
  f.controller.setVisible(false); resolve(); await pending
  expect(f.calls.cancelMessage).not.toHaveBeenCalled()
})
it("blocks messages without current model availability", async () => {
  const f = fixture()
  f.controller.update({ ...mount.state, availability: { ...mount.state.availability, canMessage: false } })
  await expect(f.controller.sendMessage("user", [], new AbortController().signal)).rejects.toThrow("不能发送")
  expect(f.calls.prepareMessage).not.toHaveBeenCalled()
})
