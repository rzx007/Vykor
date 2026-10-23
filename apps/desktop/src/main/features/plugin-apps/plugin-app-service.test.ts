import { EventEmitter } from "node:events"
import { expect, it, vi } from "vitest"
import { VykorApiError, VykorClient, type PluginAppResponse } from "@rzx/client"
import { DesktopPluginAppService } from "./plugin-app-service"
import { PluginAppDocumentStore } from "./document-store"
const source = { sessionId: "session", appId: "app" }
const initial: PluginAppResponse = { source, app: { id: "app", sessionId: "session", pluginId: "example.test", pluginVersion: "1", pluginDigest: "a".repeat(64),
  definitionDigest: "b".repeat(64), backendId: "native", backendKind: "native-tools", resourceUri: "ui://test/panel", origin: { kind: "surface", surfaceId: "editor" },
  logicalKey: "editor", status: "open", controlRevision: 0, createdAt: 1, updatedAt: 1 }, lease: { token: "secret", backendGeneration: "g" },
  availability: { canInvokeTools: true, canReadResource: true, canMessage: true }, tools: [{ name: "save", description: "save", inputSchema: { type: "object" } }] }
function fixture() {
  let state = structuredClone(initial), active = "session"
  const requests: unknown[] = [], close = vi.fn()
  const client = new VykorClient({ baseUrl: "http://localhost", fetch: async (url, options) => {
    const path = new URL(String(url)).pathname
    let body: unknown = state
    if (path === "/capabilities") body = { serverVersion: "test", protocol: { version: 5 }, features: { pluginApps: 1 } }
    else if (path.endsWith("/resources/read")) body = { contents: [{ uri: state.app.resourceUri, mimeType: "text/html;profile=mcp-app", text: "<input>" }] }
    else if (path.endsWith("/actions")) {
      const request = JSON.parse(String(options?.body)); requests.push(request)
      body = { receipt: { source, requestId: request.requestId, expectedRevision: request.expectedRevision, acceptedRevision: request.expectedRevision + 1,
        runId: "run", status: "completed", executionState: "completed" }, result: { content: [], _meta: { private: true } } }
    } else if (path.endsWith("/close")) { close(); body = { app: { ...state.app, status: "closed" } } }
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
  } })
  let currentClient = client
  const token = {}, documents = new PluginAppDocumentStore()
  const messageReady = vi.fn(async () => true)
  const service = new DesktopPluginAppService({ messageReady, documents, getClient: async () => currentClient, getOwnerSessionToken: (_id, session) => session === active ? token : undefined })
  const owner = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false, getURL: () => "file:///trusted.html" })
  service.registerOwner(owner as never, "file:///trusted.html")
  const mount = async (ownerId = 42) => {
    const mounted = await service.mount(ownerId, source)
    documents.authorizeRequest({ ownerId, url: mounted.url, resourceType: "subFrame", method: "GET", frameTreeNodeId: ownerId + 1, parentFrameTreeNodeId: 1, mainFrameTreeNodeId: 1 })
    documents.respond(new Request(mounted.url)); return mounted
  }
  return { service, owner, mount, requests, messageReady, close, client, reconnect: () => { currentClient = Object.create(client) as VykorClient }, state: () => state, setState: (next: PluginAppResponse) => { state = next }, switchSession: () => { active = "other" } }
}
it("returns only the refreshed host tool policy and admits its declared argument budget", async () => {
  const f = fixture(), { mountId } = await f.mount()
  const policy = { confirmation: "granted" as const, maxArgumentsBytes: 128 * 1024, authorization: "plugin-data-write" as const }
  f.setState({ ...f.state(), tools: [{ ...initial.tools![0]!, policy }] })
  const args = { scene: "x".repeat(70 * 1024) }
  const prepared = await f.service.prepareTool(42, { mountId, name: "save", arguments: args, policy: { confirmation: "required" } })
  expect(prepared).toMatchObject({ policy, args })
  args.scene = "changed"; prepared.args.scene = "changed again"
  await f.service.invokeTool(42, { mountId, requestId: prepared.requestId })
  expect(f.requests[0]).toMatchObject({ args: { scene: "x".repeat(70 * 1024) }, expectedRevision: 0 })
})
it("keeps default tools at 64 KiB and uses a smaller refreshed tool budget", async () => {
  const f = fixture(), { mountId } = await f.mount()
  await expect(f.service.prepareTool(42, { mountId, name: "save", arguments: { scene: "x".repeat(64 * 1024) },
    policy: { confirmation: "granted", maxArgumentsBytes: 128 * 1024 } })).rejects.toThrow()
  f.setState({ ...f.state(), tools: [{ ...initial.tools![0]!, policy: { confirmation: "required", maxArgumentsBytes: 1024 } }] })
  await expect(f.service.prepareTool(42, { mountId, name: "save", arguments: { scene: "x".repeat(1024) } })).rejects.toThrow()
  const prepared = await f.service.prepareTool(42, { mountId, name: "save", arguments: { scene: "small" } })
  expect(prepared).toMatchObject({ policy: { confirmation: "required", maxArgumentsBytes: 1024 } })
})
it("keeps the mounted app online only for an identity-verified unaccepted busy tool", async () => {
  const f = fixture(), { mountId } = await f.mount()
  const first = await f.service.prepareTool(42, { mountId, name: "save", arguments: {} })
  const invoke = vi.spyOn(f.client.pluginApps, "invoke").mockImplementation(async request => {
    throw new VykorApiError("not accepted", 409, { code: "plugin_app_not_accepted", kind: "tool", source: request.source,
      requestId: request.requestId, expectedRevision: request.expectedRevision, reason: "busy" })
  })
  await expect(f.service.invokeTool(42, { mountId, requestId: first.requestId })).rejects.toThrow("plugin_app_busy")
  expect(f.service.getBinding(42, mountId).online).toBe(true)
  await expect(f.service.invokeTool(42, { mountId, requestId: first.requestId })).rejects.toThrow("request_unavailable")
  expect((await f.service.prepareTool(42, { mountId, name: "save", arguments: {} })).requestId).not.toBe(first.requestId)
  expect(invoke).toHaveBeenCalledTimes(1)
})
it("does not trust a busy rejection for another request or release uncertain admission", async () => {
  const f = fixture(), { mountId } = await f.mount()
  const prepared = await f.service.prepareTool(42, { mountId, name: "save", arguments: {} })
  vi.spyOn(f.client.pluginApps, "invoke").mockRejectedValue(new VykorApiError("unverified", 409, { code: "plugin_app_not_accepted", kind: "tool", source,
    requestId: "another", expectedRevision: 0, reason: "busy" }))
  vi.spyOn(f.client.pluginApps, "getAction").mockRejectedValue(new Error("unknown"))
  await expect(f.service.invokeTool(42, { mountId, requestId: prepared.requestId })).rejects.toThrow("unverified")
  expect(f.service.getBinding(42, mountId).online).toBe(false)
  await expect(f.service.prepareTool(42, { mountId, name: "save", arguments: {} })).rejects.toThrow("action_pending")
})
it.each(["tool", "message"] as const)("releases only an exact trusted unaccepted %s request for a fresh explicit click", async kind => {
  const f = fixture(), { mountId } = await f.mount()
  const prepare = () => kind === "tool" ? f.service.prepareTool(42, { mountId, name: "save", arguments: {} })
    : f.service.prepareMessage(42, { mountId, role: "user", content: [{ type: "text", text: "hello" }] })
  const first = await prepare()
  const reject = (request: { source: typeof source; requestId: string; expectedRevision: number }) => Promise.reject(new VykorApiError("not accepted", 409, {
    code: "plugin_app_not_accepted", kind, source: request.source, requestId: request.requestId, expectedRevision: request.expectedRevision,
  }))
  const send = kind === "tool" ? vi.spyOn(f.client.pluginApps, "invoke").mockImplementation(reject)
    : vi.spyOn(f.client.pluginApps, "submitConversation").mockImplementation(reject)
  const submit = () => kind === "tool" ? f.service.invokeTool(42, { mountId, requestId: first.requestId })
    : f.service.submitMessage(42, { mountId, requestId: first.requestId })
  await expect(submit()).rejects.toThrow("not accepted")
  await expect(submit()).rejects.toThrow("request_unavailable")
  const next = await prepare()
  expect(next.requestId).not.toBe(first.requestId)
  expect(send).toHaveBeenCalledTimes(1)
})
it.each(["tool", "message"] as const)("ordinary 409/404 and mismatched proofs never release uncertain %s admission", async kind => {
  const f = fixture(), { mountId } = await f.mount()
  const prepare = () => kind === "tool" ? f.service.prepareTool(42, { mountId, name: "save", arguments: {} })
    : f.service.prepareMessage(42, { mountId, role: "user", content: [{ type: "text", text: "hello" }] })
  const first = await prepare()
  const error = new VykorApiError("uncertain", 409, { code: "plugin_app_not_accepted", kind, source, requestId: "other", expectedRevision: 0 })
  if (kind === "tool") {
    vi.spyOn(f.client.pluginApps, "invoke").mockRejectedValue(error)
    vi.spyOn(f.client.pluginApps, "getAction").mockRejectedValue(new VykorApiError("missing", 404, {}))
    await expect(f.service.invokeTool(42, { mountId, requestId: first.requestId })).rejects.toThrow("uncertain")
  } else {
    vi.spyOn(f.client.pluginApps, "submitConversation").mockRejectedValue(error)
    vi.spyOn(f.client.pluginApps, "getConversationSubmission").mockRejectedValue(new VykorApiError("missing", 404, {}))
    await expect(f.service.submitMessage(42, { mountId, requestId: first.requestId })).rejects.toThrow("uncertain")
  }
  await expect(prepare()).rejects.toThrow(kind === "tool" ? "action_pending" : "message_pending")
})
it("recovers a lost message acknowledgement only by its original receipt, with one submit", async () => {
  const f = fixture(), { mountId } = await f.mount()
  const input = { mountId, role: "user", content: [{ type: "text", text: "hello" }] }
  const first = await f.service.prepareMessage(42, input)
  const send = vi.spyOn(f.client.pluginApps, "submitConversation").mockRejectedValue(new Error("lost response"))
  const read = vi.spyOn(f.client.pluginApps, "getConversationSubmission").mockRejectedValue(new VykorApiError("missing", 404, {}))
  await expect(f.service.submitMessage(42, { mountId, requestId: first.requestId })).rejects.toThrow("lost response")
  await expect(f.service.prepareMessage(42, input)).rejects.toThrow("message_pending")
  read.mockResolvedValue({ source, requestId: first.requestId, inputId: "input", runId: "run", expectedRevision: 0, status: "completed" })
  await f.service.refresh(42, { mountId })
  expect((await f.service.prepareMessage(42, input)).requestId).not.toBe(first.requestId)
  expect(send).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenLastCalledWith(source, first.requestId)
})
it("freezes an ordinary user message before confirmation, retries its exact request, and keeps the app open", async () => {
  const f = fixture(), mounted = await f.mount(), mountId = mounted.mountId
  const submit = vi.spyOn(f.client.pluginApps, "submitConversation").mockImplementation(async request => ({ source, requestId: request.requestId,
    inputId: `input-${request.requestId}`, runId: `run-${request.requestId}`, expectedRevision: request.expectedRevision, status: "completed" }))
  const content = [{ type: "text", text: "first" }]
  const first = await f.service.prepareMessage(42, { mountId, role: "user", content })
  content[0]!.text = "forged"; f.switchSession()
  await f.service.submitMessage(42, { mountId, requestId: first.requestId })
  await f.service.submitMessage(42, { mountId, requestId: first.requestId })
  expect(submit.mock.calls[0]![0]).toMatchObject({ source, expectedRevision: 0, text: "first", data: null })
  expect(submit.mock.calls[0]![0]).toEqual(submit.mock.calls[1]![0])
  const second = await f.service.prepareMessage(42, { mountId, role: "user", content: [{ type: "text", text: "second" }] })
  expect(second.requestId).not.toBe(first.requestId)
  await f.service.submitMessage(42, { mountId, requestId: second.requestId })
  expect(f.state().app.status).toBe("open"); expect(f.close).not.toHaveBeenCalled()
})
it("rejects unsupported roles, content, missing model, closing and revoked message sources", async () => {
  const f = fixture(), { mountId } = await f.mount()
  const send = { mountId, role: "user", content: [{ type: "text", text: "hello" }] }
  await expect(f.service.prepareMessage(42, { ...send, role: "assistant" })).rejects.toThrow("unsupported_role")
  await expect(f.service.prepareMessage(42, { ...send, content: [{ type: "image", data: "image" }] })).rejects.toThrow("unsupported_content")
  f.messageReady.mockResolvedValue(false)
  await expect(f.service.prepareMessage(42, send)).rejects.toThrow("message_unavailable")
  f.messageReady.mockResolvedValue(true)
  const message = await f.service.prepareMessage(42, send)
  f.setState({ ...f.state(), lease: undefined, availability: { canReadResource: true, canInvokeTools: false, canMessage: false } })
  await expect(f.service.submitMessage(42, { mountId, requestId: message.requestId })).rejects.toThrow("message_unavailable")
})
it("creates context without sending, isolates its session, and rejects expired source references", async () => {
  const f = fixture(), { mountId } = await f.mount()
  const submit = vi.spyOn(f.client.pluginApps, "submitConversation")
  const entry = await f.service.updateModelContext(42, { mountId, content: [{ type: "text", text: "selection" }], structuredContent: { selected: 1 } })
  expect(submit).not.toHaveBeenCalled()
  expect(entry).not.toHaveProperty("lease")
  expect(await f.service.composerContext(42, "session", [entry.id])).toMatchObject([{ source, text: "selection", data: { selected: 1 }, expectedRevision: 0 }])
  await expect(f.service.composerContext(42, "other", [entry.id])).rejects.toThrow("context_expired")
  f.setState({ ...f.state(), availability: { canReadResource: true, canInvokeTools: false, canMessage: false, reason: "action-unconfirmed" } })
  await f.service.refresh(42, { mountId })
  await expect(f.service.composerContext(42, "session", [entry.id])).rejects.toThrow("message_unavailable")
})
it("captures local context before admission and preserves its document snapshot across host refresh", async () => {
  const f = fixture(), { mountId } = await f.mount()
  const data = { documentId: "diagram-a", revision: 3, elementIds: ["shape-a"] }
  const entry = await f.service.updateModelContext(42, { mountId, content: [{ type: "text", text: "selection A" }], structuredContent: data })
  f.setState({ ...f.state(), app: { ...f.state().app, controlRevision: 6 } })
  const [context] = await f.service.composerContext(42, "session", [entry.id])
  expect(context).toMatchObject({ source, expectedRevision: 0, text: "selection A", data, lease: initial.lease })
  await f.service.refresh(42, { mountId })
  expect((await f.service.composerContext(42, "session", [entry.id]))[0]).toMatchObject({ expectedRevision: 6, text: "selection A", data })
  f.setState({ ...f.state(), lease: { token: "replacement", backendGeneration: "new-generation" } })
  await f.service.refresh(42, { mountId })
  await expect(f.service.composerContext(42, "session", [entry.id])).rejects.toThrow("context_expired")
})
it("does not wait for network preparation when collecting an already captured composer context", async () => {
  const f = fixture(), { mountId } = await f.mount()
  const entry = await f.service.updateModelContext(42, { mountId, content: [{ type: "text", text: "selection" }] })
  vi.spyOn(f.service, "refresh").mockRejectedValue(new Error("network preparation must happen after admission"))
  expect(await f.service.composerContext(42, "session", [entry.id])).toMatchObject([{ text: "selection", source }])
})
it("never delivers a late message receipt to a released frame", async () => {
  const f = fixture(), { mountId } = await f.mount()
  let resolve!: (value: Awaited<ReturnType<typeof f.client.pluginApps.submitConversation>>) => void
  vi.spyOn(f.client.pluginApps, "submitConversation").mockImplementation(() => new Promise(done => { resolve = done }))
  const request = await f.service.prepareMessage(42, { mountId, role: "user", content: [{ type: "text", text: "hello" }] })
  const pending = f.service.submitMessage(42, { mountId, requestId: request.requestId })
  // Refresh/model checks finish before the submission is held by the fixture.
  while (!resolve) await new Promise(done => setTimeout(done, 0))
  await f.service.release(42, { mountId })
  resolve({ source, requestId: request.requestId, inputId: "input", runId: "run", expectedRevision: 0, status: "completed" })
  await expect(pending).rejects.toThrow("mount_closed")
})
it("captures finite arguments and original revision before confirmation; stays on original session after switching", async () => {
  const f = fixture(), mount = await f.mount(), args = { value: "original" }
  const prepared = await f.service.prepareTool(42, { mountId: mount.mountId, name: "save", arguments: args })
  args.value = "forged"; f.switchSession()
  f.setState({ ...f.state(), app: { ...f.state().app, controlRevision: 5 } })
  await f.service.refresh(42, { mountId: mount.mountId })
  const result = await f.service.invokeTool(42, { mountId: mount.mountId, requestId: prepared.requestId })
  expect(f.requests[0]).toMatchObject({ source, expectedRevision: 0, args: { value: "original" } })
  expect(result.result?._meta).toEqual({ private: true })
  expect(mount.state).not.toHaveProperty("lease")
})
it("rejects foreign owners, fake app IDs, retired confirmations and parent navigation", async () => {
  const f = fixture(), mount = await f.mount()
  await expect(f.service.prepareTool(43, { mountId: mount.mountId, name: "save", arguments: {} })).rejects.toThrow("mount_closed")
  await expect(f.service.prepareTool(42, { mountId: "app", name: "save", arguments: {} })).rejects.toThrow("mount_closed")
  const prepared = await f.service.prepareTool(42, { mountId: mount.mountId, name: "save", arguments: {} })
  f.owner.emit("did-start-navigation", {}, "file:///forged.html", false, true)
  await expect(f.service.invokeTool(42, { mountId: mount.mountId, requestId: prepared.requestId })).rejects.toThrow("mount_closed")
  expect(f.requests).toEqual([])
})
it("releasing a window mount does not close the shared durable app; read-only resources confer no tool permission", async () => {
  const f = fixture(), mount = await f.mount()
  f.setState({ ...f.state(), lease: undefined, tools: [], availability: { canReadResource: true, canInvokeTools: false, canMessage: false } })
  await expect(f.service.prepareTool(42, { mountId: mount.mountId, name: "save", arguments: {} })).rejects.toThrow("tool_not_available")
  await f.service.release(42, { mountId: mount.mountId })
  expect(f.close).not.toHaveBeenCalled()
  expect(f.requests).toEqual([])
})
it.each(["lost-response", "cancel-late-result", "reconnect"] as const)("recovers %s only by reading the original receipt without invoking again", async mode => {
  const f = fixture(), mount = await f.mount()
  const request = await f.service.prepareTool(42, { mountId: mount.mountId, name: "save", arguments: { value: "one" } })
  const receipt = { source, requestId: request.requestId, runId: "accepted-run", expectedRevision: 0, acceptedRevision: 1,
    status: "completed" as const, executionState: "completed" as const }
  const invoke = vi.spyOn(f.client.pluginApps, "invoke")
  if (mode === "cancel-late-result") invoke.mockResolvedValueOnce({ receipt: { ...receipt, status: "running", executionState: "unknown" } })
  else invoke.mockRejectedValueOnce(new Error("response lost after acceptance"))
  const read = vi.spyOn(f.client.pluginApps, "getAction").mockResolvedValue({ receipt, result: { content: [] } })
  const cancel = vi.spyOn(f.client.pluginApps, "cancelAction").mockResolvedValue({ receipt: { ...receipt, status: "running", executionState: "unknown" } })
  const submitted = f.service.invokeTool(42, { mountId: mount.mountId, requestId: request.requestId })
  if (mode === "cancel-late-result") {
    await submitted
    await f.service.cancelTool(42, { mountId: mount.mountId, requestId: request.requestId })
    expect(cancel).toHaveBeenCalledWith(source, request.requestId)
  } else await expect(submitted).rejects.toThrow("response lost")
  if (mode === "reconnect") { f.service.invalidateConnection(); f.reconnect() }
  await f.service.refresh(42, { mountId: mount.mountId })
  expect(read).toHaveBeenCalledWith(source, request.requestId)
  expect(invoke).toHaveBeenCalledTimes(1)
  await expect(f.service.prepareTool(42, { mountId: mount.mountId, name: "save", arguments: { value: "two" } })).resolves.toMatchObject({ toolName: "save" })
})
it("settles local polling for a terminal unknown but keeps new tools and messages blocked by durable availability", async () => {
  const f = fixture(), mount = await f.mount()
  const request = await f.service.prepareTool(42, { mountId: mount.mountId, name: "save", arguments: {} })
  vi.spyOn(f.client.pluginApps, "invoke").mockRejectedValueOnce(new Error("lost"))
  await expect(f.service.invokeTool(42, { mountId: mount.mountId, requestId: request.requestId })).rejects.toThrow("lost")
  vi.spyOn(f.client.pluginApps, "getAction").mockResolvedValue({ receipt: { source, requestId: request.requestId, runId: "r", expectedRevision: 0, acceptedRevision: 1,
    status: "interrupted", executionState: "unknown" } })
  f.setState({ ...f.state(), availability: { canReadResource: true, canInvokeTools: false, canMessage: false, reason: "action-unconfirmed" } })
  const state = await f.service.refresh(42, { mountId: mount.mountId })
  expect(state.availability).toMatchObject({ canInvokeTools: false, canMessage: false, reason: "action-unconfirmed" })
  await expect(f.service.prepareTool(42, { mountId: mount.mountId, name: "save", arguments: {} })).rejects.toThrow("tool_not_available")
})
it("close conflict retains the mounted document and does not cancel a sent action before the fixed-revision close", async () => {
  const f = fixture(), mount = await f.mount()
  const prepared = await f.service.prepareTool(42, { mountId: mount.mountId, name: "save", arguments: {} })
  const receipt = { source, requestId: prepared.requestId, runId: "r", expectedRevision: 0, acceptedRevision: 1, status: "running" as const, executionState: "unknown" as const }
  vi.spyOn(f.client.pluginApps, "invoke").mockResolvedValue({ receipt })
  const cancel = vi.spyOn(f.client.pluginApps, "cancelAction").mockImplementation(async () => {
    f.setState({ ...f.state(), app: { ...f.state().app, controlRevision: 2 } })
    return { receipt: { ...receipt, status: "interrupted" } }
  })
  vi.spyOn(f.client.pluginApps, "getAction").mockResolvedValue({ receipt })
  await f.service.invokeTool(42, { mountId: mount.mountId, requestId: prepared.requestId })
  const close = vi.spyOn(f.client.pluginApps, "close").mockImplementation(async (_source, input) => {
    expect(cancel).not.toHaveBeenCalled()
    expect(input.expectedRevision).toBe(0)
    f.setState({ ...f.state(), app: { ...f.state().app, controlRevision: 1 } })
    throw new Error("plugin_app_revision_conflict")
  })
  await expect(f.service.close(42, { mountId: mount.mountId, expectedRevision: 0 })).rejects.toThrow("revision_conflict")
  expect(f.service.getBinding(42, mount.mountId).response.app.controlRevision).toBe(1)
  expect(close).toHaveBeenCalledTimes(1)
  expect(cancel).not.toHaveBeenCalled()
})
it("successful close orders durable close before cancellation and rejects later tools", async () => {
  const f = fixture(), mount = await f.mount(), order: string[] = []
  const prepared = await f.service.prepareTool(42, { mountId: mount.mountId, name: "save", arguments: {} })
  const receipt = { source, requestId: prepared.requestId, runId: "r", expectedRevision: 0, acceptedRevision: 1, status: "running" as const, executionState: "unknown" as const }
  vi.spyOn(f.client.pluginApps, "invoke").mockResolvedValue({ receipt })
  vi.spyOn(f.client.pluginApps, "getAction").mockResolvedValue({ receipt })
  await f.service.invokeTool(42, { mountId: mount.mountId, requestId: prepared.requestId })
  f.setState({ ...f.state(), app: { ...f.state().app, controlRevision: 1 } })
  await f.service.refresh(42, { mountId: mount.mountId })
  vi.spyOn(f.client.pluginApps, "close").mockImplementation(async (_source, input) => { order.push("close"); expect(input.expectedRevision).toBe(1); return { app: { ...f.state().app, status: "closed" } } })
  vi.spyOn(f.client.pluginApps, "cancelAction").mockImplementation(async () => { order.push("cancel"); return { receipt: { ...receipt, status: "interrupted" } } })
  await f.service.close(42, { mountId: mount.mountId, expectedRevision: 1 })
  expect(order).toEqual(["close", "cancel"])
  expect(() => f.service.getBinding(42, mount.mountId)).toThrow("mount_closed")
})
it("stale renderer revision is rejected without removing the document or sending another close", async () => {
  const f = fixture(), mount = await f.mount()
  f.setState({ ...f.state(), app: { ...f.state().app, controlRevision: 9 } })
  await f.service.refresh(42, { mountId: mount.mountId })
  await expect(f.service.close(42, { mountId: mount.mountId, expectedRevision: 0 })).rejects.toThrow("revision_conflict")
  expect(f.service.getBinding(42, mount.mountId)).toBeTruthy()
  expect(f.close).not.toHaveBeenCalled()
})

it("bounds settled tool history while retaining prepared/sent operations and querying original durable receipts", async () => {
  const f = fixture(), { mountId } = await f.mount(), ids: string[] = []
  for (let index = 0; index < 66; index++) {
    const prepared = await f.service.prepareTool(42, { mountId, name: "save", arguments: { index, body: "x".repeat(1024) } })
    ids.push(prepared.requestId)
    await f.service.invokeTool(42, { mountId, requestId: prepared.requestId })
  }
  const operations = (f.service as unknown as { operations: Map<string, { phase: string }> }).operations
  expect(operations.size).toBe(64)
  expect([...operations.keys()]).toEqual(ids.slice(2))
  const prepared = await f.service.prepareTool(42, { mountId, name: "save", arguments: { pending: true } })
  expect(operations.size).toBe(65); expect(operations.get(prepared.requestId)?.phase).toBe("prepared")
  const receipt = { source, requestId: prepared.requestId, runId: "original-run", expectedRevision: 0, acceptedRevision: 1,
    status: "running" as const, executionState: "unknown" as const }
  const invoke = vi.spyOn(f.client.pluginApps, "invoke").mockResolvedValueOnce({ receipt })
  await f.service.invokeTool(42, { mountId, requestId: prepared.requestId })
  const lookup = vi.spyOn(f.client.pluginApps, "getAction").mockImplementation(async (_source, requestId) => ({ receipt: { ...receipt, requestId,
    status: requestId === prepared.requestId ? "running" : "completed" } }))
  await f.service.getAction(42, { mountId, requestId: ids.at(-1) })
  expect(lookup).toHaveBeenLastCalledWith(source, ids.at(-1))
  expect(operations.get(prepared.requestId)?.phase).toBe("sent")
  await f.service.refresh(42, { mountId })
  expect(lookup).toHaveBeenLastCalledWith(source, prepared.requestId)
  expect(operations.has(prepared.requestId)).toBe(true)
  expect(invoke).toHaveBeenCalledTimes(1)
  await expect(f.service.getAction(42, { mountId, requestId: ids[0] })).rejects.toThrow("request_unavailable")
  lookup.mockResolvedValueOnce({ receipt: { ...receipt, status: "completed", executionState: "completed" } })
  await f.service.getAction(42, { mountId, requestId: prepared.requestId })
  expect(operations.size).toBe(64); expect(operations.has(ids[2]!)).toBe(false)
  expect(invoke).toHaveBeenCalledTimes(1)
})

it.each(["immediate", "poll"] as const)("checks the original page authority before %s result delivery", async path => {
  const changes = ["disabled", "lease-revoked", "lease-replaced", "generation", "pluginVersion", "pluginDigest", "definitionDigest", "backendId", "backendKind", "resourceUri", "source", "prepare-failure", "reconnect-refresh"] as const
  for (const change of changes) {
    const f = fixture(), { mountId } = await f.mount()
    const prepared = await f.service.prepareTool(42, { mountId, name: "save", arguments: {} })
    const terminal = { receipt: { source, requestId: prepared.requestId, runId: "r", expectedRevision: 0, acceptedRevision: 1,
      status: "completed" as const, executionState: "completed" as const },
      result: { content: [{ type: "text" as const, text: "private text" }], structuredContent: { appData: "private" }, _meta: { secret: "private" } } }
    const read = vi.spyOn(f.client.pluginApps, "getAction").mockResolvedValue(terminal)
    const revoke = async () => {
      const state = structuredClone(f.state())
      if (change === "disabled") state.availability.canReadResource = false
      else if (change === "lease-revoked") state.lease = undefined
      else if (change === "lease-replaced" || change === "reconnect-refresh") state.lease!.token = "new-lease"
      else if (change === "generation") state.lease!.backendGeneration = "new-generation"
      else if (change === "source") state.source.appId = "different"
      else if (change === "prepare-failure") vi.spyOn(f.client.pluginApps, "prepare").mockRejectedValue(new Error("disabled"))
      else if (change === "backendKind") state.app.backendKind = "mcp-server"
      else state.app[change] = change.endsWith("Digest") ? "c".repeat(64) : "different"
      f.setState(state)
      if (change === "reconnect-refresh") {
        f.service.invalidateConnection(); f.reconnect(); await f.service.refresh(42, { mountId })
      }
    }
    const invoke = vi.spyOn(f.client.pluginApps, "invoke").mockImplementation(async () => {
      if (path === "immediate") { await revoke(); return terminal }
      return { receipt: { ...terminal.receipt, status: "running", executionState: "unknown" } }
    })
    const sent = await f.service.invokeTool(42, { mountId, requestId: prepared.requestId })
    let delivered = sent
    if (path === "poll") { await revoke(); delivered = await f.service.getAction(42, { mountId, requestId: prepared.requestId }) }
    expect(delivered, `${path}:${change}`).toEqual({ receipt: terminal.receipt, dataError: "plugin_app_result_unavailable" })
    expect(JSON.stringify(delivered)).not.toContain("private")
    // Trusted original-session receipt reads remain possible, without replaying the tool.
    expect(await f.client.pluginApps.getAction(source, prepared.requestId)).toEqual(terminal)
    expect(invoke).toHaveBeenCalledTimes(1)
    // The terminal fact was recorded even though the private result could not be delivered.
    if (change === "prepare-failure") vi.mocked(f.client.pluginApps.prepare).mockRestore()
    f.setState(structuredClone(initial)); await f.service.refresh(42, { mountId })
    await expect(f.service.prepareTool(42, { mountId, name: "save", arguments: {} })).resolves.toMatchObject({ toolName: "save" })
    f.service.dispose()
  }
})
it.each(["immediate", "poll"] as const)("delivers %s results under the same original source, identity and lease", async path => {
  const f = fixture(), { mountId } = await f.mount()
  const prepared = await f.service.prepareTool(42, { mountId, name: "save", arguments: {} })
  const terminal = { receipt: { source, requestId: prepared.requestId, runId: "r", expectedRevision: 0, acceptedRevision: 1,
    status: "completed" as const, executionState: "completed" as const }, result: { content: [], _meta: { private: true } } }
  const invoke = vi.spyOn(f.client.pluginApps, "invoke").mockResolvedValue(path === "immediate" ? terminal
    : { receipt: { ...terminal.receipt, status: "running", executionState: "unknown" } })
  vi.spyOn(f.client.pluginApps, "getAction").mockResolvedValue(terminal)
  const sent = await f.service.invokeTool(42, { mountId, requestId: prepared.requestId })
  expect(path === "immediate" ? sent : await f.service.getAction(42, { mountId, requestId: prepared.requestId })).toEqual(terminal)
  expect(invoke).toHaveBeenCalledTimes(1)
  f.service.dispose()
})

it("reads pending and unknown receipt facts after revocation without refreshing or replaying", async () => {
  const f = fixture(), { mountId } = await f.mount()
  const prepared = await f.service.prepareTool(42, { mountId, name: "save", arguments: {} })
  const running = { receipt: { source, requestId: prepared.requestId, runId: "r", expectedRevision: 0, acceptedRevision: 1,
    status: "running" as const, executionState: "unknown" as const } }
  const terminal = { receipt: { ...running.receipt, status: "interrupted" as const } }
  const prepare = vi.spyOn(f.client.pluginApps, "prepare").mockRejectedValue(new Error("revoked"))
  const invoke = vi.spyOn(f.client.pluginApps, "invoke").mockResolvedValue(running)
  vi.spyOn(f.client.pluginApps, "getAction").mockResolvedValue(terminal)
  expect(await f.service.invokeTool(42, { mountId, requestId: prepared.requestId })).toEqual(running)
  expect(await f.service.getAction(42, { mountId, requestId: prepared.requestId })).toEqual(terminal)
  expect(prepare).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(1)
  f.service.dispose()
})
