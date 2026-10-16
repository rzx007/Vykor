// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MessageChannel, type MessagePort } from "node:worker_threads"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PluginUiHostState } from "@shared/plugin-ui-types"
import { PluginUiFrame } from "./plugin-ui-frame"
import { PluginUiHostContext, type PluginUiDisplay, type PluginUiHost } from "./plugin-ui-context"
import { instance, mountId, snapshot } from "./plugin-ui-fixtures.test-support"

let root: Root
let container: HTMLDivElement
let display: PluginUiDisplay
let host: PluginUiHost
const ports: MessagePort[] = []

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("MessageChannel", MessageChannel)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  display = { key: "first-document", instance, surface: "tool-result" }
  const state: PluginUiHostState = {
    snapshot,
    plugin: { id: instance.pluginId, version: "1" },
    title: instance.title,
    availability: { code: "available", canRender: true, canInvoke: true },
    conversation: { draft: false, submit: false },
    actions: [],
  }
  host = {
    available: true,
    view: null,
    displays: [display],
    isCurrent: () => true,
    mount: () => ({
      result: Promise.resolve({ mountId, url: `vykor-plugin-ui://frame/${mountId}`, state }),
      release: async () => {},
    }),
    open: () => {},
    close: () => {},
    confirm: async () => {},
    requestConversation: async () => {
      throw new Error("not requested")
    },
    conversationStatus: null,
    queryConversation: async () => {
      throw new Error("not requested")
    },
  }
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { pluginUi: { getState: async () => state, onRevoked: () => () => {} } },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  ports.splice(0).forEach((port) => port.close())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

async function render() {
  await act(async () =>
    root.render(
      <PluginUiHostContext value={{ ...host }}>
        <PluginUiFrame display={display} />
      </PluginUiHostContext>
    )
  )
}

it("resets document-local height on reload without requiring the parent to replace the frame", async () => {
  await render()
  const frame = container.querySelector("iframe")!
  let port: MessagePort | undefined
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(
    (_message, _origin, transferred?: Transferable[]) => {
      port = (transferred as unknown as MessagePort[])[0]!
      ports.push(port)
    }
  )
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: { version: 2, type: "plugin-ui-ready" },
    })
  )
  await act(async () => {
    await new Promise<void>((resolve) => {
      port!.on("message", (message: string) => {
        if (JSON.parse(message).id === "resize") resolve()
      })
      port!.postMessage(
        JSON.stringify({
          version: 2,
          mountId,
          id: "resize",
          method: "resize",
          params: { height: 640 },
        })
      )
    })
  })
  expect(frame.style.height).toBe("640px")
  display = { ...display, key: "reloaded-document" }
  await render()
  const replacement = container.querySelector("iframe")!
  expect(replacement).not.toBe(frame)
  expect(replacement.style.height).toBe("320px")
})

it("keeps the same document and input when only host and display objects are refreshed", async () => {
  await render()
  const frame = container.querySelector("iframe")!
  const input = frame.contentDocument!.createElement("input")
  frame.contentDocument!.append(input)
  input.value = "unfinished input"
  display = { ...display, instance: { ...instance, revision: 2 } }
  await render()
  expect(container.querySelector("iframe")).toBe(frame)
  expect(input.value).toBe("unfinished input")
})
