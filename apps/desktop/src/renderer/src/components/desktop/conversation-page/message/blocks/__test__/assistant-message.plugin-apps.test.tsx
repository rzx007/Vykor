// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopSessionPart } from "@shared/session-types"
import { AssistantMessage } from "../assistant-message"
import { PluginAppPageManager } from "../../../../shell/plugin-apps/page-manager"
import { mount } from "../../../../shell/plugin-apps/__test__/fixtures.test-support"

const state = vi.hoisted(() => ({ manager: null as PluginAppPageManager | null }))
vi.mock("../../../../shell/plugin-apps/provider", () => ({
  usePluginApps: () => state.manager,
  usePluginAppPages: () => state.manager?.snapshot() ?? [],
}))
let root: Root, container: HTMLDivElement
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div"); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); state.manager = null
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})
function part(id: string, seq: number, sessionId = "original"): DesktopSessionPart {
  return { id, seq, sessionId, messageId: "reply", type: "tool", status: "completed",
    toolName: "mcp__excalidraw__read_scene", toolUseId: id, createdAt: seq, updatedAt: seq,
    input: { id: "diagram" }, output: { content: [{ type: "text", text: id }] },
    metadata: { pluginAppSource: { ...mount.state.app } } }
}
function fixture(surfaces = [{ id: "editor", title: "Excalidraw 画板", resourceUri: "ui://editor" }]) {
  const api = {
    catalog: async (_input: { sessionId: string }) => ({ backends: [{ pluginId: "example", backendId: "editor", surfaces }] }),
    openToolResult: vi.fn(async ({ sourcePartId }: { sourcePartId: string }) => ({
      mounted: mount, initial: { sourcePartId, arguments: {}, result: { content: [] } },
    })),
  }
  state.manager = new PluginAppPageManager(api as never, async () => true)
  return api
}
async function render(parts: DesktopSessionPart[]) {
  await act(async () => root.render(<AssistantMessage parts={parts} streaming={false}
    onOpenFile={() => {}} canOpenReview={false} onOpenReview={() => {}} onOpenTerminal={() => {}} />))
}
const entries = () => [...container.querySelectorAll("button")].filter(button => button.textContent?.startsWith("查看"))

it("shows one app entry for repeated reads and edits and opens the latest successful result", async () => {
  const api = fixture()
  const parts = Array.from({ length: 6 }, (_, i) => part(`result-${i}`, i))
  parts.push({ ...part("failed", 7), isError: true })
  await render(parts)
  expect(entries()).toHaveLength(1)
  expect(container.querySelectorAll("iframe")).toHaveLength(0)
  await act(async () => entries()[0]!.click())
  expect(api.openToolResult).toHaveBeenCalledWith({ sessionId: "original", sourcePartId: "result-5" })
  expect(state.manager!.snapshot()).toHaveLength(1)
})

it("keeps entries isolated by session and installed plugin identity", async () => {
  fixture()
  const newer = part("new-version", 3)
  newer.metadata = { pluginAppSource: { ...mount.state.app, pluginDigest: "new-digest" } }
  await render([part("one", 1), part("duplicate", 2), part("other-chat", 1, "other"), newer])
  expect(entries()).toHaveLength(3)
})

it("keeps distinct tool-result apps when multiple surfaces share the same resource", async () => {
  fixture([{ id: "first", title: "First", resourceUri: "ui://editor" }, { id: "second", title: "Second", resourceUri: "ui://editor" }])
  await render([part("one", 1), part("two", 2)])
  expect(entries()).toHaveLength(2)
})

it("keeps an app entry usable while its catalog lookup is still pending", async () => {
  const api = fixture()
  api.catalog = () => new Promise(() => {})
  await render([part("one", 1)])
  expect(entries()).toHaveLength(1)
  await act(async () => entries()[0]!.click())
  expect(api.openToolResult).toHaveBeenCalledWith({ sessionId: "original", sourcePartId: "one" })
  expect(state.manager!.panelRequest?.sessionId).toBe("original")
})

it("merges resolved entries without waiting for a different session's slow catalog", async () => {
  const api = fixture(), catalog = await api.catalog({ sessionId: "original" })
  api.catalog = ({ sessionId }) => sessionId === "other" ? new Promise(() => {}) : Promise.resolve(catalog)
  await render([part("one", 1), part("two", 2), part("other", 1, "other")])
  expect(entries()).toHaveLength(2)
  expect(entries().some(button => button.textContent?.includes("Excalidraw"))).toBe(true)
})

it("ignores a previous session's late catalog result after the reply is replaced", async () => {
  const api = fixture(), catalog = await api.catalog({ sessionId: "original" })
  let finish!: (value: typeof catalog) => void
  const pending = new Promise<typeof catalog>(resolve => { finish = resolve })
  api.catalog = ({ sessionId }) => sessionId === "original" ? pending : Promise.resolve(catalog)
  await render([part("old-one", 1), part("old-two", 2)])
  await render([part("current", 1, "other")])
  await act(async () => finish(catalog))
  expect(entries()).toHaveLength(1)
  await act(async () => entries()[0]!.click())
  expect(api.openToolResult).toHaveBeenCalledWith({ sessionId: "other", sourcePartId: "current" })
})
