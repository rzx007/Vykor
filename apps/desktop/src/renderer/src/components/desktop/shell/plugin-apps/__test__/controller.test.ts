import { expect, it, vi } from "vitest"
import { PluginAppController } from "../controller"
import type { DesktopPluginAppsAPI } from "@shared/plugin-app-types"
import { mount } from "./fixtures.test-support"

const prepared = { requestId: "fixed", toolName: "save", expectedRevision: 2, args: { value: "draft" } }
const receipt = { source: mount.state.source, requestId: "fixed", runId: "run", expectedRevision: 2, acceptedRevision: 3, status: "completed" as const, executionState: "completed" as const }
function api() { return { prepareTool: vi.fn(async () => prepared), invokeTool: vi.fn(async () => ({ receipt, result: { content: [], _meta: { private: true } } })),
  getAction: vi.fn(), cancelTool: vi.fn(async () => {}), refresh: vi.fn(async () => mount.state), close: vi.fn(async () => ({ app: mount.state.app })), release: vi.fn(async () => {}) } }
it("returns complete authorized MCP results through the originating request and confirms the fixed Main request", async () => {
  const calls = api(), confirm = vi.fn(async (_request: import("@shared/plugin-app-types").PluginAppConfirmation) => true)
  const controller = new PluginAppController(mount, calls as unknown as DesktopPluginAppsAPI, confirm)
  const result = await controller.callTool("save", { value: "draft" }, new AbortController().signal)
  expect(confirm.mock.calls[0]![0]).toEqual(prepared)
  expect(calls.invokeTool).toHaveBeenCalledExactlyOnceWith({ mountId: "mount", requestId: "fixed" })
  expect(result._meta).toEqual({ private: true })
  expect(calls.getAction).not.toHaveBeenCalled()
})
it("never retries invoke after a lost response and reports data errors separately from execution", async () => {
  const calls = api(); calls.invokeTool.mockRejectedValueOnce(new Error("offline"))
  const controller = new PluginAppController(mount, calls as unknown as DesktopPluginAppsAPI, async () => true)
  await expect(controller.callTool("save", {}, new AbortController().signal)).rejects.toThrow("offline")
  expect(calls.invokeTool).toHaveBeenCalledTimes(1)
  const errorApi = { ...api(), invokeTool: vi.fn(async () => ({ receipt, dataError: "plugin_app_result_unavailable" })) }
  const second = new PluginAppController(mount, errorApi as unknown as DesktopPluginAppsAPI, async () => true)
  await expect(second.callTool("save", {}, new AbortController().signal)).rejects.toThrow("completed")
})
it("waits for an original receipt instead of treating an in-flight unknown as a completed operation", async () => {
  vi.useFakeTimers()
  try {
    const calls = { ...api(), invokeTool: vi.fn(async () => ({ receipt: { ...receipt, status: "running", executionState: "unknown" } })),
      getAction: vi.fn(async () => ({ receipt, result: { content: [], structuredContent: { done: true } } })) }
    const controller = new PluginAppController(mount, calls as unknown as DesktopPluginAppsAPI, async () => true)
    const pending = controller.callTool("save", {}, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(400)
    expect((await pending).structuredContent).toEqual({ done: true })
    expect(calls.invokeTool).toHaveBeenCalledTimes(1)
    expect(calls.getAction).toHaveBeenCalledExactlyOnceWith({ mountId: "mount", requestId: "fixed" })
  } finally { vi.useRealTimers() }
})
it("official signal cancels the prepared original request before confirmation can submit", async () => {
  const calls = api(), signal = new AbortController()
  const controller = new PluginAppController(mount, calls as unknown as DesktopPluginAppsAPI, async (_request, abort) => new Promise(resolve => abort.addEventListener("abort", () => resolve(false))))
  const pending = controller.callTool("save", {}, signal.signal)
  await Promise.resolve(); signal.abort()
  await expect(pending).rejects.toThrow("取消")
  expect(calls.cancelTool).toHaveBeenCalledWith({ mountId: "mount", requestId: "fixed" })
  expect(calls.invokeTool).not.toHaveBeenCalled()
})
