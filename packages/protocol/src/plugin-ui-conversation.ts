import {
  isPluginUiRecord,
  isPluginUiRevision,
  isPluginUiUuid,
  validatePluginUiJsonRecord,
  type JsonValue,
} from "./plugin-ui.js";
import { ProtocolValidationError } from "./requests.js";

export const PLUGIN_UI_CONVERSATION_LIMITS = { dataBytes: 32 * 1024 } as const;

export interface PluginUiConversationRequest {
  mode: "draft" | "submit";
  expectedRevision: number;
  text: string;
  data: Record<string, JsonValue>;
}
export interface PluginUiConversationPrepared {
  mode: "draft" | "submit";
  instanceId: string;
  revision: number;
  promptText: string;
}
export type SubmitPluginUiConversationInput = Omit<
  PluginUiConversationRequest,
  "mode"
> & { requestId: string };
export type PluginUiConversationReceipt =
  | {
      kind: "conversation";
      mode: "draft";
      instanceId: string;
      revision: number;
      added: true;
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
}

function invalid(field?: string): never {
  throw new ProtocolValidationError("Invalid Plugin UI conversation", field);
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !isPluginUiRecord(value) ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid();
  return value;
}
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim();
const mode = (value: unknown) => value === "draft" || value === "submit";
const digest = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
function payload(r: Record<string, unknown>): void {
  if (!isPluginUiRevision(r.expectedRevision)) invalid("expectedRevision");
  if (!nonempty(r.text) || [...r.text].length > 4096) invalid("text");
  const checked = validatePluginUiJsonRecord(
    r.data,
    PLUGIN_UI_CONVERSATION_LIMITS.dataBytes,
  );
  if (!checked.valid)
    throw new ProtocolValidationError(
      "Invalid Plugin UI conversation data",
      "data",
      checked.reason,
    );
}
export function parsePluginUiConversationRequest(
  value: unknown,
): PluginUiConversationRequest {
  const r = exact(value, ["mode", "expectedRevision", "text", "data"]);
  if (!mode(r.mode)) invalid("mode");
  payload(r);
  return structuredClone(r) as unknown as PluginUiConversationRequest;
}
export function parseSubmitPluginUiConversationInput(
  value: unknown,
): SubmitPluginUiConversationInput {
  const r = exact(value, ["requestId", "expectedRevision", "text", "data"]);
  if (!isPluginUiUuid(r.requestId)) invalid("requestId");
  payload(r);
  return structuredClone(r) as unknown as SubmitPluginUiConversationInput;
}
export function parsePluginUiConversationPrepared(
  value: unknown,
): PluginUiConversationPrepared {
  const r = exact(value, ["mode", "instanceId", "revision", "promptText"]);
  if (
    !mode(r.mode) ||
    !isPluginUiUuid(r.instanceId) ||
    !isPluginUiRevision(r.revision) ||
    !nonempty(r.promptText)
  )
    invalid();
  if (new TextEncoder().encode(r.promptText).byteLength > 64 * 1024)
    throw new ProtocolValidationError(
      "Plugin UI conversation prompt is too large",
      "promptText",
      "payload_too_large",
    );
  return structuredClone(r) as unknown as PluginUiConversationPrepared;
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
  );
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
  ]);
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
