import type { JsonValue } from "@vykor/json-data/json";
import type { PluginAppBackendKind } from "../manifest/manifest.js";

/** Opaque runtime identity assembled by the host from persisted and installed facts. */
export interface PluginAppHostBinding {
  agentId: string;
  sessionId: string;
  /** Host-owned instance identity used only to isolate and revoke leases. */
  instanceId: string;
  pluginId: string;
  pluginVersion: string;
  pluginDigest: string;
  definitionDigest: string;
  backendId: string;
  backendKind: PluginAppBackendKind;
  resourceUri: string;
}
export interface PluginAppRuntimeLease { token: string; backendGeneration: string }
export interface PluginAppRuntimeSource { sessionId: string; instanceId: string }
export interface PluginAppHostInvocation {
  binding: PluginAppHostBinding;
  lease: PluginAppRuntimeLease;
  toolName: string;
  args: Record<string, JsonValue>;
}
export interface PluginAppToolPolicy {
  confirmation: "required" | "granted";
  maxArgumentsBytes: number;
  authorization?: "plugin-data-write";
}
export interface PluginAppToolDescriptor { name: string; description: string; inputSchema: Record<string, unknown>; policy?: PluginAppToolPolicy }
/** Created by trusted checked result projection, never from plugin result metadata. */
export interface PluginAppToolOrigin {
  pluginId: string; pluginVersion: string; pluginDigest: string; definitionDigest: string;
  backendId: string; backendKind: PluginAppBackendKind; resourceUri: string; toolName: string;
}
