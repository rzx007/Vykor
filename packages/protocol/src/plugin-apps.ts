/** Plugin packaging declarations. Runtime identities and execution authority are host-owned. */
export interface PluginAppResourceDefinition {
  uri: string;
  entry: string;
}

export interface PluginAppNativeToolDefinition {
  tool: string;
  visibility: Array<"model" | "app">;
  ui?: { resourceUri: string };
}

export interface PluginAppNativeBackendDefinition {
  id: string;
  kind: "native-tools";
  resources: PluginAppResourceDefinition[];
  tools: PluginAppNativeToolDefinition[];
}

export interface PluginAppMcpBackendDefinition {
  id: string;
  kind: "mcp-server";
  server: string;
}

export type PluginAppBackendDefinition = PluginAppNativeBackendDefinition | PluginAppMcpBackendDefinition;

export interface PluginAppSurfaceDefinition {
  id: string;
  title: string;
  backend: string;
  resourceUri: string;
  availability: "session";
}

export interface PluginAppManifest {
  schemaVersion: 1;
  backends: PluginAppBackendDefinition[];
  surfaces: PluginAppSurfaceDefinition[];
}

export const PLUGIN_APP_LIMITS = Object.freeze({
  manifestCount: 8,
  manifestBytes: 256 * 1024,
  backendCount: 32,
  surfaceCount: 32,
  htmlBytes: 16 * 1024 * 1024,
  resourceBytes: 8 * 1024 * 1024,
  appDataBytes: 256 * 1024,
  argsBytes: 64 * 1024,
  resultBytes: 1024 * 1024,
  widgetStateBytes: 32 * 1024,
  handoffBytes: 32 * 1024,
  messageCharacters: 4096,
  sessionPages: 4,
  windowPages: 8,
  jsonDepth: 32,
});

export const PLUGIN_APP_HTML_MIME_TYPE = "text/html;profile=mcp-app";

export type PluginAppBackendKind = PluginAppBackendDefinition["kind"];
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
/** An opaque host credential. Its source, digests and backend are bound server-side. */
export interface PluginAppRuntimeLease { token: string; backendGeneration: string }
export type PluginAppJson = null | boolean | number | string | PluginAppJson[] | { [key: string]: PluginAppJson };
export interface PluginAppInvokeInput {
  requestId: string;
  expectedRevision: number;
  toolName: string;
  args: Record<string, PluginAppJson>;
}
export interface PluginAppToolRequest extends PluginAppInvokeInput { source: PluginAppSource; lease: PluginAppRuntimeLease }
export interface OpenPluginAppInput { pluginId: string; surfaceId: string }
export interface ClosePluginAppInput { expectedRevision: number }
export type PluginAppExecutionState = "not_started" | "completed" | "unknown";
export interface PluginAppAvailability {
  canReadResource: boolean;
  canInvokeTools: boolean;
  canMessage: boolean;
  reason?: "closed" | "revoked" | "session-unavailable" | "snapshot-changed" | "permission-missing" | "runtime-unavailable" | "action-unconfirmed";
}
export interface PluginAppToolDescriptor { name: string; description: string; inputSchema: Record<string, unknown> }
export interface PluginAppResponse { source: PluginAppSource; app: PluginAppRecord; availability: PluginAppAvailability; lease?: PluginAppRuntimeLease; tools?: PluginAppToolDescriptor[] }
export interface PluginAppListResponse { apps: PluginAppResponse[] }
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
  status: import("./session").SessionRunRecord["status"]; executionState: PluginAppExecutionState;
}
export interface PluginAppActionResponse {
  receipt: PluginAppActionReceipt;
  result?: import("./mcp-apps").McpCallResultData;
  dataError?: "plugin_app_invalid_data" | "plugin_app_data_too_large" | "plugin_app_unsupported_content" | "plugin_app_result_unavailable";
}
export interface PluginAppConversationRequest {
  source: PluginAppSource; lease: PluginAppRuntimeLease; requestId: string; expectedRevision: number;
  text: string; data: PluginAppJson;
}
export interface PluginAppSubmissionReceipt {
  source: PluginAppSource; requestId: string; inputId: string; runId: string; expectedRevision: number;
  status: import("./session").SessionRunRecord["status"];
}
/** Only host-owned Run metadata can provide execution facts. External ingress reserves this key. */
export function readPluginAppAction(metadata: Record<string, unknown>): PluginAppActionMetadata | undefined {
  try {
    const value = record(copyPluginAppJson(metadata.pluginAppAction, PLUGIN_APP_LIMITS.argsBytes + 32 * 1024));
    if (value.schemaVersion !== 1 || !["not_started", "completed", "unknown"].includes(String(value.executionState))
      || !["native-tools", "mcp-server"].includes(String(value.backendKind))) return undefined;
    parsePluginAppSource(value.source);
    revision(value.expectedRevision); revision(value.acceptedRevision);
    if (value.acceptedRevision !== (value.expectedRevision as number) + 1) return undefined;
    for (const key of ["requestId", "requestFingerprint", "pluginId", "pluginVersion", "pluginDigest", "definitionDigest",
      "backendId", "resourceUri", "toolName", "registeredToolName", "toolUseId"]) identifier(value[key]);
    record(copyPluginAppJson(value.args, PLUGIN_APP_LIMITS.argsBytes));
    return value as unknown as PluginAppActionMetadata;
  } catch { return undefined; }
}
export function parsePluginAppConversationRequest(value: unknown): PluginAppConversationRequest {
  const input = record(copyPluginAppJson(value, PLUGIN_APP_LIMITS.handoffBytes + 32 * 1024));
  fields(input, ["source", "lease", "requestId", "expectedRevision", "text", "data"]);
  const lease = record(input.lease); fields(lease, ["token", "backendGeneration"]);
  if (typeof input.text !== "string" || [...input.text].length > PLUGIN_APP_LIMITS.messageCharacters || !input.text.trim())
    throw new Error("plugin_app_invalid_message");
  return { source: parsePluginAppSource(input.source), lease: { token: identifier(lease.token), backendGeneration: identifier(lease.backendGeneration) },
    requestId: identifier(input.requestId), expectedRevision: revision(input.expectedRevision), text: input.text,
    data: copyPluginAppJson(input.data, PLUGIN_APP_LIMITS.handoffBytes) };
}

/** Copy only finite, plain JSON without invoking getters/toJSON or retaining input aliases. */
export function copyPluginAppJson(value: unknown, maxBytes: number): PluginAppJson {
  const ancestors = new Set<object>();
  let budget = maxBytes;
  const spend = (text: string): void => {
    budget -= new TextEncoder().encode(text).byteLength;
    if (budget < 0) throw new Error("plugin_app_json_too_large");
  };
  const copy = (item: unknown, depth: number): PluginAppJson => {
    if (item === null || typeof item === "boolean" || typeof item === "string" || (typeof item === "number" && Number.isFinite(item))) {
      spend(JSON.stringify(item)); return item;
    }
    if (typeof item !== "object" || item === null || depth >= PLUGIN_APP_LIMITS.jsonDepth || ancestors.has(item)) throw new Error("plugin_app_invalid_json");
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("plugin_app_invalid_json");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length || Object.values(descriptors).some(descriptor => descriptor.get || descriptor.set)) throw new Error("plugin_app_invalid_json");
    ancestors.add(item); spend(array ? "[]" : "{}");
    try {
      if (array) {
        const result: PluginAppJson[] = [];
        if (Object.keys(item).length !== item.length) throw new Error("plugin_app_invalid_json");
        for (let index = 0; index < item.length; index++) {
          if (index) spend(","); result.push(copy(descriptors[index]!.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, PluginAppJson> = {};
      let count = 0;
      for (const key of Object.keys(item).sort()) {
        if (count++) spend(","); spend(`${JSON.stringify(key)}:`);
        Object.defineProperty(result, key, { value: copy(descriptors[key]!.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally { ancestors.delete(item); }
  };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("plugin_app_invalid_json_limit");
  return copy(value, 0);
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
export function parsePluginAppSource(value: unknown): PluginAppSource {
  const input = record(copyPluginAppJson(value, 4096)); fields(input, ["sessionId", "appId"]);
  return { sessionId: identifier(input.sessionId), appId: identifier(input.appId) };
}
export function parseOpenPluginAppInput(value: unknown): OpenPluginAppInput {
  const input = record(copyPluginAppJson(value, 4096)); fields(input, ["pluginId", "surfaceId"]);
  return { pluginId: identifier(input.pluginId), surfaceId: identifier(input.surfaceId) };
}
export function parseClosePluginAppInput(value: unknown): ClosePluginAppInput {
  const input = record(copyPluginAppJson(value, 1024)); fields(input, ["expectedRevision"]);
  return { expectedRevision: revision(input.expectedRevision) };
}
export function parsePluginAppToolRequest(value: unknown): PluginAppToolRequest {
  const input = record(copyPluginAppJson(value, PLUGIN_APP_LIMITS.argsBytes + 16 * 1024));
  fields(input, ["requestId", "expectedRevision", "toolName", "args", "source", "lease"]);
  const lease = record(input.lease); fields(lease, ["token", "backendGeneration"]);
  const args = record(copyPluginAppJson(input.args, PLUGIN_APP_LIMITS.argsBytes));
  return { requestId: identifier(input.requestId), expectedRevision: revision(input.expectedRevision), toolName: identifier(input.toolName), args,
    source: parsePluginAppSource(input.source), lease: { token: identifier(lease.token), backendGeneration: identifier(lease.backendGeneration) } };
}

/** Explicit ordinary-input references. Host credentials never travel through metadata. */
export function parsePluginAppComposerContexts(value: unknown): PluginAppConversationRequest[] {
  if (!Array.isArray(value) || value.length > PLUGIN_APP_LIMITS.windowPages) throw new Error("plugin_app_invalid_context");
  return value.map(parsePluginAppConversationRequest);
}
/** A synchronous admission failure, not a missing receipt or an execution-state estimate. */
export interface PluginAppAdmissionRejection {
  code: "plugin_app_not_accepted";
  kind: "tool" | "message";
  source: PluginAppSource;
  requestId: string;
  expectedRevision: number;
}

export function isPluginAppAdmissionRejection(value: unknown, kind: "tool" | "message",
  request: { source: PluginAppSource; requestId: string; expectedRevision: number }): value is PluginAppAdmissionRejection {
  if (!value || typeof value !== "object") return false;
  const proof = value as Partial<PluginAppAdmissionRejection>;
  return proof.code === "plugin_app_not_accepted" && proof.kind === kind
    && proof.source?.sessionId === request.source.sessionId && proof.source?.appId === request.source.appId
    && proof.requestId === request.requestId && proof.expectedRevision === request.expectedRevision;
}
export type PluginAppResourceNotice =
  | { kind: "resync"; runtimeEpoch: string }
  | { kind: "resource-updated"; runtimeEpoch: string; appId: string; leaseGeneration: number; uri: string };
export interface PluginAppResourceWatch {
  source: PluginAppSource;
  lease: PluginAppRuntimeLease;
  leaseGeneration: number;
  uris: string[];
}
/** Created by trusted checked result projection, never from plugin result metadata. */
export interface PluginAppToolOrigin {
  pluginId: string; pluginVersion: string; pluginDigest: string; definitionDigest: string;
  backendId: string; backendKind: PluginAppBackendKind; resourceUri: string; toolName: string;
}
