import type { RunCapabilityView } from "../runtime/node-runtime-resources.js";
import type { NodeRunToolBinding as RunToolBinding } from "../runtime/node-runtime-resources.js";
import { randomUUID } from "node:crypto";

import type { PluginAppToolOrigin, PluginAppToolPolicy, PluginAppHostBinding, PluginAppRuntimeLease, PluginAppRuntimeSource, PluginAppHostInvocation, PluginAppToolDescriptor } from "@vykor/plugin-contracts/runtime";
import { copyPluginAppJson } from "@vykor/plugin-contracts/runtime-data";
import { capturedAppToolPolicy } from "./policy.js";
import type { CapturedPluginAppBackend, PluginAppBackendCatalogue, PluginAppBackendPort } from "./plugin-app-backends.js";
import { readonlyMap, readonlySet } from "../plugins/run-capability-view.js";

export interface PluginAppRuntimeFacts {
  enabled: boolean; renderApproved: boolean; invokeApproved: boolean;
  snapshot: "valid" | "missing" | "changed";
  resourceAvailable: boolean; toolsAvailable: boolean; backendGeneration?: string;
  isCurrent(): boolean;
}
/** The host can inspect resources and opaque credentials, never executable captures. */
export interface PluginAppRuntimeHost {
  list(): Array<{ pluginId: string; pluginVersion: string; pluginDigest: string; definitionDigest: string;
    backendId: string; backendKind: PluginAppHostBinding["backendKind"]; surfaces: CapturedPluginAppBackend["surfaces"] }>;
  refresh(app: PluginAppHostBinding): Promise<PluginAppRuntimeFacts>;
  issue(app: PluginAppHostBinding, generation: string): PluginAppRuntimeLease;
  validate(app: PluginAppHostBinding, lease: PluginAppRuntimeLease, generation: string): boolean;
  revoke(source: PluginAppRuntimeSource): void;
  clear(): void;
  resource(app: PluginAppHostBinding, lease: PluginAppRuntimeLease): PluginAppBackendPort;
  assertTool(invocation: PluginAppHostInvocation): Promise<string>;
  prepareTool(invocation: PluginAppHostInvocation): Promise<{ name: string; policy: PluginAppToolPolicy }>;
  listTools(app: PluginAppHostBinding, lease: PluginAppRuntimeLease): PluginAppToolDescriptor[];
  resolveOrigin(origin: PluginAppToolOrigin): Promise<ReturnType<PluginAppRuntimeHost["list"]>[number] | undefined>;
}

function identity(app: PluginAppHostBinding): string {
  return JSON.stringify([app.sessionId, app.instanceId, app.pluginId, app.pluginVersion, app.pluginDigest,
    app.definitionDigest, app.backendId, app.backendKind, app.resourceUri, app.agentId]);
}
function matches(app: PluginAppHostBinding, capture: CapturedPluginAppBackend): boolean {
  return app.pluginId === capture.pluginId && app.pluginVersion === capture.pluginVersion
    && app.pluginDigest === capture.pluginDigest && app.definitionDigest === capture.definitionDigest
    && app.backendId === capture.definition.id && app.backendKind === capture.definition.kind
    && (capture.surfaces.some(s => s.resourceUri === app.resourceUri)
      || (capture.definition.kind === "native-tools" && capture.definition.resources.some(r => r.uri === app.resourceUri))
      || [...(capture.originTools ?? capture.tools).values()].some(t => t.definition.ui?.resourceUri === app.resourceUri));
}
function sameCapture(a: CapturedPluginAppBackend, b: CapturedPluginAppBackend): boolean {
  return a.port.isCurrent() && a.port.generation === b.port.generation && a.pluginDataWriteApproved === b.pluginDataWriteApproved && a.tools.size === b.tools.size
    && [...a.tools].every(([name, binding]) => {
      const next = b.tools.get(name);
      return !!next && next.definitionIdentity === binding.definitionIdentity && next.definition.execute === binding.definition.execute
        && next.ownerPluginId === binding.ownerPluginId && next.source?.id === binding.source?.id;
    });
}

/** Sole volatile lease authority. Captures remain the originals across fresh installation checks. */
export class PluginAppRuntime {
  #captures = new Map<string, { identity: string; capture: CapturedPluginAppBackend }>();
  #leases = new Map<string, { identity: string; capture: CapturedPluginAppBackend; lease: PluginAppRuntimeLease }>();
  readonly host: PluginAppRuntimeHost;
  constructor(private readonly sessionId: string, private readonly catalogue?: PluginAppBackendCatalogue) {
    this.host = Object.freeze({
      list: () => (catalogue?.list() ?? []).map(item => ({
        pluginId: item.pluginId, pluginVersion: item.pluginVersion, pluginDigest: item.pluginDigest,
        definitionDigest: item.definitionDigest, backendId: item.backend.id, backendKind: item.backend.kind, surfaces: item.surfaces,
      })),
      resolveOrigin: async (origin: PluginAppToolOrigin) => {
        const capture = await this.catalogue?.capture(origin.pluginId, origin.backendId);
        if (!capture || !capture.port.isCurrent() || capture.pluginVersion !== origin.pluginVersion || capture.pluginDigest !== origin.pluginDigest
          || capture.definitionDigest !== origin.definitionDigest || capture.definition.kind !== origin.backendKind
          || ![...(capture.originTools ?? capture.tools).values()].some(binding => binding.definition.name === origin.toolName && binding.definition.ui?.resourceUri === origin.resourceUri)) return undefined;
        return this.host.list().find(item => item.pluginId === origin.pluginId && item.backendId === origin.backendId);
      },
      refresh: (app: PluginAppHostBinding) => this.refresh(app),
      issue: (app: PluginAppHostBinding, generation: string) => this.issue(app, generation),
      validate: (app: PluginAppHostBinding, lease: PluginAppRuntimeLease, generation: string) => this.validate(app, lease, generation),
      revoke: (source: PluginAppRuntimeSource) => this.revoke(source),
      clear: () => { this.#captures.clear(); this.#leases.clear(); },
      resource: (app: PluginAppHostBinding, lease: PluginAppRuntimeLease) => this.require(app, lease).port,
      listTools: (app: PluginAppHostBinding, lease: PluginAppRuntimeLease) => {
        const capture = this.require(app, lease);
        return [...capture.tools].filter(([name]) => capture.isCurrentTool(name)).map(([name, tool]) => ({
          name, description: tool.definition.description, inputSchema: structuredClone(tool.definition.inputSchema), policy: capturedAppToolPolicy(capture, name),
        }));
      },
      assertTool: async (invocation: PluginAppHostInvocation) => {
        return (await this.host.prepareTool(invocation)).name;
      },
      prepareTool: async (invocation: PluginAppHostInvocation) => {
        const { binding: app } = invocation;
        await this.refresh(app);
        const tool = this.tool(invocation), capture = this.require(app, invocation.lease);
        const policy = capturedAppToolPolicy(capture, invocation.toolName);
        copyPluginAppJson(invocation.args, policy.maxArgumentsBytes);
        return { name: tool.definition.name, policy };
      },
    });
  }
  async toolOrigin(binding: RunToolBinding | undefined): Promise<PluginAppToolOrigin | undefined> {
    if (!binding?.ownerPluginId || !binding.definition.ui?.resourceUri) return;
    const candidates = this.catalogue?.list().filter(item => item.pluginId === binding.ownerPluginId) ?? [];
    const matches: PluginAppToolOrigin[] = [];
    for (const candidate of candidates) {
      const capture = await this.catalogue?.capture(candidate.pluginId, candidate.backend.id);
      const exact = capture && [...(capture.originTools ?? capture.tools).values()].find(tool => tool.definition.name === binding.definition.name
        && tool.definitionIdentity === binding.definitionIdentity && tool.definition.execute === binding.definition.execute
        && tool.source?.kind === binding.source?.kind && tool.source?.id === binding.source?.id);
      if (capture?.port.isCurrent() && exact?.definition.ui?.resourceUri) matches.push({ pluginId: capture.pluginId, pluginVersion: capture.pluginVersion,
        pluginDigest: capture.pluginDigest, definitionDigest: capture.definitionDigest, backendId: capture.definition.id, backendKind: capture.definition.kind,
        resourceUri: exact.definition.ui.resourceUri, toolName: exact.definition.name });
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
  private async refresh(app: PluginAppHostBinding): Promise<PluginAppRuntimeFacts> {
    const unavailable: PluginAppRuntimeFacts = { enabled: false, renderApproved: false, invokeApproved: false,
      snapshot: "missing", resourceAvailable: false, toolsAvailable: false, isCurrent: () => false };
    if (app.agentId !== this.sessionId || app.sessionId !== this.sessionId) return unavailable;
    let fresh: CapturedPluginAppBackend | undefined;
    try { fresh = await this.catalogue?.capture(app.pluginId, app.backendId); } catch { /* failed approval revokes */ }
    if (!fresh || !matches(app, fresh) || !fresh.port.isCurrent()) {
      this.revoke({ sessionId: app.sessionId, instanceId: app.instanceId }); return unavailable;
    }
    const prior = this.#captures.get(app.instanceId);
    const capture = prior?.identity === identity(app) && sameCapture(prior.capture, fresh) ? prior.capture : fresh;
    if (capture !== prior?.capture) this.#leases.delete(app.instanceId);
    this.#captures.set(app.instanceId, { identity: identity(app), capture });
    return { enabled: true, renderApproved: true, invokeApproved: true, snapshot: "valid",
      resourceAvailable: true, toolsAvailable: [...capture.tools.keys()].some(name => capture.isCurrentTool(name)),
      backendGeneration: capture.port.generation, isCurrent: () => capture.port.isCurrent() && this.#captures.get(app.instanceId)?.capture === capture };
  }
  private issue(app: PluginAppHostBinding, generation: string): PluginAppRuntimeLease {
    const current = this.#captures.get(app.instanceId);
    if (app.agentId !== this.sessionId || app.sessionId !== this.sessionId || current?.identity !== identity(app)
      || current.capture.port.generation !== generation || !current.capture.port.isCurrent()) throw new Error("plugin_app_stale_capture");
    let entry = this.#leases.get(app.instanceId);
    if (!entry || entry.identity !== current.identity || entry.capture !== current.capture) {
      entry = { ...current, lease: Object.freeze({ token: randomUUID(), backendGeneration: generation }) };
      this.#leases.set(app.instanceId, entry);
    }
    return { ...entry.lease };
  }
  private validate(app: PluginAppHostBinding, lease: PluginAppRuntimeLease, generation: string): boolean {
    const entry = this.#leases.get(app.instanceId), current = this.#captures.get(app.instanceId);
    return app.agentId === this.sessionId && app.sessionId === this.sessionId && !!entry && entry.identity === identity(app)
      && entry.capture === current?.capture && entry.lease.token === lease.token && entry.lease.backendGeneration === generation
      && lease.backendGeneration === generation && entry.capture.port.isCurrent();
  }
  private revoke(source: PluginAppRuntimeSource): void {
    if (source.sessionId !== this.sessionId) return;
    this.#captures.delete(source.instanceId); this.#leases.delete(source.instanceId);
  }
  private require(app: PluginAppHostBinding, lease: PluginAppRuntimeLease): CapturedPluginAppBackend {
    if (!this.validate(app, lease, lease.backendGeneration)) throw new Error("plugin_app_lease_invalid");
    return this.#leases.get(app.instanceId)!.capture;
  }
  private tool(invocation: PluginAppHostInvocation) {
    const capture = this.require(invocation.binding, invocation.lease), tool = capture.tools.get(invocation.toolName);
    if (!tool || !capture.isCurrentTool(invocation.toolName)) throw new Error("plugin_app_tool_unavailable");
    return tool;
  }
  async prepare(invocation: PluginAppHostInvocation, view: RunCapabilityView) {
    const app = invocation.binding;
    const prepared = await this.host.prepareTool(invocation);
    const tool = this.tool(invocation);
    const server = tool.serverId ? view.mcpServers.get(tool.serverId) : undefined;
    if (app.backendKind === "mcp-server" && (!server || server.ownerPluginId !== app.pluginId)) throw new Error("plugin_app_server_unavailable");
    const tools = readonlyMap([[tool.definition.name, tool]]);
    const capabilityView: RunCapabilityView = Object.freeze({ pluginId: app.pluginId, pluginIds: readonlySet([app.pluginId]),
      tools, appTools: tools, mcpServers: readonlyMap(server ? [[server.serverId, server]] : []),
      skills: readonlyMap<never>([]), agents: readonlyMap<never>([]) });
    return { ...prepared, capabilityView, binding: tool };
  }
}
