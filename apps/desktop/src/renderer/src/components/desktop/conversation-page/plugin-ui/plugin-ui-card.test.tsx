// @vitest-environment jsdom
import { act } from "react"
import { MessageChannel } from "node:worker_threads"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { instance, snapshot, sourcePart } from "./plugin-ui-fixtures.test-support"
import { PluginUiProvider } from "./plugin-ui-provider"
import { PluginUiCard } from "./plugin-ui-card"
import { submitPluginUiAction } from "./plugin-ui-frame"
import { usePluginUiHost } from "./plugin-ui-provider"
const fixture = vi.hoisted(() => ({ view: null as any }))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: (selector) =>
    selector({ sessionView: fixture.view, activeSessionId: "session" }),
}))
let root: Root, container: HTMLDivElement, api: any
const ports: import("node:worker_threads").MessagePort[] = []
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  fixture.view = {
    cursor: 1,
    syncStatus: "connected",
    session: { id: "session", status: "idle", metadata: {} },
    parts: [sourcePart],
    runs: [],
  }
  api = {
    capabilities: vi.fn(async () => ({ available: true })),
    mount: vi.fn(async () => {
      throw new Error("offline")
    }),
    getState: vi.fn(async () => ({
      snapshot,
      plugin: { id: "example.ui", version: "1" },
      title: "检查结果",
      availability: { code: "available", canRender: true, canInvoke: true },
      surfaces: instance.surfaces,
      actions: [{ id: "apply", label: "应用", toolName: "Inspect", completion: "keep-open" }],
    })),
    dismiss: vi.fn(async () => ({ ...instance, status: "dismissed", revision: 2 })),
    onRevoked: vi.fn(() => () => {}),
    unmount: vi.fn(async () => {}),
  }
  Object.defineProperty(window, "desktop", { configurable: true, value: { pluginUi: api } })
})
afterEach(() => {
  act(() => root.unmount())
  ports.splice(0).forEach((port) => port.close())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT
})
async function render() {
  await act(async () =>
    root.render(
      <PluginUiProvider onOpenSidebar={() => {}}>
        <PluginUiCard instance={instance} call={sourcePart} />
      </PluginUiProvider>
    )
  )
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === label
  )
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
it("keeps a collapsed card lazy and retains original output when loading fails", async () => {
  await render()
  expect(container.textContent).toContain("原始结果，不应消失")
  expect(api.mount).not.toHaveBeenCalled()
  await click("打开交互")
  expect(api.mount).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain("原始结果，不应消失")
  expect(container.textContent).toContain("重新加载")
  expect(container.querySelector("iframe")).toBeNull()
})
it("does not read documents or expose an opening button without isolation/lifecycle support", async () => {
  api.capabilities.mockResolvedValue({ available: false })
  await render()
  expect(container.textContent).toContain("原始结果，不应消失")
  expect(container.textContent).not.toContain("打开交互")
  expect(api.mount).not.toHaveBeenCalled()
})
it("does not show a card-opening button for a sidebar-only component", async () => {
  await act(async () =>
    root.render(
      <PluginUiProvider onOpenSidebar={() => {}}>
        <PluginUiCard instance={{ ...instance, surfaces: ["session-sidebar"] }} call={sourcePart} />
      </PluginUiProvider>
    )
  )
  expect(container.textContent).not.toContain("打开交互")
  expect(container.textContent).toContain("在侧栏打开")
})
it("can dismiss without an iframe, but never submits before or after cancelled confirmation", async () => {
  await render()
  await click("取消交互")
  expect(document.body.textContent).toContain("example.ui")
  expect(document.body.textContent).toContain("取消此次交互")
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("返回"))
  expect(api.dismiss).not.toHaveBeenCalled()
  await click("返回")
  expect(api.dismiss).not.toHaveBeenCalled()
  await click("取消交互")
  await click("确认取消")
  expect(api.dismiss).toHaveBeenCalledTimes(1)
  expect(api.dismiss.mock.calls[0][0].input.expectedRevision).toBe(1)
  expect(api.mount).not.toHaveBeenCalled()
})
it("cancels a pending confirmation when the source part disappears", async () => {
  await render()
  await click("取消交互")
  fixture.view = { ...fixture.view, cursor: 2, parts: [] }
  await render()
  expect(document.body.textContent).not.toContain("确认取消")
  expect(api.dismiss).not.toHaveBeenCalled()
})
async function connectedFrame() {
  vi.stubGlobal("MessageChannel", MessageChannel)
  const mountId = "20000000-0000-4000-8000-000000000001"
  api.mount.mockResolvedValue({
    mountId,
    url: "vykor-plugin-ui://frame/" + mountId,
    state: await api.getState(),
  })
  await render()
  await click("打开交互")
  const frame = container.querySelector("iframe")!
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
  expect(frame.hasAttribute("srcdoc")).toBe(false)
  const packets: any[] = []
  let port!: import("node:worker_threads").MessagePort
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(
    (_message, _origin?: any, transferred?: any) => {
      port = transferred[0]
      ports.push(port)
      port.on("message", (data) => packets.push(JSON.parse(data)))
    }
  )
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: { version: 1, type: "plugin-ui-ready" },
    })
  )
  const send = async (id: string) => {
    await act(async () => {
      port.postMessage(
        JSON.stringify({
          version: 1,
          mountId,
          id,
          method: "requestAction",
          params: {
            actionId: "apply",
            expectedRevision: 1,
            args: { text: "<script>not html</script>" },
          },
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 15))
    })
  }
  return { packets, port, send }
}
it("runs open → request → host confirmation → one receipt → existing stream update", async () => {
  const persisted: any[] = []
  api.invokeAction = async ({ input }) => {
    persisted.push(structuredClone(input))
    return {
      requestId: input.requestId,
      instanceId: instance.instanceId,
      runId: "ui_once",
      revision: 2,
      status: "completed",
    }
  }
  const f = await connectedFrame()
  await f.send("cancel")
  expect(document.body.textContent).toContain("实际工具：Inspect")
  expect(document.body.textContent).toContain("<script>not html</script>")
  expect(document.querySelector("script")).toBeNull()
  expect(persisted).toEqual([])
  await click("返回")
  await vi.waitFor(() =>
    expect(
      f.packets.some(
        (packet) => packet.id === "cancel" && packet.error?.code === "plugin_ui_user_cancelled"
      )
    ).toBe(true)
  )
  expect(persisted).toEqual([])
  await f.send("accept")
  expect(persisted).toEqual([])
  await click("确认执行")
  await vi.waitFor(() =>
    expect(
      f.packets.some((packet) => packet.id === "accept" && packet.result?.runId === "ui_once")
    ).toBe(true)
  )
  expect(persisted).toHaveLength(1)
  expect(persisted[0]).toMatchObject({
    actionId: "apply",
    expectedRevision: 1,
    args: { text: "<script>not html</script>" },
  })
  api.getState.mockResolvedValue({
    ...(await api.getState()),
    snapshot: { ...snapshot, revision: 2, data: { count: 2 } },
  })
  fixture.view = { ...fixture.view, cursor: 2 }
  await render()
  await vi.waitFor(() =>
    expect(
      f.packets.some(
        (packet) =>
          packet.type === "snapshot" &&
          packet.snapshot?.revision === 2 &&
          packet.snapshot?.data.count === 2
      )
    ).toBe(true)
  )
  await click("关闭显示")
  expect(api.unmount).toHaveBeenCalled()
  expect(persisted).toHaveLength(1)
})
it("keeps the original revision while confirmation is open and rejects a later conflict", async () => {
  const submitted: any[] = []
  api.invokeAction = async (input) => {
    submitted.push(input)
    return {}
  }
  const f = await connectedFrame()
  await f.send("conflict")
  api.getState.mockResolvedValue({
    ...(await api.getState()),
    snapshot: { ...snapshot, revision: 2 },
  })
  fixture.view = { ...fixture.view, cursor: 2 }
  await render()
  await click("确认执行")
  await vi.waitFor(() =>
    expect(
      f.packets.some(
        (packet) => packet.id === "conflict" && packet.error?.code === "plugin_ui_revision_conflict"
      )
    ).toBe(true)
  )
  expect(submitted).toEqual([])
})
it("looks up the original request after a submission timeout, without another admission", async () => {
  vi.useFakeTimers()
  const input = {
    requestId: "30000000-0000-4000-8000-000000000001",
    actionId: "apply",
    expectedRevision: 1,
    args: {},
  }
  const admitted: any[] = [],
    lookedUp: any[] = []
  const receipt = {
    requestId: input.requestId,
    instanceId: instance.instanceId,
    revision: 2,
    runId: "uncertain_once",
    status: "running",
  }
  api.invokeAction = async (value) => {
    admitted.push(value)
    return await new Promise(() => {})
  }
  api.getAction = async (value) => {
    lookedUp.push(value)
    return receipt
  }
  const result = submitPluginUiAction(api, "20000000-0000-4000-8000-000000000001", input)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await result).toEqual(receipt)
  expect(admitted).toHaveLength(1)
  expect(lookedUp).toEqual([
    { mountId: "20000000-0000-4000-8000-000000000001", requestId: input.requestId },
  ])
  vi.useRealTimers()
})
it("limits the window to two displays and moves an instance to a single sidebar", async () => {
  const sources = [
    instance,
    { ...instance, instanceId: "10000000-0000-4000-8000-000000000002", sourcePartId: "part2" },
    { ...instance, instanceId: "10000000-0000-4000-8000-000000000003", sourcePartId: "part3" },
  ]
  fixture.view = {
    ...fixture.view,
    parts: sources.map((source) => ({
      ...sourcePart,
      id: source.sourcePartId,
      metadata: { pluginUi: source },
    })),
  }
  function Probe() {
    const host = usePluginUiHost()!
    return (
      <div>
        {sources.map((source, index) => (
          <button key={source.instanceId} onClick={() => host.open(source, "tool-result")}>
            card{index}
          </button>
        ))}
        {sources.map((source, index) => (
          <button
            key={"side" + source.instanceId}
            onClick={() => host.open(source, "session-sidebar")}
          >
            side{index}
          </button>
        ))}
        <output>
          {host.displays
            .map((display) => display.instance.instanceId + ":" + display.surface)
            .join(",")}
        </output>
      </div>
    )
  }
  await act(async () =>
    root.render(
      <PluginUiProvider onOpenSidebar={() => {}}>
        <Probe />
      </PluginUiProvider>
    )
  )
  await click("card0")
  await click("card1")
  await click("card2")
  expect(container.querySelector("output")?.textContent).not.toContain(sources[0].instanceId)
  expect(container.querySelector("output")?.textContent?.split(",")).toHaveLength(2)
  await click("side1")
  expect(container.querySelector("output")?.textContent).toContain(
    sources[1].instanceId + ":session-sidebar"
  )
  expect(container.querySelector("output")?.textContent).not.toContain(
    sources[1].instanceId + ":tool-result"
  )
  await click("side2")
  expect(container.querySelector("output")?.textContent?.match(/session-sidebar/g)).toHaveLength(1)
})
