import type { WebContents } from "electron";
import {
  VykorApiError, PluginUiBridgeError, parsePluginUiBridgeRequest, parsePluginUiBridgeSnapshot,
  parsePluginUiBridgeReceipt, readPluginUiAction, readPluginUiInstance,
  type VykorClient, type PluginUiInstanceRecord, type InvokePluginUiActionInput,
  type DismissPluginUiInput, type PluginUiSurface, type PluginUiViewSnapshot,
} from "@vykor/client";
import type { DesktopPluginUiMountResult, PluginUiHostState } from "../../../shared/plugin-ui-types";
import type { DesktopSessionView } from "../../../shared/session-types";
import { PluginUiDocumentStore } from "./document-store";

interface Dependencies {
  documents: PluginUiDocumentStore;
  getClient(): Promise<VykorClient>;
  getOwnerSessionId(ownerId: number): string | undefined;
  localAvailable(owner: WebContents): boolean;
}
interface Owner { contents: WebContents; epoch: number; trustedUrl: string; view?: { sessionId: string; generation: unknown; sources: Set<string> } }
interface Scope { ownerId: number; owner: Owner; epoch: number; generation: number; sessionId: string; client: VykorClient }
interface Mount { scope: Scope; instanceId: string; surface: PluginUiSurface; componentDigest: string; sessionGeneration: unknown }
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = (code: string): never => { throw new PluginUiBridgeError(code); };
function input(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PluginUiBridgeError("plugin_ui_invalid_message");
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== fields.length || !fields.every(key => Object.hasOwn(r, key)))
    throw new PluginUiBridgeError("plugin_ui_invalid_message");
  try {
    if (JSON.stringify(r).length > 65_536 || new TextEncoder().encode(JSON.stringify(r)).byteLength > 65_536)
      throw new PluginUiBridgeError("plugin_ui_payload_too_large");
  } catch (error) {
    if (error instanceof PluginUiBridgeError) throw error;
    throw new PluginUiBridgeError("plugin_ui_invalid_message");
  }
  return r;
}
function target(r: Record<string, unknown>): { sessionId: string; instanceId: string } {
  if (typeof r.sessionId !== "string" || !r.sessionId || !uuid(r.instanceId)) fail("plugin_ui_invalid_message");
  return { sessionId: r.sessionId as string, instanceId: r.instanceId as string };
}
function safe(error: unknown): never {
  if (error instanceof PluginUiBridgeError) throw error;
  if (error instanceof VykorApiError && error.body && typeof error.body === "object") {
    const code = (error.body as { code?: unknown }).code;
    if (typeof code === "string" && /^plugin_ui_[a-z0-9_]{1,60}$/.test(code)) fail(code);
  }
  return fail("plugin_ui_unavailable");
}

/** Only registered main-window owners may route finite calls to their current Client/session. */
export class DesktopPluginUiService {
  private readonly owners = new Map<number, Owner>();
  private readonly mounts = new Map<string, Mount>();
  private generation = 0;
  private client?: VykorClient;
  constructor(private readonly dependencies: Dependencies) {}
  registerOwner(contents: WebContents, trustedUrl: string): void {
    if (this.owners.has(contents.id)) return;
    const location = new URL(trustedUrl); location.hash = "";
    this.owners.set(contents.id, { contents, epoch: 0, trustedUrl: location.href });
    contents.once("destroyed", () => {
      this.invalidateOwner(contents.id); this.owners.delete(contents.id);
    });
  }
  isOwner(ownerId: number): boolean {
    const owner = this.owners.get(ownerId);
    if (!owner || owner.contents.isDestroyed()) return false;
    try { const url = new URL(owner.contents.getURL()); url.hash = ""; return url.href === owner.trustedUrl; }
    catch { return false; }
  }
  invalidateOwner(ownerId: number): void {
    const owner = this.owners.get(ownerId);
    if (owner) owner.epoch++;
    for (const [id, mount] of this.mounts) if (mount.scope.ownerId === ownerId) this.mounts.delete(id);
    this.dependencies.documents.revokeOwner(ownerId);
  }
  invalidateConnection(): void {
    this.generation++; this.client = undefined;
    for (const ownerId of this.owners.keys()) this.invalidateOwner(ownerId);
  }
  observeSession(ownerId: number, view: DesktopSessionView): void {
    const owner = this.owners.get(ownerId);
    if (!owner) return;
    const sources = new Set(view.parts.flatMap(part => {
      const instance = readPluginUiInstance(part.metadata);
      return instance && instance.sourcePartId === part.id ? [instance.instanceId] : [];
    }));
    const generation = view.session.metadata.pluginUiGeneration;
    if (view.syncStatus !== "connected" || view.session.status === "archived" || view.session.status === "closing"
      || owner.view && (owner.view.sessionId !== view.session.id || owner.view.generation !== generation
        || [...owner.view.sources].some(id => !sources.has(id)))) this.invalidateOwner(ownerId);
    owner.view = { sessionId: view.session.id, generation, sources };
  }
  dispose(): void { this.invalidateConnection(); this.owners.clear(); }
  async capabilities(ownerId: number): Promise<{ available: boolean }> {
    const owner = this.owners.get(ownerId);
    if (!owner || !this.isOwner(ownerId) || !this.dependencies.localAvailable(owner.contents)) return { available: false };
    const generation = this.generation;
    try {
      const client = await this.dependencies.getClient();
      const caps = await client.protocol.capabilities();
      return { available: generation === this.generation && this.owners.get(ownerId) === owner && this.isOwner(ownerId) &&
        caps.features.pluginUi === 1 && caps.features.pluginUiLifecycle === 1 };
    } catch { return { available: false }; }
  }
  private check(scope: Scope): void {
    if (this.generation !== scope.generation || this.owners.get(scope.ownerId) !== scope.owner
      || scope.owner.epoch !== scope.epoch || !this.isOwner(scope.ownerId)
      || this.dependencies.getOwnerSessionId(scope.ownerId) !== scope.sessionId || this.client !== scope.client)
      fail("plugin_ui_mount_closed");
  }
  private async capture(ownerId: number, sessionId: string): Promise<Scope> {
    const owner = this.owners.get(ownerId);
    if (!owner || !this.isOwner(ownerId) || this.dependencies.getOwnerSessionId(ownerId) !== sessionId)
      fail("plugin_ui_mount_closed");
    const epoch = owner!.epoch; const generation = this.generation;
    const client = await this.dependencies.getClient();
    if (generation !== this.generation || owner!.epoch !== epoch || this.owners.get(ownerId) !== owner
      || this.dependencies.getOwnerSessionId(ownerId) !== sessionId) fail("plugin_ui_mount_closed");
    if (this.client && this.client !== client) { this.invalidateConnection(); fail("plugin_ui_mount_closed"); }
    this.client = client;
    return { ownerId, owner: owner!, epoch, generation, sessionId, client };
  }
  private async state(scope: Scope, instanceId: string, surface: PluginUiSurface = "tool-result"): Promise<PluginUiHostState & { source: PluginUiInstanceRecord; sourceSessionGeneration: unknown }> {
    const [response, session] = await Promise.all([
      scope.client.pluginUi.get(scope.sessionId, instanceId), scope.client.sessions.getState(scope.sessionId),
    ]);
    this.check(scope);
    const instance = readPluginUiInstance({ pluginUi: response.instance });
    if (!instance || instance.instanceId !== instanceId || instance.sessionId !== scope.sessionId) fail("plugin_ui_invalid_message");
    const actual = instance!;
    const busy = session.runs.some(run => run.status === "pending" || run.status === "running");
    const snapshot: PluginUiViewSnapshot = {
      instanceId, revision: actual.revision, status: actual.status, data: actual.data,
      actions: response.actions.map(action => ({ id: action.id, label: action.label, completion: action.completion })),
      readOnly: !response.availability.canInvoke || actual.status !== "open" || busy || session.session.status === "archived",
      theme: "light", locale: "zh-CN", surface,
    };
    for (const [runId, active] of [[actual.activeActionRunId, true], [actual.lastActionRunId, false]] as const) {
      const run = runId ? session.runs.find(item => item.id === runId) : undefined;
      const metadata = run && readPluginUiAction(run.metadata);
      if (!run || !metadata || metadata.instanceId !== instanceId) continue;
      const receipt = parsePluginUiBridgeReceipt({ requestId: metadata.requestId, runId: run.id, instanceId,
        revision: actual.revision, status: run.status });
      if (active) snapshot.activeAction = receipt;
      else {
        const messageIds = new Set(session.messages.filter(message => message.runId === run.id).map(message => message.id));
        const part = session.parts.find(item => messageIds.has(item.messageId) && item.type === "tool");
        const result = part?.output as { content?: Array<{ type?: string; text?: string }> } | undefined;
        const texts = Array.isArray(result?.content) ? result.content.filter(item => item.type === "text" && typeof item.text === "string")
          .map(item => item.text).join("\n") : "";
        const prefix = metadata.executionState === "unknown" ? "结果不确定。" : run.status === "failed" ? "操作失败。" : "";
        snapshot.lastAction = { receipt, executionState: metadata.executionState,
          message: [...(prefix + (texts || (run.status === "completed" ? "操作完成。" : "操作未完成。")))].slice(0, 1024).join("") };
      }
    }
    return {
      source: actual, sourceSessionGeneration: session.session.metadata.pluginUiGeneration,
      snapshot: parsePluginUiBridgeSnapshot(snapshot), plugin: { id: actual.pluginId, version: actual.pluginVersion },
      title: actual.title, surfaces: actual.surfaces, availability: response.availability,
      actions: response.actions.map(({ id, label, toolName, completion }) => ({ id, label, toolName, completion })),
    };
  }
  async getState(ownerId: number, value: unknown): Promise<PluginUiHostState> {
    try {
      const t = target(input(value, ["sessionId", "instanceId"]));
      const { source: _source, sourceSessionGeneration: _generation, ...state } = await this.state(await this.capture(ownerId, t.sessionId), t.instanceId);
      return state;
    }
    catch (error) { return safe(error); }
  }
  async mount(ownerId: number, value: unknown): Promise<DesktopPluginUiMountResult> {
    try {
      const r = input(value, ["sessionId", "instanceId", "surface"]); const t = target(r);
      if (r.surface !== "tool-result" && r.surface !== "session-sidebar") fail("plugin_ui_invalid_message");
      const scope = await this.capture(ownerId, t.sessionId);
      if (!this.dependencies.localAvailable(scope.owner.contents)) fail("plugin_ui_unavailable");
      const caps = await scope.client.protocol.capabilities(); this.check(scope);
      if (caps.features.pluginUi !== 1 || caps.features.pluginUiLifecycle !== 1) fail("plugin_ui_unavailable");
      const { source, sourceSessionGeneration, ...state } = await this.state(scope, t.instanceId, r.surface as PluginUiSurface);
      if (!state.availability.canRender || !state.surfaces.includes(r.surface as PluginUiSurface)) fail("plugin_ui_unavailable");
      const response = await scope.client.pluginUi.getDocument(t.sessionId, t.instanceId); this.check(scope);
      const { source: after, sourceSessionGeneration: afterGeneration, ...latestState } = await this.state(scope, t.instanceId, r.surface as PluginUiSurface);
      this.check(scope);
      if (!after || afterGeneration !== sourceSessionGeneration || !latestState.availability.canRender || after.sessionId !== t.sessionId || after.instanceId !== t.instanceId
        || after.componentDigest !== source.componentDigest || after.pluginDigest !== source.pluginDigest
        || after.pluginVersion !== source.pluginVersion || after.sourcePartId !== source.sourcePartId)
        fail("plugin_ui_snapshot_changed");
      const mounted = this.dependencies.documents.register({ ownerId, connection: scope.client, ...t,
        componentDigest: after.componentDigest, surface: r.surface as PluginUiSurface,
        html: response.html, sha256: response.sha256 });
      for (const [id, old] of this.mounts) {
        if (!this.dependencies.documents.owns(id, old.scope.ownerId, old.scope.client)) this.mounts.delete(id);
      }
      this.mounts.set(mounted.mountId, { scope, instanceId: t.instanceId, surface: r.surface as PluginUiSurface,
        componentDigest: after.componentDigest, sessionGeneration: afterGeneration });
      return { mountId: mounted.mountId, url: mounted.url, state: latestState };
    } catch (error) { return safe(error); }
  }
  private getMount(ownerId: number, mountId: unknown): Mount {
    if (!uuid(mountId)) fail("plugin_ui_invalid_message");
    const mount = this.mounts.get(mountId as string);
    if (!mount || mount.scope.ownerId !== ownerId || !this.dependencies.documents.owns(mountId as string, ownerId, mount.scope.client))
      fail("plugin_ui_mount_closed");
    this.check(mount!.scope); return mount!;
  }
  async invokeAction(ownerId: number, value: unknown) {
    try {
      const r = input(value, ["mountId", "input"]); const mount = this.getMount(ownerId, r.mountId);
      const action = input(r.input, ["requestId", "expectedRevision", "actionId", "args"]);
      if (!uuid(action.requestId)) fail("plugin_ui_invalid_message");
      parsePluginUiBridgeRequest({ version: 1, mountId: r.mountId, id: "ipc", method: "requestAction",
        params: { actionId: action.actionId, expectedRevision: action.expectedRevision, args: action.args } });
      const owned = structuredClone(action) as unknown as InvokePluginUiActionInput;
      const current = await this.state(mount.scope, mount.instanceId, mount.surface);
      if (current.sourceSessionGeneration !== mount.sessionGeneration || current.source.componentDigest !== mount.componentDigest)
        fail("plugin_ui_mount_closed");
      if (current.snapshot.readOnly) fail("plugin_ui_read_only");
      if (!current.actions.some(item => item.id === owned.actionId)) fail("plugin_ui_invalid_action");
      this.getMount(ownerId, r.mountId);
      return await mount.scope.client.pluginUi.invokeAction(mount.scope.sessionId, mount.instanceId, owned);
    } catch (error) { return safe(error); }
  }
  async getAction(ownerId: number, value: unknown) {
    try {
      const r = input(value, ["mountId", "requestId"]); const mount = this.getMount(ownerId, r.mountId);
      if (!uuid(r.requestId)) fail("plugin_ui_invalid_message");
      const result = await mount.scope.client.pluginUi.getAction(mount.scope.sessionId, mount.instanceId, r.requestId as string);
      this.getMount(ownerId, r.mountId); return parsePluginUiBridgeReceipt(result.receipt);
    } catch (error) { return safe(error); }
  }
  async dismiss(ownerId: number, value: unknown): Promise<PluginUiInstanceRecord> {
    try {
      const r = input(value, ["sessionId", "instanceId", "input"]); const t = target(r);
      const dismissal = input(r.input, ["requestId", "expectedRevision"]);
      if (!uuid(dismissal.requestId) || !Number.isSafeInteger(dismissal.expectedRevision) || (dismissal.expectedRevision as number) < 0)
        fail("plugin_ui_invalid_message");
      const owned = structuredClone(dismissal) as unknown as DismissPluginUiInput;
      const scope = await this.capture(ownerId, t.sessionId); this.check(scope);
      return await scope.client.pluginUi.dismiss(t.sessionId, t.instanceId, owned);
    } catch (error) { return safe(error); }
  }
  unmount(ownerId: number, value: unknown): void {
    const r = input(value, ["mountId"]); const mount = this.mounts.get(String(r.mountId));
    if (mount && mount.scope.ownerId !== ownerId) fail("plugin_ui_mount_closed");
    if (mount) { this.mounts.delete(r.mountId as string); this.dependencies.documents.revoke(r.mountId as string); }
  }
}
