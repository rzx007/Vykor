import type { PluginAppBackendKind } from "@vykor/plugin-contracts/manifest";
import { copyPluginAppJson, type PluginAppJson } from "@vykor/plugin-contracts/runtime-data";
import { PLUGIN_APP_DATA_LIMITS } from "@vykor/plugin-contracts/limits";
import type { SessionRunRecord } from "../sessions/records.js";

export type PluginAppExecutionState = "not_started" | "completed" | "unknown";
export interface PluginAppSource { sessionId: string; appId: string }
export type PluginAppOrigin = { kind: "surface"; surfaceId: string } | { kind: "tool-result"; sourcePartId: string };
export interface PluginAppRecord {
  id: string;
  sessionId: string;
  pluginId: string;
  pluginVersion: string;
  pluginDigest: string;
  definitionDigest: string;
  backendId: string;
  backendKind: PluginAppBackendKind;
  resourceUri: string;
  origin: PluginAppOrigin;
  logicalKey: string;
  status: "open" | "closed" | "revoked";
  controlRevision: number;
  activeActionRunId?: string;
  lastActionRunId?: string;
  createdAt: number;
  updatedAt: number;
}
export interface PluginAppActionMetadata {
  schemaVersion: 1;
  source: PluginAppSource;
  requestId: string;
  requestFingerprint: string;
  expectedRevision: number;
  acceptedRevision: number;
  pluginId: string;
  pluginVersion: string;
  pluginDigest: string;
  definitionDigest: string;
  backendId: string;
  backendKind: PluginAppBackendKind;
  resourceUri: string;
  toolName: string;
  registeredToolName: string;
  toolUseId: string;
  args: Record<string, PluginAppJson>;
  executionState: PluginAppExecutionState;
}
export interface PluginAppActionReceipt {
  source: PluginAppSource; requestId: string; runId: string; expectedRevision: number; acceptedRevision: number;
  status: SessionRunRecord["status"]; executionState: PluginAppExecutionState;
}
export interface PluginAppSubmissionReceipt {
  source: PluginAppSource; requestId: string; inputId: string; runId: string; expectedRevision: number;
  status: SessionRunRecord["status"];
}
/** Only host-owned Run metadata can provide execution facts. External ingress reserves this key. */
export function readPluginAppAction(metadata: Record<string, unknown>): PluginAppActionMetadata | undefined {
  try {
    const value = record(copyPluginAppJson(metadata.pluginAppAction, PLUGIN_APP_DATA_LIMITS.maxArgsBytes + 32 * 1024));
    if (value.schemaVersion !== 1 || !["not_started", "completed", "unknown"].includes(String(value.executionState))
      || !["native-tools", "mcp-server"].includes(String(value.backendKind))) return undefined;
    parsePluginAppSource(value.source);
    revision(value.expectedRevision); revision(value.acceptedRevision);
    if (value.acceptedRevision !== (value.expectedRevision as number) + 1) return undefined;
    for (const key of ["requestId", "requestFingerprint", "pluginId", "pluginVersion", "pluginDigest", "definitionDigest",
      "backendId", "resourceUri", "toolName", "registeredToolName", "toolUseId"]) identifier(value[key]);
    record(copyPluginAppJson(value.args, PLUGIN_APP_DATA_LIMITS.maxArgsBytes));
    return value as unknown as PluginAppActionMetadata;
  } catch { return undefined; }
}
function record(value: unknown): Record<string, PluginAppJson> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plugin_app_invalid_request");
  return value as Record<string, PluginAppJson>;
}
function fields(value: Record<string, PluginAppJson>, names: string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new Error("plugin_app_invalid_request");
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) throw new Error("plugin_app_invalid_request");
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("plugin_app_invalid_request");
  return value as number;
}
function parsePluginAppSource(value: unknown): PluginAppSource {
  const input = record(copyPluginAppJson(value, 4096)); fields(input, ["sessionId", "appId"]);
  return { sessionId: identifier(input.sessionId), appId: identifier(input.appId) };
}
