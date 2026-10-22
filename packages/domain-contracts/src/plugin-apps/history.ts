import { isJsonObject as isPluginUiRecord, isJsonRecord as isPluginUiJsonRecord, type JsonValue } from "@vykor/json-data/json";
import { DomainValidationError } from "../validation-error.js";
const isPluginUiRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPluginUiUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export interface PluginUiInventory {
  manifestCount: number;
  componentCount: number | null;
  validatedComponentCount: number;
}

export interface PluginUiInstanceRecord {
  schemaVersion: 2;
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
  surface: "tool-result" | "session-sidebar";
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

export interface PluginUiActionReceipt {
  requestId: string;
  runId: string;
  instanceId: string;
  revision: number;
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
}

export interface PluginUiActionResponse {
  receipt: PluginUiActionReceipt;
  /** Original persisted tool result, absent before tool settlement. */
  result?: unknown;
}

export interface PluginUiActionRunMetadata {
  schemaVersion: 2;
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

const PLUGIN_UI_LIMITS = { dataBytes: 256 * 1024, actionArgsBytes: 64 * 1024 };
function exactFields(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    Object.keys(record).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
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

/** Shape validation only; the Server must also verify ownership against the actual Part. */
export function readPluginUiInstance(
  metadata: unknown,
): PluginUiInstanceRecord | undefined {
  if (!isPluginUiRecord(metadata) || !Object.hasOwn(metadata, "pluginUi"))
    return undefined;
  const record = metadata.pluginUi;
  const source = [
    "sessionId",
    "sourceRunId",
    "sourcePartId",
    "sourceToolUseId",
    "sourceToolName",
    "pluginId",
    "pluginVersion",
    "componentId",
    "title",
  ];
  if (
    !isPluginUiRecord(record) ||
    !exactFields(
      record,
      [
        "schemaVersion",
        "instanceId",
        ...source,
        "pluginDigest",
        "componentDigest",
        "surface",
        "status",
        "revision",
        "data",
        "createdAt",
        "updatedAt",
      ],
      ["activeActionRunId", "lastActionRunId", "dismissal"],
    )
  )
    return undefined;
  if (
    record.schemaVersion !== 2 ||
    !isPluginUiUuid(record.instanceId) ||
    !source.every((key) => nonempty(record[key])) ||
    !digest(record.pluginDigest) ||
    !digest(record.componentDigest) ||
    (record.surface !== "tool-result" &&
      record.surface !== "session-sidebar") ||
    !["open", "resolved", "dismissed"].includes(record.status as string) ||
    !isPluginUiRevision(record.revision) ||
    !finite(record.createdAt) ||
    !finite(record.updatedAt) ||
    !isPluginUiJsonRecord(record.data, PLUGIN_UI_LIMITS.dataBytes)
  )
    return undefined;
  for (const key of ["activeActionRunId", "lastActionRunId"]) {
    if (Object.hasOwn(record, key) && !nonempty(record[key])) return undefined;
  }
  if (Object.hasOwn(record, "dismissal")) {
    const dismissal = record.dismissal;
    if (
      !isPluginUiRecord(dismissal) ||
      !exactFields(dismissal, [
        "requestId",
        "requestFingerprint",
        "expectedRevision",
        "revision",
        "dismissedAt",
      ]) ||
      !isPluginUiUuid(dismissal.requestId) ||
      !digest(dismissal.requestFingerprint) ||
      !isPluginUiRevision(dismissal.expectedRevision) ||
      !isPluginUiRevision(dismissal.revision) ||
      !finite(dismissal.dismissedAt)
    )
      return undefined;
  }
  return record as unknown as PluginUiInstanceRecord;
}

/** Shape validation only; the Server must also verify this Run's trusted provenance. */
export function readPluginUiAction(
  metadata: unknown,
): PluginUiActionRunMetadata | undefined {
  if (!isPluginUiRecord(metadata) || !Object.hasOwn(metadata, "uiAction"))
    return undefined;
  const record = metadata.uiAction;
  const source = [
    "actionId",
    "label",
    "pluginId",
    "pluginVersion",
    "toolName",
    "toolUseId",
  ];
  if (
    !isPluginUiRecord(record) ||
    !exactFields(record, [
      "schemaVersion",
      "instanceId",
      "requestId",
      "requestFingerprint",
      "expectedRevision",
      ...source,
      "args",
      "pluginDigest",
      "componentDigest",
      "executionState",
    ])
  )
    return undefined;
  if (
    record.schemaVersion !== 2 ||
    !isPluginUiUuid(record.instanceId) ||
    !isPluginUiUuid(record.requestId) ||
    !digest(record.requestFingerprint) ||
    !digest(record.pluginDigest) ||
    !digest(record.componentDigest) ||
    !isPluginUiRevision(record.expectedRevision) ||
    !source.every((key) => nonempty(record[key])) ||
    !["not_started", "completed", "unknown"].includes(
      record.executionState as string,
    ) ||
    !isPluginUiJsonRecord(record.args, PLUGIN_UI_LIMITS.actionArgsBytes)
  )
    return undefined;
  return record as unknown as PluginUiActionRunMetadata;
}

export type PluginUiConversationReceipt =
  | {
      kind: "conversation";
      mode: "draft";
      instanceId: string;
      revision: number;
      added: true;
      targetSessionId?: string;
    }
  | {
      kind: "conversation";
      mode: "submit";
      instanceId: string;
      revision: number;
      requestId: string;
      inputId: string;
      runId: string;
      status: "pending" | "running" | "completed" | "failed" | "interrupted";
      targetSessionId?: string;
    };
export interface PluginUiSubmissionRecord {
  schemaVersion: 2;
  requestId: string;
  requestFingerprint: string;
  expectedRevision: number;
  inputId: string;
  runId: string;
  pluginDigest: string;
  componentDigest: string;
  acceptedAt: number;
  targetSessionId?: string;
}

function invalid(field?: string): never {
  throw new DomainValidationError("Invalid Plugin UI conversation", field);
}
function exact(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !isPluginUiRecord(value) ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key))
  )
    invalid();
  return value;
}
const mode = (value: unknown) => value === "draft" || value === "submit";
function target(r: Record<string, unknown>): void {
  if (Object.hasOwn(r, "targetSessionId") && !nonempty(r.targetSessionId)) invalid("targetSessionId");
}
export function parsePluginUiConversationReceipt(
  value: unknown,
): PluginUiConversationReceipt {
  if (!isPluginUiRecord(value)) invalid();
  const r = exact(
    value,
    value.mode === "draft"
      ? ["kind", "mode", "instanceId", "revision", "added"]
      : [
          "kind",
          "mode",
          "instanceId",
          "revision",
          "requestId",
          "inputId",
          "runId",
          "status",
        ],
    ["targetSessionId"],
  );
  target(r);
  if (
    r.kind !== "conversation" ||
    !mode(r.mode) ||
    !isPluginUiUuid(r.instanceId) ||
    !isPluginUiRevision(r.revision)
  )
    invalid();
  if (r.mode === "draft") {
    if (r.added !== true) invalid("added");
  } else if (
    !isPluginUiUuid(r.requestId) ||
    !nonempty(r.inputId) ||
    !nonempty(r.runId) ||
    typeof r.status !== "string" ||
    !["pending", "running", "completed", "failed", "interrupted"].includes(
      r.status,
    )
  )
    invalid();
  return structuredClone(r) as unknown as PluginUiConversationReceipt;
}
export function parsePluginUiSubmissionRecord(
  value: unknown,
): PluginUiSubmissionRecord {
  const r = exact(value, [
    "schemaVersion",
    "requestId",
    "requestFingerprint",
    "expectedRevision",
    "inputId",
    "runId",
    "pluginDigest",
    "componentDigest",
    "acceptedAt",
  ], ["targetSessionId"]);
  target(r);
  if (
    r.schemaVersion !== 2 ||
    !isPluginUiUuid(r.requestId) ||
    !isPluginUiRevision(r.expectedRevision) ||
    !nonempty(r.inputId) ||
    !nonempty(r.runId) ||
    !digest(r.requestFingerprint) ||
    !digest(r.pluginDigest) ||
    !digest(r.componentDigest) ||
    !isPluginUiRevision(r.acceptedAt)
  )
    invalid();
  return structuredClone(r) as unknown as PluginUiSubmissionRecord;
}
