export type JsonValue = null | boolean | number | string | JsonValue[]
  | { [key: string]: JsonValue };

export interface PluginUiActionDefinition {
  id: string;
  label: string;
  tool: string;
  completion: "keep-open" | "resolve";
}

export interface PluginUiComponentDefinition {
  id: string;
  title: string;
  entry: string;
  surfaces: Array<"tool-result" | "session-sidebar">;
  actions: PluginUiActionDefinition[];
}

export interface PluginUiManifestV1 {
  schemaVersion: 1;
  components: PluginUiComponentDefinition[];
}

/** Static definitions only; these counts do not prove a UI is running. */
export interface PluginUiInventory {
  manifestCount: number;
  componentCount: number | null;
  validatedComponentCount: number;
}

export interface PluginUiProposal {
  schemaVersion: 1;
  componentId: string;
  data: Record<string, JsonValue>;
}

export interface PluginUiInstanceRecord {
  schemaVersion: 1;
  instanceId: string;
  sessionId: string;
  sourceRunId: string;
  sourcePartId: string;
  sourceToolUseId: string;
  sourceToolName: string;
  pluginId: string;
  pluginVersion: string;
  pluginDigest: string;
  componentId: string;
  componentDigest: string;
  title: string;
  surfaces: Array<"tool-result" | "session-sidebar">;
  status: "open" | "resolved" | "dismissed";
  revision: number;
  data: Record<string, JsonValue>;
  activeActionRunId?: string;
  lastActionRunId?: string;
  dismissal?: {
    requestId: string;
    requestFingerprint: string;
    expectedRevision: number;
    revision: number;
    dismissedAt: number;
  };
  createdAt: number;
  updatedAt: number;
}

export interface InvokePluginUiActionInput {
  requestId: string;
  expectedRevision: number;
  actionId: string;
  args: Record<string, JsonValue>;
}

export interface DismissPluginUiInput {
  requestId: string;
  expectedRevision: number;
}

export interface PluginUiActionReceipt {
  requestId: string;
  runId: string;
  instanceId: string;
  revision: number;
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
}

export interface PluginUiActionRunMetadata {
  schemaVersion: 1;
  instanceId: string;
  requestId: string;
  requestFingerprint: string;
  expectedRevision: number;
  actionId: string;
  label: string;
  args: Record<string, JsonValue>;
  pluginId: string;
  pluginVersion: string;
  pluginDigest: string;
  componentDigest: string;
  toolName: string;
  toolUseId: string;
  executionState: "not_started" | "completed" | "unknown";
}

export const PLUGIN_UI_LIMITS = {
  manifestCount: 8,
  manifestBytes: 256 * 1024,
  componentCount: 16,
  actionsPerComponent: 16,
  htmlBytes: 2 * 1024 * 1024,
  dataBytes: 256 * 1024,
  actionArgsBytes: 64 * 1024,
  titleCodePoints: 80,
  jsonDepth: 20,
} as const;

export function isPluginUiRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isPluginUiUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isPluginUiRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Reject the whole payload; no data or identifiers are truncated. */
export function isPluginUiJsonRecord(value: unknown, byteLimit: number): value is Record<string, JsonValue> {
  if (!isPluginUiRecord(value)) return false;
  try {
    return new TextEncoder().encode(stringifyPluginUiJson(value)).byteLength <= byteLimit;
  } catch {
    return false;
  }
}

function exactFields(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(record, key))
    && Object.keys(record).every(key => required.includes(key) || optional.includes(key));
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** An untrusted plugin proposal; it grants no host identity or permission. */
export function readPluginUiProposal(metadata: unknown): PluginUiProposal | undefined {
  if (!isPluginUiRecord(metadata) || !Object.hasOwn(metadata, "ui")) return undefined;
  const record = metadata.ui;
  if (!isPluginUiRecord(record) || !exactFields(record, ["schemaVersion", "componentId", "data"])
    || record.schemaVersion !== 1 || !nonempty(record.componentId)
    || !isPluginUiJsonRecord(record.data, PLUGIN_UI_LIMITS.dataBytes)) return undefined;
  return record as unknown as PluginUiProposal;
}

/** Shape validation only; the Server must also verify ownership against the actual Part. */
export function readPluginUiInstance(metadata: unknown): PluginUiInstanceRecord | undefined {
  if (!isPluginUiRecord(metadata) || !Object.hasOwn(metadata, "pluginUi")) return undefined;
  const record = metadata.pluginUi;
  const source = ["sessionId", "sourceRunId", "sourcePartId", "sourceToolUseId", "sourceToolName",
    "pluginId", "pluginVersion", "componentId", "title"];
  if (!isPluginUiRecord(record) || !exactFields(record, ["schemaVersion", "instanceId", ...source,
    "pluginDigest", "componentDigest", "surfaces", "status", "revision", "data", "createdAt", "updatedAt"],
    ["activeActionRunId", "lastActionRunId", "dismissal"])) return undefined;
  if (record.schemaVersion !== 1 || !isPluginUiUuid(record.instanceId)
    || !source.every(key => nonempty(record[key]))
    || !digest(record.pluginDigest) || !digest(record.componentDigest)
    || !Array.isArray(record.surfaces) || record.surfaces.length === 0
    || Array.from(record.surfaces).some(surface => surface !== "tool-result" && surface !== "session-sidebar")
    || !["open", "resolved", "dismissed"].includes(record.status as string)
    || !isPluginUiRevision(record.revision) || !finite(record.createdAt) || !finite(record.updatedAt)
    || !isPluginUiJsonRecord(record.data, PLUGIN_UI_LIMITS.dataBytes)) return undefined;
  for (const key of ["activeActionRunId", "lastActionRunId"]) {
    if (Object.hasOwn(record, key) && !nonempty(record[key])) return undefined;
  }
  if (Object.hasOwn(record, "dismissal")) {
    const dismissal = record.dismissal;
    if (!isPluginUiRecord(dismissal) || !exactFields(dismissal,
      ["requestId", "requestFingerprint", "expectedRevision", "revision", "dismissedAt"])
      || !isPluginUiUuid(dismissal.requestId) || !digest(dismissal.requestFingerprint)
      || !isPluginUiRevision(dismissal.expectedRevision) || !isPluginUiRevision(dismissal.revision)
      || !finite(dismissal.dismissedAt)) return undefined;
  }
  return record as unknown as PluginUiInstanceRecord;
}

/** Shape validation only; the Server must also verify this Run's trusted provenance. */
export function readPluginUiAction(metadata: unknown): PluginUiActionRunMetadata | undefined {
  if (!isPluginUiRecord(metadata) || !Object.hasOwn(metadata, "uiAction")) return undefined;
  const record = metadata.uiAction;
  const source = ["actionId", "label", "pluginId", "pluginVersion", "toolName", "toolUseId"];
  if (!isPluginUiRecord(record) || !exactFields(record, ["schemaVersion", "instanceId", "requestId",
    "requestFingerprint", "expectedRevision", ...source, "args", "pluginDigest", "componentDigest", "executionState"])) return undefined;
  if (record.schemaVersion !== 1 || !isPluginUiUuid(record.instanceId) || !isPluginUiUuid(record.requestId)
    || !digest(record.requestFingerprint) || !digest(record.pluginDigest) || !digest(record.componentDigest)
    || !isPluginUiRevision(record.expectedRevision) || !source.every(key => nonempty(record[key]))
    || !["not_started", "completed", "unknown"].includes(record.executionState as string)
    || !isPluginUiJsonRecord(record.args, PLUGIN_UI_LIMITS.actionArgsBytes)) return undefined;
  return record as unknown as PluginUiActionRunMetadata;
}

/** JSON with deterministic object-key order, including numeric and literal prototype keys. */
export function stringifyPluginUiJson(value: unknown): string {
  const render = (item: unknown, depth: number): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null) throw new Error("Plugin UI requires JSON data");
    if (depth >= PLUGIN_UI_LIMITS.jsonDepth) throw new Error("Plugin UI JSON nesting limit exceeded");
    if (Array.isArray(item)) {
      return `[${Array.from(item, child => render(child, depth + 1)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Plugin UI requires plain JSON objects");
    }
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${render(record[key], depth + 1)}`,
    ).join(",")}}`;
  };
  return render(value, 0);
}
