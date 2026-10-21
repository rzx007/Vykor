// @vitest-environment jsdom
import { act, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { PluginAppFrame } from "../frame"
import { PluginAppController } from "../controller"
import type { ResidentAppPage } from "../page-manager"
import { PluginAppPageManager } from "../page-manager"
import { mount } from "./fixtures.test-support"
const calls = vi.hoisted(() => ({ connect: vi.fn(async () => {}), close: vi.fn(async () => {}), updateContext: vi.fn(), setDisplayMode: vi.fn() }))
vi.mock("../transport", () => ({ PluginAppTransport: class { connect = calls.connect; close = calls.close; updateContext = calls.updateContext; setDisplayMode = calls.setDisplayMode } }))
it("StrictMode and visibility changes retain the attached iframe and only connect once", async () => {
  const element = document.createElement("div"); document.body.append(element)
  const root = createRoot(element)
  const controller = new PluginAppController(mount, {} as never, async () => true)
  const page: ResidentAppPage = { id: "mount", title: "editor", controller }
  const manager = new PluginAppPageManager({ mount: async () => mount } as never, async () => true)
  const managed = await manager.mount(mount.state.source, "editor")
  await act(async () => root.render(<StrictMode><PluginAppFrame page={page} /></StrictMode>))
  const frame = element.querySelector("iframe")!
  const peer = frame.contentWindow
  managed.element = page.element; managed.onModes!(["inline", "fullscreen"])
  manager.place(managed.id, new DOMRect(10, 20, 300, 200))
  manager.place(managed.id, null)
  manager.place(managed.id, new DOMRect(20, 30, 400, 300))
  await act(async () => controller.update({ ...controller.state, online: false }))
  expect(element.querySelector("iframe")).toBe(frame)
  expect(frame.contentWindow).toBe(peer)
  expect(frame.isConnected).toBe(true)
  expect(calls.connect).toHaveBeenCalledTimes(1)
  expect(calls.close).not.toHaveBeenCalled()
  await act(async () => root.unmount())
  expect(calls.close).toHaveBeenCalledTimes(1)
  element.remove()
})
it("a durable-close conflict preserves the resident page and allows an explicit later retry", async () => {
  const api = { mount: vi.fn(async () => mount), close: vi.fn().mockRejectedValueOnce(new Error("revision conflict")).mockResolvedValueOnce({ app: { ...mount.state.app, status: "closed" } }),
    refresh: vi.fn(async () => ({ ...mount.state, app: { ...mount.state.app, controlRevision: 3 } })) }
  const manager = new PluginAppPageManager(api as never, async () => true)
  const page = await manager.mount(mount.state.source, "editor")
  const close = vi.fn(async () => {})
  page.transport = { close } as never
  await expect(manager.remove(page.id, true)).rejects.toThrow("revision conflict")
  expect(manager.snapshot()[0]).toBe(page)
  expect(close).not.toHaveBeenCalled()
  await manager.remove(page.id, true)
  expect(api.close.mock.calls.map(call => call[0].expectedRevision)).toEqual([2, 3])
  expect(manager.snapshot()).toEqual([])
  expect(close).toHaveBeenCalledTimes(1)
})
it("one reused page follows its newest visible anchor without older frames hiding it", async () => {
  const manager = new PluginAppPageManager({ mount: async () => mount } as never, async () => true)
  const page = await manager.mount(mount.state.source, "editor")
  page.element = document.createElement("div"); page.onModes!(["inline", "fullscreen"])
  const sidebar = Symbol(), inline = Symbol(), left = new DOMRect(10, 0, 100, 100), right = new DOMRect(200, 0, 100, 100)
  manager.place(page.id, left, sidebar); manager.place(page.id, right, inline)
  manager.place(page.id, left, sidebar)
  expect(page.element.style.left).toBe("200px")
  manager.place(page.id, null, sidebar)
  expect(page.element.style.visibility).toBe("visible")
  manager.place(page.id, left, sidebar); manager.releaseAnchor(page.id, inline)
  expect(page.element.style.left).toBe("10px")
  manager.releaseAnchor(page.id, sidebar)
  expect(page.element.style.visibility).toBe("hidden")
})
it("reuses one surface but forwards each distinct trusted Part once", async () => {
  const manager = new PluginAppPageManager({ openToolResult: async ({ sourcePartId }: { sourcePartId: string }) => ({ mounted: mount,
    initial: { sourcePartId, arguments: { sourcePartId }, result: { content: [] } } }) } as never, async () => true)
  const page = await manager.openToolResult("original", "part-a"), queueToolResult = vi.fn()
  page.transport = { queueToolResult } as never
  expect(await manager.openToolResult("original", "part-b")).toBe(page)
  await manager.openToolResult("original", "part-a"); await manager.openToolResult("original", "part-b")
  expect(manager.snapshot()).toHaveLength(1); expect(queueToolResult).toHaveBeenCalledTimes(1)
  expect([...page.results!.keys()]).toEqual(["part-a"])
  expect([...page.sourceParts!]).toEqual(["part-a", "part-b"])
})
