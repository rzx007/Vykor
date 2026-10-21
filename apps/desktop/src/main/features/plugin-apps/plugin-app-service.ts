import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import { VykorApiError, isPluginAppAdmissionRejection, copyPluginAppJson, parseOpenPluginAppInput, parsePluginAppSource, parsePluginAppToolRequest,
  parsePluginAppConversationRequest, type PluginAppConversationRequest, type PluginAppSubmissionReceipt, type VykorClient, type PluginAppResponse, type PluginAppToolRequest, type PluginAppActionResponse } from "@vykor/client"
import type { PluginAppHostState, PluginAppMount, PluginAppPreparedTool, PluginAppPreparedMessage, PluginAppModelContext } from "../../../shared/plugin-app-types"
import { pluginAppText, pluginAppContextData } from "../../../shared/plugin-app-content"
import type { DesktopSessionView } from "../../../shared/session-types"
import { PluginAppDocumentStore } from "./document-store"
import { appHtml, validateAppResource } from "./resources"
import { WindowResourceFeed } from "./resource-feed"
interface Owner { contents: WebContents; trustedUrl: string; epoch: number }
export interface AppMountBinding {
  ownerId: number; owner: Owner; epoch: number; client: VykorClient; response: PluginAppResponse;
  menuOpeningRevision?: number; modelReady?: boolean; mountId: string; url: string; admitted: boolean; online: boolean; closing?: boolean; sessionToken: object;
}
interface Operation { mount: AppMountBinding; identity: PluginAppResponse["app"]; request: PluginAppToolRequest; phase: "prepared" | "sent" | "settled"; cancelled: boolean }
interface MessageOperation { mount: AppMountBinding; client: VykorClient; request: PluginAppConversationRequest; phase: "prepared" | "sent" | "settled"; cancelled: boolean }
interface Dependencies {
  messageReady?(client: VykorClient, sessionId: string): Promise<boolean>
  documents: PluginAppDocumentStore
  getClient(): Promise<VykorClient>
  getOwnerSessionToken(ownerId: number, sessionId: string): object | undefined
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plugin_app_invalid_request")
  return value as Record<string, unknown>
}
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value || value.length > 4096) throw new Error("plugin_app_invalid_request")
  return value
}
const trustedLocation = (value: string): string => { const url = new URL(value); url.hash = ""; return url.href }
export function publicAppState(response: PluginAppResponse, online: boolean): PluginAppHostState {
  const { lease: _lease, ...state } = response
  return structuredClone({ ...state, online })
}
/** The retained mount owns its original session. Active UI selection is never execution authority. */
export class DesktopPluginAppService {
  private readonly owners = new Map<number, Owner>()
  private readonly feeds = new Map<number, WindowResourceFeed>()
  private readonly mounts = new Map<string, AppMountBinding>()
  private readonly operations = new Map<string, Operation>()
  private readonly messages = new Map<string, MessageOperation>()
  private readonly contexts = new Map<string, { mount: AppMountBinding; entry: PluginAppModelContext; request: PluginAppConversationRequest }>()
  private readonly opening = new Map<string, Promise<PluginAppMount>>()
  // One service owns every window. Serialize viewer acquisition with rejected-menu cleanup.
  private readonly lifecycle = new Map<string, Promise<unknown>>()
  private async withLifecycle<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const pending = (this.lifecycle.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(action)
    this.lifecycle.set(sessionId, pending)
    try { return await pending } finally { if (this.lifecycle.get(sessionId) === pending) this.lifecycle.delete(sessionId) }
  }
  constructor(private readonly dependencies: Dependencies) {}
  registerOwner(contents: WebContents, url: string): void {
    const owner = { contents, trustedUrl: trustedLocation(url), epoch: 0 }
    this.owners.set(contents.id, owner)
    this.feeds.set(contents.id, new WindowResourceFeed(mount => {
      if (mount.admitted && this.isOwner(contents.id)) contents.send("plugin-apps:resources-changed", { mountId: mount.mountId })
    }))
    contents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) { owner.epoch++; this.releaseOwner(contents.id) }
    })
    contents.once("destroyed", () => { this.releaseOwner(contents.id); this.feeds.get(contents.id)?.dispose(); this.feeds.delete(contents.id); this.owners.delete(contents.id) })
  }
  isOwner(ownerId: number): boolean {
    const owner = this.owners.get(ownerId)
    try { return !!owner && !owner.contents.isDestroyed() && trustedLocation(owner.contents.getURL()) === owner.trustedUrl } catch { return false }
  }
  private async capture(ownerId: number, sessionId: string) {
    const owner = this.owners.get(ownerId), sessionToken = this.dependencies.getOwnerSessionToken(ownerId, sessionId)
    if (!owner || !sessionToken || !this.isOwner(ownerId)) throw new Error("plugin_app_owner_unavailable")
    const epoch = owner.epoch, client = await this.dependencies.getClient()
    if ((await client.protocol.capabilities()).features.pluginApps !== 1) throw new Error("plugin_app_protocol_unavailable")
    if (!this.isOwner(ownerId) || owner.epoch !== epoch || this.dependencies.getOwnerSessionToken(ownerId, sessionId) !== sessionToken) throw new Error("plugin_app_owner_changed")
    return { owner, ownerId, epoch, client, sessionToken }
  }
  assertBinding(mount: AppMountBinding, served = true): void {
    if (!mount.admitted || this.mounts.get(mount.mountId) !== mount || !this.isOwner(mount.ownerId)
      || this.owners.get(mount.ownerId) !== mount.owner || mount.owner.epoch !== mount.epoch
      || !this.dependencies.documents.owns(mount.mountId, mount.ownerId, mount.client, served)) throw new Error("plugin_app_mount_closed")
  }
  getBinding(ownerId: number, mountId: unknown, served = true): AppMountBinding {
    const mount = this.mounts.get(text(mountId))
    if (!mount || mount.ownerId !== ownerId) throw new Error("plugin_app_mount_closed")
    this.assertBinding(mount, served)
    return mount
  }
  async catalog(ownerId: number, value: unknown) {
    const sessionId = text(object(value).sessionId), scope = await this.capture(ownerId, sessionId)
    const result = await scope.client.pluginApps.catalog(sessionId)
    if (!this.isOwner(ownerId) || scope.owner.epoch !== scope.epoch) throw new Error("plugin_app_owner_changed")
    return result
  }
  async open(ownerId: number, value: unknown): Promise<PluginAppMount> {
    return this.withLifecycle(text(object(value).sessionId), () => this.openWithin(ownerId, value))
  }
  private async openWithin(ownerId: number, value: unknown): Promise<PluginAppMount> {
    const input = object(value), sessionId = text(input.sessionId), scope = await this.capture(ownerId, sessionId)
    const definition = parseOpenPluginAppInput({ pluginId: input.pluginId, surfaceId: input.surfaceId })
    this.checkCapacity(ownerId, sessionId)
    const response = await scope.client.pluginApps.open(sessionId, definition)
    const mounted = await this.mountWithin(ownerId, response.source)
    const binding = this.getBinding(ownerId, mounted.mountId, false)
    if (response.openedByRequest === true && !response.app.activeActionRunId && !response.app.lastActionRunId)
      binding.menuOpeningRevision = response.app.controlRevision
    return mounted
  }
  async openToolResult(ownerId: number, value: unknown) {
    return this.withLifecycle(text(object(value).sessionId), () => this.openToolResultWithin(ownerId, value))
  }
  private async openToolResultWithin(ownerId: number, value: unknown) {
    const input = object(value), sessionId = text(input.sessionId), sourcePartId = text(input.sourcePartId), scope = await this.capture(ownerId, sessionId)
    if (Object.keys(input).some(key => !["sessionId", "sourcePartId"].includes(key))) throw new Error("plugin_app_invalid_request")
    const response = await scope.client.pluginApps.openToolResult(sessionId, sourcePartId)
    const mounted = await this.mountWithin(ownerId, response.source)
    const binding = this.getBinding(ownerId, mounted.mountId, false)
    if (!binding.response.lease) throw new Error("plugin_app_lease_invalid")
    const initial = await binding.client.pluginApps.initialResult(binding.response.source, binding.response.lease, sourcePartId)
    this.assertBinding(binding, false)
    return { mounted, initial: { ...initial, sourcePartId } }
  }
  private checkCapacity(ownerId: number, sessionId: string): void {
    const owned = [...this.mounts.values()].filter(mount => mount.ownerId === ownerId)
    if (owned.length >= 8 || owned.filter(mount => mount.response.source.sessionId === sessionId).length >= 4) throw new Error("plugin_app_capacity_reached")
  }
  async mount(ownerId: number, value: unknown): Promise<PluginAppMount> {
    return this.withLifecycle(parsePluginAppSource(value).sessionId, () => this.mountWithin(ownerId, value))
  }
  private async mountWithin(ownerId: number, value: unknown): Promise<PluginAppMount> {
    const source = parsePluginAppSource(value), key = `${ownerId}:${source.sessionId}:${source.appId}`
    const prior = [...this.mounts.values()].find(mount => mount.ownerId === ownerId && mount.response.source.appId === source.appId && mount.response.source.sessionId === source.sessionId)
    if (prior) { this.assertBinding(prior, false); delete prior.menuOpeningRevision; return { mountId: prior.mountId, url: prior.url, state: this.publicState(prior) } }
    const pending = this.opening.get(key)
    if (pending) return pending
    const promise = (async () => {
      const scope = await this.capture(ownerId, source.sessionId)
      this.checkCapacity(ownerId, source.sessionId)
      const response = await scope.client.pluginApps.prepare(source)
      if (response.source.appId !== source.appId || response.source.sessionId !== source.sessionId || response.app.status !== "open" || !response.availability.canReadResource) throw new Error("plugin_app_unavailable")
      const html = appHtml(await scope.client.pluginApps.readResource(source, response.lease, response.app.resourceUri), response.app.resourceUri)
      const latest = await scope.client.pluginApps.prepare(source)
      if (latest.app.pluginDigest !== response.app.pluginDigest || latest.app.definitionDigest !== response.app.definitionDigest || latest.app.resourceUri !== response.app.resourceUri
        || latest.app.status !== "open" || !latest.availability.canReadResource || !this.isOwner(ownerId) || scope.owner.epoch !== scope.epoch) throw new Error("plugin_app_snapshot_changed")
      const document = this.dependencies.documents.register({ ownerId, connection: scope.client, sessionId: source.sessionId, appId: source.appId, ...html })
      const mount: AppMountBinding = { ...scope, ...document, response: latest, admitted: true, online: true }
      this.mounts.set(document.mountId, mount)
      mount.modelReady = await this.dependencies.messageReady?.(mount.client, source.sessionId).catch(() => false) ?? false
      this.assertBinding(mount, false)
      return { ...document, state: this.publicState(mount) }
    })()
    this.opening.set(key, promise)
    try { return await promise } finally { if (this.opening.get(key) === promise) this.opening.delete(key) }
  }
  async refresh(ownerId: number, value: unknown): Promise<PluginAppHostState> {
    const mount = this.getBinding(ownerId, object(value).mountId, false)
    try {
      const client = await this.dependencies.getClient()
      // An authenticated reconnect can recover state, but never replays an operation.
      for (const operation of this.operations.values()) if (operation.mount === mount && operation.phase === "sent") {
        try { this.recordResult(operation, await client.pluginApps.getAction(operation.request.source, operation.request.requestId)) } catch { /* Never repeat invoke after a lost acknowledgement. */ }
      }
      for (const operation of this.messages.values()) if (operation.mount === mount && operation.phase === "sent") {
        try {
          await client.pluginApps.getConversationSubmission(operation.request.source, operation.request.requestId)
          operation.phase = "settled"
        } catch { /* Missing/unknown delivery is not evidence of rejection. Never resubmit. */ }
      }
      const response = await client.pluginApps.prepare(mount.response.source)
      this.assertBinding(mount, false)
      if (response.source.appId !== mount.response.source.appId || response.source.sessionId !== mount.response.source.sessionId
        || response.app.id !== mount.response.app.id || response.app.sessionId !== mount.response.app.sessionId
        || response.app.pluginId !== mount.response.app.pluginId || response.app.pluginVersion !== mount.response.app.pluginVersion
        || response.app.pluginDigest !== mount.response.app.pluginDigest || response.app.definitionDigest !== mount.response.app.definitionDigest
        || response.app.backendId !== mount.response.app.backendId || response.app.backendKind !== mount.response.app.backendKind || response.app.resourceUri !== mount.response.app.resourceUri)
        throw new Error("plugin_app_snapshot_changed")
      mount.response = response; mount.online = true
      // Rebind only after the authenticated local client verified the same durable source and backend.
      if (client !== mount.client) { this.dependencies.documents.rebind(mount.mountId, mount.client, client); mount.client = client }
      mount.modelReady = await this.dependencies.messageReady?.(mount.client, mount.response.source.sessionId).catch(() => false) ?? false
      this.assertBinding(mount, false)
      this.feeds.get(ownerId)?.sync()
      return this.publicState(mount)
    } catch { this.assertBinding(mount, false); mount.online = false; this.feeds.get(ownerId)?.sync(); return this.publicState(mount) }
  }
  private publicState(mount: AppMountBinding): PluginAppHostState {
    const state = publicAppState(mount.response, mount.online)
    state.availability.canMessage = state.availability.canMessage && !!mount.modelReady && mount.online && !mount.closing
    return state
  }
  private assertMessage(mount: AppMountBinding, needsModel = true): void {
    this.assertBinding(mount)
    if (mount.closing || !mount.online || !mount.response.lease || mount.response.app.status !== "open"
      || !mount.response.availability.canMessage || (needsModel && !mount.modelReady)) throw new Error("plugin_app_message_unavailable")
  }
  async prepareMessage(ownerId: number, value: unknown): Promise<PluginAppPreparedMessage> {
    const input = object(value), mount = this.getBinding(ownerId, input.mountId)
    if (input.role !== "user") throw new Error("plugin_app_unsupported_role")
    const content = pluginAppText(input.content)
    await this.refresh(ownerId, { mountId: mount.mountId }); this.assertMessage(mount)
    if ([...this.messages.values()].some(item => item.mount === mount && item.phase !== "settled")) throw new Error("plugin_app_message_pending")
    const response = mount.response
    const history = [...this.messages.entries()].filter(([, previous]) => previous.mount === mount && previous.phase === "settled")
    for (const [id] of history.slice(0, Math.max(0, history.length - 63))) this.messages.delete(id)
    const request = parsePluginAppConversationRequest({ source: response.source, lease: response.lease, requestId: randomUUID(),
      expectedRevision: response.app.controlRevision, text: content, data: null })
    this.messages.set(request.requestId, { mount, client: mount.client, request, phase: "prepared", cancelled: false })
    return { pluginId: response.app.pluginId, source: { ...request.source }, requestId: request.requestId, text: request.text, data: request.data, expectedRevision: request.expectedRevision }
  }
  private message(ownerId: number, value: unknown): MessageOperation {
    const input = object(value), mount = this.getBinding(ownerId, input.mountId), operation = this.messages.get(text(input.requestId))
    if (!operation || operation.mount !== mount) throw new Error("plugin_app_request_unavailable")
    return operation
  }
  async submitMessage(ownerId: number, value: unknown): Promise<PluginAppSubmissionReceipt> {
    const operation = this.message(ownerId, value), { mount, request } = operation
    if (operation.cancelled) throw new Error("plugin_app_request_unavailable")
    try {
    if (operation.phase === "prepared") {
      await this.refresh(ownerId, { mountId: mount.mountId }); this.assertMessage(mount)
      if (operation.cancelled || mount.client !== operation.client || mount.response.app.controlRevision !== request.expectedRevision)
        throw new Error("plugin_app_snapshot_changed")
    }
    // Retry always carries this exact request to Task 5's deduplicating ordinary-input service.
    operation.phase = "sent"
    const result = await operation.client.pluginApps.submitConversation(request)
    operation.phase = "settled"
    this.assertBinding(mount)
    if (operation.cancelled) throw new Error("plugin_app_request_cancelled")
    return result
    } catch (error) {
      if (operation.phase === "prepared" || (error instanceof VykorApiError && error.status === 409
        && isPluginAppAdmissionRejection(error.body, "message", request))) {
        operation.phase = "settled"; operation.cancelled = true
        this.trimToolHistory(operation.mount)
      }
      throw error
    }
  }
  async getMessageSubmission(ownerId: number, value: unknown): Promise<PluginAppSubmissionReceipt> {
    const operation = this.message(ownerId, value)
    if (operation.phase === "prepared") throw new Error("plugin_app_not_sent")
    const result = await operation.client.pluginApps.getConversationSubmission(operation.request.source, operation.request.requestId)
    operation.phase = "settled"; this.assertBinding(operation.mount)
    return result
  }
  async cancelMessage(ownerId: number, value: unknown): Promise<void> {
    const operation = this.message(ownerId, value)
    operation.cancelled = true
    if (operation.phase === "prepared") this.messages.delete(operation.request.requestId)
    // A sent user input is durable; cancellation never pretends to undo it or starts another Run.
  }
  async updateModelContext(ownerId: number, value: unknown): Promise<PluginAppModelContext> {
    const input = object(value), mount = this.getBinding(ownerId, input.mountId)
    const content = pluginAppText(input.content, false), data = pluginAppContextData(input.structuredContent)
    if (!content.trim() && data === null) throw new Error("plugin_app_invalid_context")
    await this.refresh(ownerId, { mountId: mount.mountId }); this.assertMessage(mount, false)
    const entry: PluginAppModelContext = { id: randomUUID(), source: { ...mount.response.source }, pluginId: mount.response.app.pluginId, text: content, data }
    for (const [id, previous] of this.contexts) if (previous.mount === mount) this.contexts.delete(id)
    this.contexts.set(entry.id, { mount, entry, request: parsePluginAppConversationRequest({ source: entry.source, lease: mount.response.lease, requestId: entry.id, expectedRevision: mount.response.app.controlRevision, text: content.trim() ? content : "插件提供的结构化上下文", data }) })
    return structuredClone(entry)
  }
  /** Main only: references are opaque IDs, never caller supplied text/provenance/leases. */
  async composerContext(ownerId: number, sessionId: string, ids: unknown): Promise<PluginAppConversationRequest[]> {
    if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length) throw new Error("plugin_app_invalid_context")
    const selected = ids.map(id => {
      const stored = this.contexts.get(text(id))
      if (!stored || stored.mount.ownerId !== ownerId || stored.entry.source.sessionId !== sessionId) throw new Error("plugin_app_context_expired")
      return stored
    })
    for (const stored of selected) {
      await this.refresh(ownerId, { mountId: stored.mount.mountId }); this.assertMessage(stored.mount, false)
      if (this.contexts.get(stored.entry.id) !== stored) throw new Error("plugin_app_context_expired")
    }
    for (const stored of selected) this.assertMessage(stored.mount, false)
    return selected.map(({ request }) => structuredClone(request))
  }
  async prepareTool(ownerId: number, value: unknown): Promise<PluginAppPreparedTool> {
    const input = object(value), mount = this.getBinding(ownerId, input.mountId)
    const args = copyPluginAppJson(input.arguments, 64 * 1024), name = text(input.name)
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("plugin_app_invalid_arguments")
    await this.refresh(ownerId, { mountId: mount.mountId })
    this.assertBinding(mount)
    const response = mount.response
    if (mount.closing || !mount.online || !response.lease || !response.availability.canInvokeTools || response.app.status !== "open"
      || !response.tools?.some(tool => tool.name === name)) throw new Error("plugin_app_tool_not_available")
    if ([...this.operations.values()].some(operation => operation.mount === mount && operation.phase !== "settled")) throw new Error("plugin_app_action_pending")
    const request = parsePluginAppToolRequest({ source: response.source, lease: response.lease, requestId: randomUUID(),
      expectedRevision: response.app.controlRevision, toolName: name, args })
    this.operations.set(request.requestId, { mount, identity: structuredClone(response.app), request, phase: "prepared", cancelled: false })
    return { requestId: request.requestId, toolName: name, args: structuredClone(args), expectedRevision: request.expectedRevision }
  }
  private operation(ownerId: number, value: unknown): Operation {
    const input = object(value), mount = this.getBinding(ownerId, input.mountId)
    const operation = this.operations.get(text(input.requestId))
    if (!operation || operation.mount !== mount) throw new Error("plugin_app_request_unavailable")
    return operation
  }
  async invokeTool(ownerId: number, value: unknown): Promise<PluginAppActionResponse> {
    const operation = this.operation(ownerId, value), { mount, request } = operation
    if (operation.cancelled || operation.phase !== "prepared" || !mount.online || mount.closing) throw new Error("plugin_app_request_unavailable")
    // Fixed before the confirmation. Never substitute a revision observed during confirmation.
    operation.phase = "sent"
    try {
      const result = await mount.client.pluginApps.invoke(request)
      if (operation.cancelled || !mount.admitted) void mount.client.pluginApps.cancelAction(request.source, request.requestId).catch(() => {})
      this.recordResult(operation, result)
      this.assertBinding(mount)
      return await this.deliverResult(operation, result)
    } catch (error) {
      if (error instanceof VykorApiError && error.status === 409 && isPluginAppAdmissionRejection(error.body, "tool", request)) {
        operation.phase = "settled"; operation.cancelled = true
        this.trimToolHistory(operation.mount)
      }
      mount.online = false; throw error
    }
  }
  private async deliverResult(operation: Operation, result: PluginAppActionResponse): Promise<PluginAppActionResponse> {
    // Receipt-only polling carries no private page data and needs no installation refresh.
    if (result.result === undefined) return result
    const { mount, request, identity } = operation
    let authorized = false
    try {
      const client = await this.dependencies.getClient()
      const current = await client.pluginApps.prepare(request.source)
      this.assertBinding(mount)
      const keys = ["id", "sessionId", "pluginId", "pluginVersion", "pluginDigest", "definitionDigest", "backendId", "backendKind", "resourceUri"] as const
      authorized = current.source.sessionId === request.source.sessionId && current.source.appId === request.source.appId
        && keys.every(key => current.app[key] === identity[key])
        && current.app.status === "open" && current.availability.canReadResource
        && current.lease?.token === request.lease.token && current.lease.backendGeneration === request.lease.backendGeneration
    } catch { /* Trusted receipt reads remain available when the original page authority has expired. */ }
    this.assertBinding(mount)
    // Never adopt a newly issued lease as permission to deliver an older operation's private data.
    return authorized ? result : { receipt: result.receipt, dataError: "plugin_app_result_unavailable" }
  }
  private recordResult(operation: Operation, result: PluginAppActionResponse): PluginAppActionResponse {
    if (result.receipt.status !== "pending" && result.receipt.status !== "running") {
      operation.phase = "settled"
      this.trimToolHistory(operation.mount)
    }
    return result
  }
  private trimToolHistory(mount: AppMountBinding): void {
    const history = [...this.operations.entries()].filter(([, previous]) => previous.mount === mount && previous.phase === "settled")
    for (const [id] of history.slice(0, Math.max(0, history.length - 64))) this.operations.delete(id)
  }
  async getAction(ownerId: number, value: unknown): Promise<PluginAppActionResponse> {
    const operation = this.operation(ownerId, value)
    if (operation.phase === "prepared") throw new Error("plugin_app_not_sent")
    const result = await operation.mount.client.pluginApps.getAction(operation.request.source, operation.request.requestId)
    this.recordResult(operation, result)
    this.assertBinding(operation.mount)
    return this.deliverResult(operation, result)
  }
  async cancelTool(ownerId: number, value: unknown): Promise<void> {
    const operation = this.operation(ownerId, value)
    operation.cancelled = true
    if (operation.phase === "prepared") { this.operations.delete(operation.request.requestId); return }
    await operation.mount.client.pluginApps.cancelAction(operation.request.source, operation.request.requestId)
  }
  async readResource(ownerId: number, value: unknown) {
    const input = object(value), mount = this.getBinding(ownerId, input.mountId)
    if (!mount.online || !mount.response.availability.canReadResource) throw new Error("plugin_app_resource_unavailable")
    const uri = text(input.uri), raw = await mount.client.pluginApps.readResource(mount.response.source, mount.response.lease, uri)
    this.assertBinding(mount)
    const result = validateAppResource(raw, uri)
    this.feeds.get(ownerId)?.read(mount, uri)
    return result
  }
  async listResources(ownerId: number, value: unknown) {
    const input = object(value), mount = this.getBinding(ownerId, input.mountId)
    if (!mount.online || !mount.response.availability.canReadResource) throw new Error("plugin_app_resource_unavailable")
    const result = await mount.client.pluginApps.listResources(mount.response.source, mount.response.lease, input.cursor === undefined ? undefined : text(input.cursor))
    this.assertBinding(mount); return result
  }
  async listResourceTemplates(ownerId: number, value: unknown) {
    const input = object(value), mount = this.getBinding(ownerId, input.mountId)
    if (!mount.online || !mount.response.availability.canReadResource) throw new Error("plugin_app_resource_unavailable")
    const result = await mount.client.pluginApps.listResourceTemplates(mount.response.source, mount.response.lease, input.cursor === undefined ? undefined : text(input.cursor))
    this.assertBinding(mount); return result
  }
  async close(ownerId: number, value: unknown) {
    const input = object(value), mount = this.getBinding(ownerId, input.mountId, false)
    if (input.expectedRevision !== mount.response.app.controlRevision) throw new Error("plugin_app_revision_conflict")
    if (mount.closing) throw new Error("plugin_app_close_pending")
    const source = mount.response.source, expectedRevision = mount.response.app.controlRevision
    for (const [id, message] of this.messages) if (message.mount === mount && message.phase === "prepared") { message.cancelled = true; this.messages.delete(id) }
    // Pause admission and revoke confirmations, but retain the document until durable close succeeds.
    // Cancelling a sent action first could advance the revision and invalidate this exact close.
    mount.closing = true
    for (const [id, operation] of this.operations) if (operation.mount === mount && operation.phase === "prepared") {
      operation.cancelled = true; this.operations.delete(id)
    }
    try {
      const result = await mount.client.pluginApps.close(source, { expectedRevision })
      this.retire(mount)
      return result
    } catch (error) {
      mount.closing = false
      if (mount.admitted) await this.refresh(ownerId, { mountId: mount.mountId }).catch(() => {})
      throw error
    }
  }
  async rejectMenuOpen(ownerId: number, value: unknown): Promise<{ closed: boolean }> {
    const original = this.getBinding(ownerId, object(value).mountId, false)
    return this.withLifecycle(original.response.source.sessionId, async () => {
      const mount = this.getBinding(ownerId, original.mountId, false), expectedRevision = mount.menuOpeningRevision
      const shared = [...this.mounts.values()].some(other => other !== mount && other.admitted
        && other.response.source.sessionId === mount.response.source.sessionId && other.response.source.appId === mount.response.source.appId)
      if (expectedRevision === undefined || shared || mount.closing || !mount.online
        || mount.response.app.controlRevision !== expectedRevision || mount.response.app.activeActionRunId || mount.response.app.lastActionRunId
        || [...this.operations.values()].some(operation => operation.mount === mount)
        || [...this.messages.values()].some(operation => operation.mount === mount)) return { closed: false }
      // close() uses this captured revision. Server admission/settlement advances it, so a racing
      // operation rejects cleanup rather than silently replacing the revision or cancelling work.
      try { await this.close(ownerId, { mountId: mount.mountId, expectedRevision }); return { closed: true } }
      catch { return { closed: false } }
    })
  }
  async release(ownerId: number, value: unknown): Promise<void> {
    const mount = this.mounts.get(text(object(value).mountId))
    if (!mount) return
    if (mount.ownerId !== ownerId) throw new Error("plugin_app_mount_closed")
    this.retire(mount)
  }
  private retire(mount: AppMountBinding): void {
    mount.admitted = false
    this.mounts.delete(mount.mountId)
    this.feeds.get(mount.ownerId)?.remove(mount)
    for (const [id, operation] of this.operations) if (operation.mount === mount) {
      operation.cancelled = true
      if (operation.phase === "sent") void mount.client.pluginApps.cancelAction(operation.request.source, id)
        .then(() => mount.client.pluginApps.getAction(operation.request.source, id)).catch(() => {})
      this.operations.delete(id)
    }
    for (const [id, message] of this.messages) if (message.mount === mount) { message.cancelled = true; this.messages.delete(id) }
    for (const [id, context] of this.contexts) if (context.mount === mount) this.contexts.delete(id)
    this.dependencies.documents.revoke(mount.mountId)
  }
  releaseOwner(ownerId: number): void { for (const mount of this.mounts.values()) if (mount.ownerId === ownerId) this.retire(mount) }
  invalidateConnection(): void {
    for (const [id, message] of this.messages) if (message.phase === "prepared") { message.cancelled = true; this.messages.delete(id) }
    for (const mount of this.mounts.values()) { mount.online = false; mount.response = { ...mount.response, lease: undefined } }
    for (const feed of this.feeds.values()) feed.sync()
    for (const [id, operation] of this.operations) {
      operation.cancelled = true
      if (operation.phase === "prepared") this.operations.delete(id)
      else if (operation.phase === "sent") void operation.mount.client.pluginApps.cancelAction(operation.request.source, id).catch(() => {})
    }
  }
  observeSession(ownerId: number, view: DesktopSessionView): void {
    for (const mount of this.mounts.values()) if (mount.ownerId === ownerId && mount.response.source.sessionId === view.session.id) {
      if (view.syncStatus !== "connected") mount.online = false
      if (view.session.status === "archived" || view.session.status === "closing") this.retire(mount)
    }
  }
  dispose(): void { for (const id of this.owners.keys()) this.releaseOwner(id); this.owners.clear(); for (const feed of this.feeds.values()) feed.dispose(); this.feeds.clear() }
}
