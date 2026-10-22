import type { RunCapabilityView } from "../runtime/node-runtime-resources.js";
import type { NodeRunToolBinding as RunToolBinding } from "../runtime/node-runtime-resources.js";
import { randomUUID } from "node:crypto";

import type { PluginAppToolOrigin } from "@vykor/protocol";
import { copyPluginAppJson, type PluginAppToolPolicy } from "@vykor/protocol";
import { capturedAppToolPolicy } from "./plugin-app-backends.js";
import type { PluginAppRecord, PluginAppRuntimeLease, PluginAppSource, PluginAppToolRequest, PluginAppToolDescriptor } from "@vykor/protocol";
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
    backendId: string; backendKind: PluginAppRecord["backendKind"]; surfaces: CapturedPluginAppBackend["surfaces"] }>;
  refresh(app: PluginAppRecord): Promise<PluginAppRuntimeFacts>;
  issue(app: PluginAppRecord, generation: string): PluginAppRuntimeLease;
  validate(app: PluginAppRecord, lease: PluginAppRuntimeLease, generation: string): boolean;
  revoke(source: PluginAppSource): void;
  clear(): void;
  resource(app: PluginAppRecord, lease: PluginAppRuntimeLease): PluginAppBackendPort;
  assertTool(app: PluginAppRecord, request: PluginAppToolRequest): Promise<string>;
  prepareTool(app: PluginAppRecord, request: PluginAppToolRequest): Promise<{ name: string; policy: PluginAppToolPolicy }>;
  listTools(app: PluginAppRecord, lease: PluginAppRuntimeLease): PluginAppToolDescriptor[];
  resolveOrigin(origin: PluginAppToolOrigin): Promise<ReturnType<PluginAppRuntimeHost["list"]>[number] | undefined>;
}

function identity(app: PluginAppRecord): string {
  return JSON.stringify([app.sessionId, app.id, app.pluginId, app.pluginVersion, app.pluginDigest,
    app.definitionDigest, app.backendId, app.backendKind, app.resourceUri, app.origin, app.logicalKey]);
}
function matches(app: PluginAppRecord, capture: CapturedPluginAppBackend): boolean {
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
      refresh: (app: PluginAppRecord) => this.refresh(app),
      issue: (app: PluginAppRecord, generation: string) => this.issue(app, generation),
      validate: (app: PluginAppRecord, lease: PluginAppRuntimeLease, generation: string) => this.validate(app, lease, generation),
      revoke: (source: PluginAppSource) => this.revoke(source),
      clear: () => { this.#captures.clear(); this.#leases.clear(); },
      resource: (app: PluginAppRecord, lease: PluginAppRuntimeLease) => this.require(app, lease).port,
      listTools: (app: PluginAppRecord, lease: PluginAppRuntimeLease) => {
        const capture = this.require(app, lease);
        return [...capture.tools].filter(([name]) => capture.isCurrentTool(name)).map(([name, tool]) => ({
          name, description: tool.definition.description, inputSchema: structuredClone(tool.definition.inputSchema), policy: capturedAppToolPolicy(capture, name),
        }));
      },
      assertTool: async (app: PluginAppRecord, request: PluginAppToolRequest) => {
        return (await this.host.prepareTool(app, request)).name;
      },
      prepareTool: async (app: PluginAppRecord, request: PluginAppToolRequest) => {
        await this.refresh(app);
        const tool = this.tool(app, request), capture = this.require(app, request.lease);
        const policy = capturedAppToolPolicy(capture, request.toolName);
        copyPluginAppJson(request.args, policy.maxArgumentsBytes);
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
  private async refresh(app: PluginAppRecord): Promise<PluginAppRuntimeFacts> {
    const unavailable: PluginAppRuntimeFacts = { enabled: false, renderApproved: false, invokeApproved: false,
      snapshot: "missing", resourceAvailable: false, toolsAvailable: false, isCurrent: () => false };
    if (app.sessionId !== this.sessionId) return unavailable;
    let fresh: CapturedPluginAppBackend | undefined;
    try { fresh = await this.catalogue?.capture(app.pluginId, app.backendId); } catch { /* failed approval revokes */ }
    if (!fresh || !matches(app, fresh) || !fresh.port.isCurrent()) {
      this.revoke({ sessionId: app.sessionId, appId: app.id }); return unavailable;
    }
    const prior = this.#captures.get(app.id);
    const capture = prior?.identity === identity(app) && sameCapture(prior.capture, fresh) ? prior.capture : fresh;
    if (capture !== prior?.capture) this.#leases.delete(app.id);
    this.#captures.set(app.id, { identity: identity(app), capture });
    return { enabled: true, renderApproved: true, invokeApproved: true, snapshot: "valid",
      resourceAvailable: true, toolsAvailable: [...capture.tools.keys()].some(name => capture.isCurrentTool(name)),
      backendGeneration: capture.port.generation, isCurrent: () => capture.port.isCurrent() && this.#captures.get(app.id)?.capture === capture };
  }
  private issue(app: PluginAppRecord, generation: string): PluginAppRuntimeLease {
    const current = this.#captures.get(app.id);
    if (app.sessionId !== this.sessionId || app.status !== "open" || current?.identity !== identity(app)
      || current.capture.port.generation !== generation || !current.capture.port.isCurrent()) throw new Error("plugin_app_stale_capture");
    let entry = this.#leases.get(app.id);
    if (!entry || entry.identity !== current.identity || entry.capture !== current.capture) {
      entry = { ...current, lease: Object.freeze({ token: randomUUID(), backendGeneration: generation }) };
      this.#leases.set(app.id, entry);
    }
    return { ...entry.lease };
  }
  private validate(app: PluginAppRecord, lease: PluginAppRuntimeLease, generation: string): boolean {
    const entry = this.#leases.get(app.id), current = this.#captures.get(app.id);
    return app.sessionId === this.sessionId && app.status === "open" && !!entry && entry.identity === identity(app)
      && entry.capture === current?.capture && entry.lease.token === lease.token && entry.lease.backendGeneration === generation
      && lease.backendGeneration === generation && entry.capture.port.isCurrent();
  }
  private revoke(source: PluginAppSource): void {
    if (source.sessionId !== this.sessionId) return;
    this.#captures.delete(source.appId); this.#leases.delete(source.appId);
  }
  private require(app: PluginAppRecord, lease: PluginAppRuntimeLease): CapturedPluginAppBackend {
    if (!this.validate(app, lease, lease.backendGeneration)) throw new Error("plugin_app_lease_invalid");
    return this.#leases.get(app.id)!.capture;
  }
  private tool(app: PluginAppRecord, request: PluginAppToolRequest) {
    if (request.source.sessionId !== app.sessionId || request.source.appId !== app.id) throw new Error("plugin_app_source_invalid");
    const capture = this.require(app, request.lease), tool = capture.tools.get(request.toolName);
    if (!tool || !capture.isCurrentTool(request.toolName)) throw new Error("plugin_app_tool_unavailable");
    return tool;
  }
  async prepare(app: PluginAppRecord, request: PluginAppToolRequest, view: RunCapabilityView) {
    const prepared = await this.host.prepareTool(app, request);
    const tool = this.tool(app, request);
    const server = tool.serverId ? view.mcpServers.get(tool.serverId) : undefined;
    if (app.backendKind === "mcp-server" && (!server || server.ownerPluginId !== app.pluginId)) throw new Error("plugin_app_server_unavailable");
    const tools = readonlyMap([[tool.definition.name, tool]]);
    const capabilityView: RunCapabilityView = Object.freeze({ pluginId: app.pluginId, pluginIds: readonlySet([app.pluginId]),
      tools, appTools: tools, mcpServers: readonlyMap(server ? [[server.serverId, server]] : []),
      skills: readonlyMap<never>([]), agents: readonlyMap<never>([]) });
    return { ...prepared, capabilityView, binding: tool };
  }
}
