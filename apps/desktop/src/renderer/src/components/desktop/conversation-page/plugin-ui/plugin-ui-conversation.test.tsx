// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MessageChannel, type MessagePort } from "node:worker_threads"
import { webcrypto } from "node:crypto"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { composerDocument } from "@renderer/stores/desktop-session/composer-document"
import { addCandidates, selectDraftAttachments, selectDraftDocument, sessionComposerScope } from "@renderer/stores/desktop-session/composer-draft-state"
import { PluginUiProvider, usePluginUiHost } from "./plugin-ui-provider"
import { PluginUiFrame } from "./plugin-ui-frame"
import { instance, snapshot, sourcePart, mountId } from "./plugin-ui-fixtures.test-support"
let root: Root, container: HTMLDivElement, host: NonNullable<ReturnType<typeof usePluginUiHost>>
let api: any, port: MessagePort, packets: any[], prepares: number, posts: any[], queries: string[]
const scope = sessionComposerScope("session")
function Harness({ visible }: { visible: boolean }) {
  host = usePluginUiHost()!
  return <>{host.displays.map(display => <PluginUiFrame key={display.key} display={display} visible={visible} />)}</>
}
async function render(visible = true) {
  await act(async () => root.render(<PluginUiProvider onOpenSidebar={() => {}}><Harness visible={visible} /></PluginUiProvider>))
}
async function send(mode = "draft", id = "1") {
  await render(); await act(async () => host.open(instance, "tool-result"))
  const frame = container.querySelector("iframe")!
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((_message, _origin?: any, transferred?: any) => {
    port = transferred[0]; port.on("message", data => packets.push(JSON.parse(data)))
  })
  window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { version: 2, type: "plugin-ui-ready" } }))
  await act(async () => {
    port.postMessage(JSON.stringify({ version: 2, mountId, id, method: "requestConversation", params: { mode, expectedRevision: 1, text: "分析选择", data: { selected: true } } }))
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}
async function decide(label = "确认加入输入框") {
  const button = [...document.querySelectorAll("button")].find(item => item.textContent === label)!
  expect(button).toBeDefined()
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
}
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("MessageChannel", MessageChannel)
  vi.stubGlobal("crypto", webcrypto)
  container = document.createElement("div"); document.body.append(container); root = createRoot(container)
  useDesktopSessionStore.setState({ activeSessionId: "session", sessionView: { cursor: 1, syncStatus: "connected", session: { id: "session", status: "idle", metadata: {} }, parts: [sourcePart], runs: [] }, composerDraftsByScope: {} } as never)
  const { appearance: _a, capabilities: _c, ...business } = snapshot
  const state = { snapshot: business, plugin: { id: instance.pluginId, version: "1" }, title: instance.title, availability: { code: "available", canRender: true, canInvoke: true }, conversation: { draft: true, submit: true }, actions: [] }
  packets = []; prepares = 0; posts = []; queries = []
  api = { capabilities: async () => ({ available: true }), mount: async () => ({ mountId, url: "vykor-plugin-ui://frame/" + mountId, state }),
    unmount: async () => {}, getState: async () => state, onRevoked: () => () => {},
    prepareConversation: async ({ input }) => { prepares++; return { mode: input.mode, instanceId: instance.instanceId, revision: 1, promptText: "最终完整提示\n包含所选数据" } },
    submitConversation: async (value) => { posts.push(value); return { kind: "conversation", mode: "submit", instanceId: instance.instanceId, requestId: value.requestId, revision: 2, inputId: "input", runId: "run", status: "pending" } },
    getConversationSubmission: async ({ requestId }) => { queries.push(requestId); throw new Error("plugin_ui_not_found") } }
  Object.defineProperty(window, "desktop", { configurable: true, value: { pluginUi: api } })
})
afterEach(() => { act(() => root.unmount()); container.remove(); port?.close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT") })
it("previews the final prompt and appends to the latest real composer document without losing attachments", async () => {
  await send()
  expect(document.body.textContent).toContain("最终完整提示\n包含所选数据")
  const draft = composerDocument([{ type: "text", text: "确认期间新输入 " }, { type: "skill", name: "check", path: "D:/check", displayName: "check" }])
  useDesktopSessionStore.getState().setComposerDraftDocument(scope, draft)
  useDesktopSessionStore.setState(addCandidates(useDesktopSessionStore.getState(), scope, [{ draftId: "attachment", sourceToken: "token", displayName: "file.txt", declaredMediaType: "text/plain", sizeBytes: 1 }]))
  await decide()
  expect(selectDraftDocument(useDesktopSessionStore.getState(), scope).items).toEqual([...draft.items, { type: "text", text: "\n\n最终完整提示\n包含所选数据" }])
  expect(selectDraftAttachments(useDesktopSessionStore.getState(), scope)).toHaveLength(1)
  expect(prepares).toBe(2); expect(posts).toHaveLength(0)
})
it("keeps the composer when submitting only confirmed plugin text and validates the captured successor revision", async () => {
  useDesktopSessionStore.getState().setComposerDraftDocument(scope, composerDocument([{ type: "text", text: "不发送的草稿" }]))
  await send("submit"); await decide("确认交给助手")
  expect(posts).toHaveLength(1); expect(posts[0].input).toEqual({ expectedRevision: 1, text: "分析选择", data: { selected: true } })
  expect(selectDraftDocument(useDesktopSessionStore.getState(), scope).items).toEqual([{ type: "text", text: "不发送的草稿" }])
  expect(host.conversationStatus?.message).toContain("已交给助手")
})
it("does not append after hiding during confirmation", async () => {
  await send(); await render(false)
  expect(selectDraftDocument(useDesktopSessionStore.getState(), scope).items).toEqual([])
  expect(prepares).toBe(1); expect(document.body.textContent).not.toContain("确认加入输入框")
})
it("does not append when the final prepare changes the text", async () => {
  await send()
  api.prepareConversation = async () => ({ mode: "draft", instanceId: instance.instanceId, revision: 1, promptText: "Changed" })
  await decide()
  expect(selectDraftDocument(useDesktopSessionStore.getState(), scope).items).toEqual([])
  expect(packets.some(packet => packet.error?.code === "plugin_ui_snapshot_changed")).toBe(true)
})
it("does not display a late response in a different source conversation", async () => {
  let finish!: (value: any) => void
  const submit = api.submitConversation
  api.submitConversation = async value => { const receipt = await submit(value); return await new Promise(resolve => { finish = () => resolve(receipt) }) }
  await send("submit"); await decide("确认交给助手")
  const original = useDesktopSessionStore.getState().sessionView
  await act(async () => useDesktopSessionStore.setState({ activeSessionId: "other", sessionView: null }))
  await act(async () => useDesktopSessionStore.setState({ activeSessionId: "session", sessionView: original }))
  await act(async () => finish(undefined))
  expect(host.conversationStatus).toBeNull()
})
it("queries the original request after an unknown response and never automatically POSTs again", async () => {
  api.submitConversation = async (value) => { posts.push(value); throw new Error("offline") }
  await send("submit"); await decide("确认交给助手")
  await act(async () => vi.waitFor(() => expect(posts).toHaveLength(1), { timeout: 5000 }))
  await act(async () => vi.waitFor(() => {
    expect(queries).toEqual([posts[0].requestId])
    expect(host.conversationStatus?.message).toContain("尚未确认")
  }, { timeout: 5000 }))
  expect(posts).toHaveLength(1); expect(queries).toEqual([posts[0].requestId])
  expect(host.conversationStatus?.message).toContain("尚未确认")
})
it("uses a matching source admission to resolve an unknown response without another POST", async () => {
  api.submitConversation = async value => { posts.push(value); throw new Error("offline") }
  await send("submit"); await decide("确认交给助手")
  const requestFingerprint = createHash("sha256").update('{"data":{"selected":true},"expectedRevision":1,"instanceId":"10000000-0000-4000-8000-000000000001","sessionId":"session","text":"分析选择"}').digest("hex")
  const current = useDesktopSessionStore.getState().sessionView!
  await act(async () => useDesktopSessionStore.setState({ sessionView: { ...current, cursor: 2, parts: [{ ...sourcePart,
    metadata: { pluginUi: { ...instance, status: "resolved", revision: 2 }, pluginUiSubmission: { schemaVersion: 2,
      requestId: posts[0].requestId, requestFingerprint, expectedRevision: 1, inputId: "input", runId: "run",
      pluginDigest: instance.pluginDigest, componentDigest: instance.componentDigest, acceptedAt: 1 } } }] } } as never))
  expect(host.conversationStatus?.message).toContain("已交给助手")
  expect(host.conversationStatus?.requestId).toBeUndefined()
  expect(posts).toHaveLength(1)
})
it("keeps the new request ID when an old scope error arrives after same-content confirmation", async () => {
  let rejectOld!: (error: Error) => void
  api.submitConversation = async value => {
    posts.push(value)
    if (posts.length === 1) return await new Promise((_resolve, reject) => { rejectOld = reject })
    throw new Error("offline")
  }
  await send("submit"); await decide("确认交给助手")
  const original = useDesktopSessionStore.getState().sessionView, oldPort = port
  await act(async () => useDesktopSessionStore.setState({ activeSessionId: "other", sessionView: null }))
  await act(async () => useDesktopSessionStore.setState({ activeSessionId: "session", sessionView: original }))
  await send("submit", "2"); await decide("确认交给助手")
  await act(async () => vi.waitFor(() => expect(posts).toHaveLength(2), { timeout: 5000 }))
  expect(posts).toHaveLength(2)
  expect(posts[1].requestId).not.toBe(posts[0].requestId)
  await act(async () => rejectOld(new Error("plugin_ui_mount_closed")))
  oldPort.close()
  await send("submit", "3"); await decide("确认交给助手")
  await act(async () => vi.waitFor(() => expect(posts).toHaveLength(3), { timeout: 5000 }))
  await act(async () => vi.waitFor(() => {
    expect(queries).toEqual([posts[1].requestId, posts[1].requestId])
    expect(host.conversationStatus?.message).toContain("尚未确认")
  }, { timeout: 5000 }))
  expect(posts).toHaveLength(3)
  expect(posts[2].requestId).toBe(posts[1].requestId)
  expect(queries).toEqual([posts[1].requestId, posts[1].requestId])
})
