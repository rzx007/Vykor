import type { WebContents } from "electron"
import {
  VykorApiError,
  PluginUiBridgeError,
  parsePluginUiBridgeRequest,
  ProtocolValidationError,
  parsePluginUiBridgeReceipt,
  readPluginUiAction,
  readPluginUiInstance,
  type VykorClient,
  type PluginUiInstanceRecord,
  type InvokePluginUiActionInput,
  type DismissPluginUiInput,
  type PluginUiSurface,
  parsePluginUiConversationRequest,
  parsePluginUiConversationPrepared,
} from "@vykor/client"
import type { DesktopPluginUiMountResult, PluginUiHostState } from "../../../shared/plugin-ui-types"
import type { DesktopSessionView } from "../../../shared/session-types"
import { PluginUiDocumentStore } from "./document-store"
import { PluginUiConversationRuntime, type ConversationBinding } from "./conversation-runtime"

interface Dependencies {
  documents: PluginUiDocumentStore
  getClient(): Promise<VykorClient>
  getOwnerSessionId(ownerId: number): string | undefined
  localAvailable(owner: WebContents): boolean
}
interface Owner {
  contents: WebContents
  epoch: number
  sessionEpoch: number
  sessionId: string | undefined
  trustedUrl: string
  view?: { sessionId: string; generation: unknown; sources: Set<string> }
}
interface Scope {
  ownerId: number
  owner: Owner
  epoch: number
  sessionEpoch: number
  generation: number
  sessionId: string
  client: VykorClient
}
interface Mount {
  scope: Scope
  instanceId: string
  surface: PluginUiSurface
  componentDigest: string
  sessionGeneration: unknown
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const fail = (code: string): never => {
  throw new PluginUiBridgeError(code)
}
function input(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PluginUiBridgeError("plugin_ui_invalid_message")
  const r = value as Record<string, unknown>
  if (Object.keys(r).length !== fields.length || !fields.every((key) => Object.hasOwn(r, key)))
    throw new PluginUiBridgeError("plugin_ui_invalid_message")
  try {
    if (
      JSON.stringify(r).length > 65_536 ||
      new TextEncoder().encode(JSON.stringify(r)).byteLength > 65_536
    )
      throw new PluginUiBridgeError("plugin_ui_payload_too_large")
  } catch (error) {
    if (error instanceof PluginUiBridgeError) throw error
    throw new PluginUiBridgeError("plugin_ui_invalid_message")
  }
  return r
}
function target(r: Record<string, unknown>): { sessionId: string; instanceId: string } {
  if (typeof r.sessionId !== "string" || !r.sessionId || !uuid(r.instanceId))
    fail("plugin_ui_invalid_message")
  return { sessionId: r.sessionId as string, instanceId: r.instanceId as string }
}
function safe(error: unknown): never {
  if (error instanceof PluginUiBridgeError) throw error
  if (error instanceof ProtocolValidationError)
    fail(
      error.details?.reason === "payload_too_large"
        ? "plugin_ui_payload_too_large"
        : "plugin_ui_invalid_message"
    )
  if (error instanceof VykorApiError && error.body && typeof error.body === "object") {
    const code = (error.body as { code?: unknown }).code
    if (typeof code === "string" && /^plugin_ui_[a-z0-9_]{1,60}$/.test(code)) fail(code)
  }
  return fail("plugin_ui_unavailable")
}

/** Only registered main-window owners may route finite calls to their current Client/session. */
export class DesktopPluginUiService {
  private readonly owners = new Map<number, Owner>()
  private readonly mounts = new Map<string, Mount>()
  private readonly opening = new Map<string, symbol>()
  private readonly conversations = new PluginUiConversationRuntime()
  private generation = 0
  private client?: VykorClient
  constructor(private readonly dependencies: Dependencies) {}
  registerOwner(contents: WebContents, trustedUrl: string): void {
    if (this.owners.has(contents.id)) return
    const location = new URL(trustedUrl)
    location.hash = ""
    this.owners.set(contents.id, {
      contents,
      epoch: 0,
      sessionEpoch: 0,
      sessionId: this.dependencies.getOwnerSessionId(contents.id),
      trustedUrl: location.href,
    })
    contents.once("destroyed", () => {
      this.conversations.releaseOwner(contents.id)
      this.invalidateOwner(contents.id)
      this.owners.delete(contents.id)
    })
  }
  isOwner(ownerId: number): boolean {
    const owner = this.owners.get(ownerId)
    if (!owner || owner.contents.isDestroyed()) return false
    try {
      const url = new URL(owner.contents.getURL())
      url.hash = ""
      return url.href === owner.trustedUrl
    } catch {
      return false
    }
  }
  invalidateOwner(ownerId: number): void {
    const owner = this.owners.get(ownerId)
    const sessionId = this.dependencies.getOwnerSessionId(ownerId)
    this.conversations.retainSession(ownerId, sessionId)
    if (owner && owner.sessionId !== sessionId) {
      owner.sessionEpoch++
      owner.sessionId = sessionId
    }
    if (owner) owner.epoch++
    for (const [id, mount] of this.mounts)
      if (mount.scope.ownerId === ownerId) this.mounts.delete(id)
    this.dependencies.documents.revokeOwner(ownerId)
  }
  invalidateConnection(): void {
    this.generation++
    this.client = undefined
    for (const ownerId of this.owners.keys()) {
      this.conversations.releaseOwner(ownerId)
      this.invalidateOwner(ownerId)
    }
  }
  observeSession(ownerId: number, view: DesktopSessionView): void {
    const owner = this.owners.get(ownerId)
    if (!owner) return
    this.conversations.observe(ownerId, view)
    const sources = new Set(
      view.parts.flatMap((part) => {
        const instance = readPluginUiInstance(part.metadata)
        return instance && instance.sourcePartId === part.id ? [instance.instanceId] : []
      })
    )
    const generation = view.session.metadata.pluginUiGeneration
    if (
      view.syncStatus !== "connected" ||
      view.session.status === "archived" ||
      view.session.status === "closing" ||
      (owner.view &&
        (owner.view.sessionId !== view.session.id ||
          owner.view.generation !== generation ||
          [...owner.view.sources].some((id) => !sources.has(id))))
    )
      this.invalidateOwner(ownerId)
    owner.view = { sessionId: view.session.id, generation, sources }
  }
  dispose(): void {
    this.invalidateConnection()
    this.owners.clear()
  }
  async capabilities(ownerId: number): Promise<{ available: boolean }> {
    const owner = this.owners.get(ownerId)
    if (!owner || !this.isOwner(ownerId) || !this.dependencies.localAvailable(owner.contents))
      return { available: false }
    const generation = this.generation
    try {
      const client = await this.dependencies.getClient()
      const caps = await client.protocol.capabilities()
      return {
        available:
          generation === this.generation &&
          this.owners.get(ownerId) === owner &&
          this.isOwner(ownerId) &&
          caps.features.pluginUi === 2 &&
          caps.features.pluginUiLifecycle === 1,
      }
    } catch {
      return { available: false }
    }
  }
  private check(scope: Scope): void {
    if (
      this.generation !== scope.generation ||
      this.owners.get(scope.ownerId) !== scope.owner ||
      scope.owner.epoch !== scope.epoch ||
      !this.isOwner(scope.ownerId) ||
      this.dependencies.getOwnerSessionId(scope.ownerId) !== scope.sessionId ||
      this.client !== scope.client
    )
      fail("plugin_ui_mount_closed")
  }
  private async capture(ownerId: number, sessionId: string): Promise<Scope> {
    const owner = this.owners.get(ownerId)
    if (
      !owner ||
      !this.isOwner(ownerId) ||
      this.dependencies.getOwnerSessionId(ownerId) !== sessionId
    )
      fail("plugin_ui_mount_closed")
    const epoch = owner!.epoch
    const generation = this.generation
    const client = await this.dependencies.getClient()
    if (
      generation !== this.generation ||
      owner!.epoch !== epoch ||
      this.owners.get(ownerId) !== owner ||
      this.dependencies.getOwnerSessionId(ownerId) !== sessionId
    )
      fail("plugin_ui_mount_closed")
    if (this.client && this.client !== client) {
      this.invalidateConnection()
      fail("plugin_ui_mount_closed")
    }
    this.client = client
    return {
      ownerId,
      owner: owner!,
      epoch,
      sessionEpoch: owner!.sessionEpoch,
      generation,
      sessionId,
      client,
    }
  }
  private async state(
    scope: Scope,
    instanceId: string,
    surface: PluginUiSurface = "tool-result"
  ): Promise<
    PluginUiHostState & { source: PluginUiInstanceRecord; sourceSessionGeneration: unknown }
  > {
    const [response, session, caps] = await Promise.all([
      scope.client.pluginUi.get(scope.sessionId, instanceId),
      scope.client.sessions.getState(scope.sessionId),
      scope.client.protocol.capabilities(),
    ])
    this.check(scope)
    const instance = readPluginUiInstance({ pluginUi: response.instance })
    if (!instance || instance.instanceId !== instanceId || instance.sessionId !== scope.sessionId)
      fail("plugin_ui_invalid_message")
    const actual = instance!
    if (
      !response.conversation ||
      Object.keys(response.conversation).length !== 2 ||
      typeof response.conversation.draft !== "boolean" ||
      typeof response.conversation.submit !== "boolean"
    )
      fail("plugin_ui_invalid_message")
    const busy = session.runs.some((run) => run.status === "pending" || run.status === "running")
    const snapshot: PluginUiHostState["snapshot"] = {
      instanceId,
      revision: actual.revision,
      status: actual.status,
      data: actual.data,
      actions: response.actions.map((action) => ({
        id: action.id,
        label: action.label,
        completion: action.completion,
      })),
      readOnly:
        !response.availability.canInvoke ||
        actual.status !== "open" ||
        busy ||
        session.session.status === "archived",
      locale: "zh-CN",
      surface: actual.surface,
    }
    for (const [runId, active] of [
      [actual.activeActionRunId, true],
      [actual.lastActionRunId, false],
    ] as const) {
      const run = runId ? session.runs.find((item) => item.id === runId) : undefined
      const metadata = run && readPluginUiAction(run.metadata)
      if (!run || !metadata || metadata.instanceId !== instanceId) continue
      const receipt = parsePluginUiBridgeReceipt({
        requestId: metadata.requestId,
        runId: run.id,
        instanceId,
        revision: actual.revision,
        status: run.status,
      })
      if (active) snapshot.activeAction = receipt
      else {
        const messageIds = new Set(
          session.messages
            .filter((message) => message.runId === run.id)
            .map((message) => message.id)
        )
        const part = session.parts.find(
          (item) => messageIds.has(item.messageId) && item.type === "tool"
        )
        const result = part?.output as
          { content?: Array<{ type?: string; text?: string }> } | undefined
        const texts = Array.isArray(result?.content)
          ? result.content
              .filter((item) => item.type === "text" && typeof item.text === "string")
              .map((item) => item.text)
              .join("\n")
          : ""
        const prefix =
          metadata.executionState === "unknown"
            ? "结果不确定。"
            : run.status === "failed"
              ? "操作失败。"
              : ""
        snapshot.lastAction = {
          receipt,
          executionState: metadata.executionState,
          message: [
            ...(prefix + (texts || (run.status === "completed" ? "操作完成。" : "操作未完成。"))),
          ]
            .slice(0, 1024)
            .join(""),
        }
      }
    }
    return {
      source: actual,
      sourceSessionGeneration: session.session.metadata.pluginUiGeneration,
      snapshot,
      plugin: { id: actual.pluginId, version: actual.pluginVersion },
      title: actual.title,
      conversation:
        caps.features.pluginUi === 2 &&
        caps.features.pluginUiLifecycle === 1 &&
        caps.features.pluginUiConversation === 1
          ? structuredClone(response.conversation)
          : { draft: false, submit: false },
      availability: response.availability,
      actions: response.actions.map(({ id, label, toolName, completion }) => ({
        id,
        label,
        toolName,
        completion,
      })),
    }
  }
  async getState(ownerId: number, value: unknown): Promise<PluginUiHostState> {
    try {
      const t = target(input(value, ["sessionId", "instanceId"]))
      const {
        source: _source,
        sourceSessionGeneration: _generation,
        ...state
      } = await this.state(await this.capture(ownerId, t.sessionId), t.instanceId)
      return state
    } catch (error) {
      return safe(error)
    }
  }
  async mount(ownerId: number, value: unknown): Promise<DesktopPluginUiMountResult> {
    const attempt = Symbol()
    let slots: string[] = []
    try {
      const r = input(value, ["sessionId", "instanceId", "surface"])
      const t = target(r)
      if (r.surface !== "tool-result" && r.surface !== "session-sidebar")
        fail("plugin_ui_invalid_message")
      // Only a newer request for this same instance retires a pending load.
      // Distinct instances compete for capacity when their verified documents register.
      slots = [ownerId + ":" + t.instanceId]
      for (const slot of slots) this.opening.set(slot, attempt)
      const scope = await this.capture(ownerId, t.sessionId)
      if (!this.dependencies.localAvailable(scope.owner.contents)) fail("plugin_ui_unavailable")
      const caps = await scope.client.protocol.capabilities()
      this.check(scope)
      if (caps.features.pluginUi !== 2 || caps.features.pluginUiLifecycle !== 1)
        fail("plugin_ui_protocol_mismatch")
      const { source, sourceSessionGeneration, ...state } = await this.state(
        scope,
        t.instanceId,
        r.surface as PluginUiSurface
      )
      if (source.surface !== r.surface) fail("plugin_ui_surface_not_supported")
      if (!state.availability.canRender) fail("plugin_ui_unavailable")
      for (const [mountId, mount] of this.mounts) {
        if (
          mount.scope.ownerId === ownerId &&
          mount.instanceId === t.instanceId &&
          this.dependencies.documents.owns(mountId, ownerId, scope.client)
        ) {
          this.check(mount.scope)
          if (
            mount.surface !== source.surface ||
            mount.componentDigest !== source.componentDigest ||
            mount.sessionGeneration !== sourceSessionGeneration
          )
            fail("plugin_ui_snapshot_changed")
          return { mountId, url: "vykor-plugin-ui://frame/" + mountId, state }
        }
      }
      const response = await scope.client.pluginUi.getDocument(t.sessionId, t.instanceId)
      this.check(scope)
      const {
        source: after,
        sourceSessionGeneration: afterGeneration,
        ...latestState
      } = await this.state(scope, t.instanceId, r.surface as PluginUiSurface)
      this.check(scope)
      if (
        !after ||
        afterGeneration !== sourceSessionGeneration ||
        !latestState.availability.canRender ||
        after.sessionId !== t.sessionId ||
        after.instanceId !== t.instanceId ||
        after.surface !== source.surface ||
        after.componentDigest !== source.componentDigest ||
        after.pluginDigest !== source.pluginDigest ||
        after.pluginVersion !== source.pluginVersion ||
        after.sourcePartId !== source.sourcePartId
      )
        fail("plugin_ui_snapshot_changed")
      if (slots.some((slot) => this.opening.get(slot) !== attempt)) fail("plugin_ui_mount_closed")
      const mounted = this.dependencies.documents.register({
        ownerId,
        connection: scope.client,
        ...t,
        componentDigest: after.componentDigest,
        surface: r.surface as PluginUiSurface,
        html: response.html,
        sha256: response.sha256,
      })
      for (const [id, old] of this.mounts) {
        if (!this.dependencies.documents.owns(id, old.scope.ownerId, old.scope.client))
          this.mounts.delete(id)
      }
      this.mounts.set(mounted.mountId, {
        scope,
        instanceId: t.instanceId,
        surface: r.surface as PluginUiSurface,
        componentDigest: after.componentDigest,
        sessionGeneration: afterGeneration,
      })
      return { mountId: mounted.mountId, url: mounted.url, state: latestState }
    } catch (error) {
      return safe(error)
    } finally {
      for (const slot of slots) if (this.opening.get(slot) === attempt) this.opening.delete(slot)
    }
  }
  private getMount(ownerId: number, mountId: unknown): Mount {
    if (!uuid(mountId)) fail("plugin_ui_invalid_message")
    const mount = this.mounts.get(mountId as string)
    if (
      !mount ||
      mount.scope.ownerId !== ownerId ||
      !this.dependencies.documents.owns(mountId as string, ownerId, mount.scope.client)
    )
      fail("plugin_ui_mount_closed")
    this.check(mount!.scope)
    return mount!
  }
  private checkConversationBinding(binding: ConversationBinding): void {
    if (
      binding.generation !== this.generation ||
      this.owners.get(binding.ownerId) !== binding.owner ||
      this.owners.get(binding.ownerId)?.sessionEpoch !== binding.sessionEpoch ||
      !this.isOwner(binding.ownerId) ||
      this.dependencies.getOwnerSessionId(binding.ownerId) !== binding.sessionId ||
      this.client !== binding.client
    ) {
      this.conversations.release(binding)
      fail("plugin_ui_mount_closed")
    }
  }
  private async conversationMount(ownerId: number, mountId: unknown, value: unknown) {
    const mount = this.getMount(ownerId, mountId)
    parsePluginUiBridgeRequest({
      version: 2,
      mountId,
      id: "ipc",
      method: "requestConversation",
      params: value,
    })
    const owned = parsePluginUiConversationRequest(value)
    const caps = await mount.scope.client.protocol.capabilities()
    this.getMount(ownerId, mountId)
    if (
      caps.features.pluginUi !== 2 ||
      caps.features.pluginUiLifecycle !== 1 ||
      caps.features.pluginUiConversation !== 1
    )
      fail("plugin_ui_protocol_mismatch")
    const current = await this.state(mount.scope, mount.instanceId, mount.surface)
    if (
      current.sourceSessionGeneration !== mount.sessionGeneration ||
      current.source.componentDigest !== mount.componentDigest
    )
      fail("plugin_ui_mount_closed")
    if (!current.conversation[owned.mode]) fail("plugin_ui_conversation_unavailable")
    if (current.snapshot.revision !== owned.expectedRevision) fail("plugin_ui_revision_conflict")
    this.getMount(ownerId, mountId)
    return { mount, owned, source: current.source }
  }
  async prepareConversation(ownerId: number, value: unknown) {
    try {
      const r = input(value, ["mountId", "input"])
      const { mount, owned } = await this.conversationMount(ownerId, r.mountId, r.input)
      const prepared = parsePluginUiConversationPrepared(
        await mount.scope.client.pluginUi.prepareConversation(
          mount.scope.sessionId,
          mount.instanceId,
          owned
        )
      )
      this.getMount(ownerId, r.mountId)
      if (
        prepared.mode !== owned.mode ||
        prepared.instanceId !== mount.instanceId ||
        prepared.revision !== owned.expectedRevision
      )
        fail("plugin_ui_invalid_message")
      return prepared
    } catch (error) {
      return safe(error)
    }
  }
  async submitConversation(ownerId: number, value: unknown) {
    try {
      const r = input(value, ["mountId", "requestId", "input"])
      if (!uuid(r.requestId)) fail("plugin_ui_invalid_message")
      const raw = input(r.input, ["expectedRevision", "text", "data"])
      const { mount, owned, source } = await this.conversationMount(ownerId, r.mountId, {
        mode: "submit",
        ...raw,
      })
      // bind is synchronous and precedes the first network POST, even if its response is lost.
      const pending = this.conversations.bind(mount.scope, source, r.requestId as string, owned)
      const { mode: _mode, ...payload } = owned
      const receipt = await mount.scope.client.pluginUi.submitConversation(
        mount.scope.sessionId,
        mount.instanceId,
        { requestId: pending.requestId, ...payload }
      )
      this.checkConversationBinding(pending)
      return this.conversations.receipt(pending, receipt)
    } catch (error) {
      return safe(error)
    }
  }
  async getConversationSubmission(ownerId: number, value: unknown) {
    try {
      const r = input(value, ["requestId"])
      if (!uuid(r.requestId)) fail("plugin_ui_invalid_message")
      const pending = this.conversations.get(ownerId, r.requestId as string)
      this.checkConversationBinding(pending)
      const client = await this.dependencies.getClient()
      this.checkConversationBinding(pending)
      if (client !== pending.client) {
        this.invalidateConnection()
        fail("plugin_ui_mount_closed")
      }
      const receipt = await client.pluginUi.getConversationSubmission(
        pending.sessionId,
        pending.instanceId,
        pending.requestId
      )
      this.checkConversationBinding(pending)
      return this.conversations.receipt(pending, receipt)
    } catch (error) {
      return safe(error)
    }
  }
  async invokeAction(ownerId: number, value: unknown) {
    try {
      const r = input(value, ["mountId", "input"])
      const mount = this.getMount(ownerId, r.mountId)
      const action = input(r.input, ["requestId", "expectedRevision", "actionId", "args"])
      if (!uuid(action.requestId)) fail("plugin_ui_invalid_message")
      parsePluginUiBridgeRequest({
        version: 2,
        mountId: r.mountId,
        id: "ipc",
        method: "requestAction",
        params: {
          actionId: action.actionId,
          expectedRevision: action.expectedRevision,
          args: action.args,
        },
      })
      const owned = structuredClone(action) as unknown as InvokePluginUiActionInput
      const current = await this.state(mount.scope, mount.instanceId, mount.surface)
      if (
        current.sourceSessionGeneration !== mount.sessionGeneration ||
        current.source.componentDigest !== mount.componentDigest
      )
        fail("plugin_ui_mount_closed")
      if (current.snapshot.readOnly) fail("plugin_ui_read_only")
      if (!current.actions.some((item) => item.id === owned.actionId))
        fail("plugin_ui_invalid_action")
      this.getMount(ownerId, r.mountId)
      return await mount.scope.client.pluginUi.invokeAction(
        mount.scope.sessionId,
        mount.instanceId,
        owned
      )
    } catch (error) {
      return safe(error)
    }
  }
  async getAction(ownerId: number, value: unknown) {
    try {
      const r = input(value, ["mountId", "requestId"])
      const mount = this.getMount(ownerId, r.mountId)
      if (!uuid(r.requestId)) fail("plugin_ui_invalid_message")
      const result = await mount.scope.client.pluginUi.getAction(
        mount.scope.sessionId,
        mount.instanceId,
        r.requestId as string
      )
      this.getMount(ownerId, r.mountId)
      return parsePluginUiBridgeReceipt(result.receipt)
    } catch (error) {
      return safe(error)
    }
  }
  async dismiss(ownerId: number, value: unknown): Promise<PluginUiInstanceRecord> {
    try {
      const r = input(value, ["sessionId", "instanceId", "input"])
      const t = target(r)
      const dismissal = input(r.input, ["requestId", "expectedRevision"])
      if (
        !uuid(dismissal.requestId) ||
        !Number.isSafeInteger(dismissal.expectedRevision) ||
        (dismissal.expectedRevision as number) < 0
      )
        fail("plugin_ui_invalid_message")
      const owned = structuredClone(dismissal) as unknown as DismissPluginUiInput
      const scope = await this.capture(ownerId, t.sessionId)
      this.check(scope)
      return await scope.client.pluginUi.dismiss(t.sessionId, t.instanceId, owned)
    } catch (error) {
      return safe(error)
    }
  }
  unmount(ownerId: number, value: unknown): void {
    const r = input(value, ["mountId"])
    const mount = this.mounts.get(String(r.mountId))
    if (mount && mount.scope.ownerId !== ownerId) fail("plugin_ui_mount_closed")
    if (mount) {
      this.mounts.delete(r.mountId as string)
      this.dependencies.documents.revoke(r.mountId as string)
    }
  }
}
