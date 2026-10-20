// @vitest-environment jsdom
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MessageChannel } from "node:worker_threads"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { PluginUiProvider } from "../plugin-ui-provider"
import { usePluginUiHost } from "../plugin-ui-context"
import { PluginUiFrame } from "../plugin-ui-frame"
import { instance, snapshot, sourcePart, mountId } from "./plugin-ui-fixtures.test-support"
const fixture = vi.hoisted(() => ({ view: null as any }))
vi.mock("@renderer/stores/desktop-session", () => ({ useDesktopSessionStore: Object.assign((select) => select({ sessionView: fixture.view, activeSessionId: "session" }), { subscribe: () => () => {} }) }))
let root: Root, container: HTMLDivElement, host: NonNullable<ReturnType<typeof usePluginUiHost>>, api: any
let mountReads: number, unmounts: string[], releaseUnmount: (() => void) | undefined
let panelOpens: number
const ports: import("node:worker_threads").MessagePort[] = []
function Harness({ visible = true }: { visible?: boolean }) {
  host = usePluginUiHost()!
  return <>{host.displays.map(display => <PluginUiFrame key={display.instance.instanceId} display={display} visible={visible} />)}</>
}
async function render(visible = true) {
  await act(async () => root.render(<StrictMode><PluginUiProvider onOpenSidebar={() => { panelOpens++ }}><Harness visible={visible} /></PluginUiProvider></StrictMode>))
}
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("MessageChannel", MessageChannel)
  container = document.createElement("div"); document.body.append(container); root = createRoot(container)
  fixture.view = { cursor: 1, syncStatus: "connected", session: { id: "session", status: "idle", metadata: {} }, parts: [sourcePart], runs: [] }
  const { appearance: _appearance, capabilities: _caps, ...business } = snapshot
  const state = { snapshot: business, plugin: { id: instance.pluginId, version: "1" }, title: instance.title,
    availability: { code: "available", canRender: true, canInvoke: true }, conversation: { draft: false, submit: false }, actions: [] }
  mountReads = 0; unmounts = []; releaseUnmount = undefined; panelOpens = 0
  api = { capabilities: async () => ({ available: true }), getState: async () => state, onRevoked: () => () => {},
    mount: async () => { mountReads++; return { mountId, url: "vykor-plugin-ui://frame/" + mountId, state } },
    unmount: async ({ mountId: id }) => { unmounts.push(id) } }
  Object.defineProperty(window, "desktop", { configurable: true, value: { pluginUi: api } })
})
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  ports.splice(0).forEach(port => port.close())
  document.documentElement.removeAttribute("style"); document.documentElement.removeAttribute("class"); delete document.documentElement.dataset.reducedMotion
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})
it("keeps the exact frame and its local input across hiding and showing", async () => {
  await render(); await act(async () => host.open(instance, "tool-result"))
  const frame = container.querySelector("iframe")!
  const doc = frame.contentDocument!, input = doc.createElement("input")
  doc.append(input); input.value = "unsaved input"
  await render(false)
  expect(container.querySelector("iframe")).toBe(frame); expect(frame.hidden).toBe(true); expect(frame.tabIndex).toBe(-1)
  await render(true)
  expect(container.querySelector("iframe")).toBe(frame); expect(input.value).toBe("unsaved input")
  expect(mountReads).toBe(1); expect(unmounts).toEqual([])
})
it("waits for the old document revocation before reloading a mounted frame", async () => {
  await render(); await act(async () => host.open(instance, "tool-result"))
  api.unmount = async ({ mountId: id }) => { unmounts.push(id); await new Promise<void>(resolve => { releaseUnmount = resolve }) }
  await act(async () => host.open(instance, "tool-result", undefined, true))
  expect(unmounts).toEqual([mountId]); expect(mountReads).toBe(1)
  await act(async () => releaseUnmount!())
  expect(mountReads).toBe(2); expect(container.querySelector("iframe")).not.toBeNull()
})
it("a retry clears an earlier loading error", async () => {
  const load = api.mount; api.mount = async () => { throw new Error("offline") }
  await render(); await act(async () => host.open(instance, "tool-result"))
  expect(container.textContent).toContain("重新加载")
  api.mount = load
  await act(async () => host.open(instance, "tool-result", undefined, true))
  expect(container.querySelector("iframe")).not.toBeNull(); expect(container.textContent).not.toContain("未能加载")
})
it("sends actual UI appearance changes without changing the business revision", async () => {
  const html = document.documentElement
  for (const key of ["background", "foreground", "muted", "muted-foreground", "primary", "primary-foreground", "accent", "border", "destructive"]) html.style.setProperty("--" + key, "#123456")
  html.style.setProperty("--font-sans", "ChosenUi"); html.style.setProperty("--ui-font-size", "18px")
  html.classList.add("dark"); html.dataset.reducedMotion = "true"
  await render(); await act(async () => host.open(instance, "tool-result"))
  const frame = container.querySelector("iframe")!, packets: any[] = []
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((_message, _origin?: any, transferred?: any) => {
    const port = transferred[0]; ports.push(port); port.on("message", data => packets.push(JSON.parse(data)))
  })
  window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { version: 2, type: "plugin-ui-ready" } }))
  await vi.waitFor(() => expect(packets.some(packet => packet.snapshot?.appearance.fontSizePx === 18)).toBe(true))
  expect(packets[0].snapshot).toMatchObject({ revision: 1, appearance: { theme: "dark", fontFamily: "ChosenUi", fontSizePx: 18, reducedMotion: true }, capabilities: { draft: false, submit: false } })
  await act(async () => { html.style.setProperty("--ui-font-size", "20px"); html.dataset.reducedMotion = "false"; html.classList.remove("dark") })
  await vi.waitFor(() => expect(packets.some(packet => packet.snapshot?.appearance.fontSizePx === 20 && packet.snapshot.appearance.reducedMotion === false && packet.snapshot.appearance.theme === "light" && packet.snapshot.revision === 1)).toBe(true))
  expect(mountReads).toBe(1)
})
it("revokes a late mount once after the display has closed", async () => {
  const load = api.mount; let finish!: (result: any) => void
  api.mount = async () => await new Promise(resolve => { finish = resolve })
  await render(); await act(async () => host.open(instance, "tool-result"))
  await act(async () => host.close(instance.instanceId))
  await act(async () => finish(await load()))
  expect(container.querySelector("iframe")).toBeNull(); expect(unmounts).toEqual([mountId])
})
it("does not let an old delayed response revoke the document reopened for the same instance", async () => {
  const load = api.mount
  let deliverFirst!: () => void, liveDocument = false
  const events: string[] = []
  api.mount = async () => {
    const result = await load()
    liveDocument = true; events.push("registered")
    if (mountReads === 1) await new Promise<void>(resolve => { deliverFirst = resolve })
    return result
  }
  api.unmount = async ({ mountId: id }) => { unmounts.push(id); events.push("revoked"); liveDocument = false }
  await render(); await act(async () => host.open(instance, "tool-result"))
  expect(liveDocument).toBe(true); expect(container.querySelector("iframe")).toBeNull()
  await act(async () => host.close(instance.instanceId))
  await act(async () => host.open(instance, "tool-result"))
  await act(async () => deliverFirst())
  expect(container.querySelector("iframe")).not.toBeNull()
  expect(liveDocument).toBe(true)
  expect(events).toEqual(["registered", "revoked", "registered"])
  expect(mountReads).toBe(2); expect(unmounts).toEqual([mountId])
})
it("admits only the first panel in one event and keeps its key on repeated open", async () => {
  const first = { ...instance, surface: "session-sidebar" as const }
  const second = { ...first, instanceId: "10000000-0000-4000-8000-000000000002", sourcePartId: "part2" }
  fixture.view.parts = [first, second].map(source => ({ ...sourcePart, id: source.sourcePartId, metadata: { pluginUi: source } }))
  await render(); expect(panelOpens).toBe(0)
  await act(async () => { host.open(first, "session-sidebar"); host.open(second, "session-sidebar") })
  expect(host.displays).toHaveLength(1); expect(host.displays[0].instance.instanceId).toBe(first.instanceId)
  const key = host.displays[0].key
  expect(panelOpens).toBe(1); expect(mountReads).toBe(1)
  await act(async () => host.open(first, "session-sidebar"))
  expect(host.displays[0].key).toBe(key); expect(mountReads).toBe(1); expect(unmounts).toEqual([])
})
