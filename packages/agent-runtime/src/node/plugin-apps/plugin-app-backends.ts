import type { ToolResult } from "@vykor/agent-contracts";
import type { NodeRunToolBinding as RunToolBinding } from "../runtime/node-runtime-resources.js";
import type { MutableToolRegistry as IToolRegistry } from "@vykor/agent-contracts";
import { isToolVisibleTo, toolDefinitionIdentity } from "@vykor/core";
import type { CapturedMcpAppResources } from "@vykor/mcp";
import type { NativeAppMetadata } from "@vykor/plugins";
import { type McpCallResultData } from "@vykor/agent-contracts";
import type { PluginAppBackendDefinition, PluginAppSurfaceDefinition } from "@vykor/plugin-contracts/manifest";
import { readonlyMap } from "../plugins/run-capability-view.js";

/** Resource-only port. No arbitrary invoke, Tool Host, registry, or execute function crosses this boundary. */
export interface PluginAppBackendPort {
  readonly kind: PluginAppBackendDefinition["kind"];
  readonly generation: string;
  readonly supportsSubscriptions: boolean;
  isCurrent(): boolean;
  subscribeResource?(uri: string, listener: () => void, signal: AbortSignal): Promise<() => void>;
  readResource(uri: string, signal?: AbortSignal): ReturnType<CapturedMcpAppResources["readResource"]>;
  listResources(cursor?: string, signal?: AbortSignal): ReturnType<CapturedMcpAppResources["listResources"]>;
  listResourceTemplates(cursor?: string, signal?: AbortSignal): ReturnType<CapturedMcpAppResources["listResourceTemplates"]>;
}

/** Agent-only capture. Never serialize this record or hand its executable bindings to a resource consumer. */
export interface CapturedPluginAppBackend {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly pluginDigest: string;
  readonly definitionDigest: string;
  readonly definition: PluginAppBackendDefinition;
  readonly surfaces: readonly PluginAppSurfaceDefinition[];
  readonly port: PluginAppBackendPort;
  readonly tools: ReadonlyMap<string, RunToolBinding>;
  /** Source matching only; never passed to app execution. Includes model-only definitions. */
  readonly originTools?: ReadonlyMap<string, RunToolBinding>;
  /** Set only after current installed permission approval has been verified. */
  readonly pluginDataWriteApproved?: boolean;
  /** Checks generation AND original registration identity under current runtime policy. */
  isCurrentTool(name: string): boolean;
}

export interface PluginAppBackendCatalogue {
  /** Descriptors only; this does not grant execution or create a Run. */
  list(): ReadonlyArray<{ pluginId: string; pluginVersion: string; pluginDigest: string; definitionDigest: string;
    backend: PluginAppBackendDefinition; surfaces: readonly PluginAppSurfaceDefinition[] }>;
  /** Trusted Agent call only. Captures current exact bindings after policy filtering. */
  capture(pluginId: string, backendId: string): Promise<CapturedPluginAppBackend | undefined>;
}

export interface PluginAppBackendCaptureInput {
  pluginId: string;
  pluginVersion: string;
  pluginDigest: string;
  metadata: NativeAppMetadata;
  definition: PluginAppBackendDefinition;
  /** Trusted host catalogue with the current host/role/deny/environment policy applied. */
  toolRegistry: IToolRegistry;
  pluginDataWriteApproved?: boolean;
}

/** Receiver and identity belong to the installed definition, never a newly generated equivalent wrapper. */
export function captureAppToolBindings(input: PluginAppBackendCaptureInput, names: readonly string[], serverId?: string, originOnly = false): ReadonlyMap<string, RunToolBinding> {
  const bindings: Array<[string, RunToolBinding]> = [];
  for (const name of names) {
    const definition = input.toolRegistry.get(name);
    const source = input.toolRegistry.inspect(name)?.source;
    const owned = input.definition.kind === "native-tools"
      ? source?.kind === "plugin" && source.id === input.pluginId
      : source?.kind === "mcp" && source.id === input.definition.server;
    if (!definition || !owned || (!originOnly && !isToolVisibleTo(definition, "app"))) continue;
    bindings.push([name, Object.freeze({ ownerPluginId: input.pluginId, definition: immutableCopy(definition),
      source, ...(serverId ? { serverId } : {}), definitionIdentity: toolDefinitionIdentity(definition),
      invoke: definition.execute.bind(definition) })]);
  }
  return readonlyMap(bindings);
}

export function capturedBackend(input: PluginAppBackendCaptureInput, port: PluginAppBackendPort,
  tools: ReadonlyMap<string, RunToolBinding>, originTools = tools): CapturedPluginAppBackend {
  return Object.freeze({ pluginId: input.pluginId, pluginVersion: input.pluginVersion, pluginDigest: input.pluginDigest,
    pluginDataWriteApproved: input.pluginDataWriteApproved === true,
    definitionDigest: input.metadata.definitionDigest, definition: input.definition,
    surfaces: Object.freeze(input.metadata.definition.surfaces.filter(surface => surface.backend === input.definition.id)), port, tools, originTools,
    isCurrentTool: (name: string) => {
      if (!port.isCurrent()) return false;
      const captured = tools.get(name);
      const current = captured && input.toolRegistry.get(captured.definition.name);
      const source = captured && input.toolRegistry.inspect(captured.definition.name)?.source;
      return !!captured && !!current && current.execute === captured.definition.execute
        && toolDefinitionIdentity(current) === captured.definitionIdentity && source?.kind === captured.source?.kind
        && source?.id === captured.source?.id && isToolVisibleTo(current, "app");
    },
  });
}

function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy)) as T;
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, immutableCopy(item)]))) as T;
  return value;
}

/** Derived only after the original result/execution facts have been persisted. Never replaces them. */
export interface PluginAppResultView {
  readonly result: McpCallResultData;
  readonly dataError?: "plugin_app_invalid_data" | "plugin_app_data_too_large" | "plugin_app_unsupported_content";
}

export type SettledPluginAppResultAdapter = (original: ToolResult) => PluginAppResultView;
