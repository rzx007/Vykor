import {
  isPluginUiJsonRecord, isPluginUiRecord, isPluginUiRevision, isPluginUiUuid,
  PLUGIN_UI_LIMITS, validatePluginUiJsonRecord, type JsonValue, type PluginUiActionReceipt,
} from "./plugin-ui.js";

export const PLUGIN_UI_BRIDGE_LIMITS = {
  requestBytes: 64 * 1024, snapshotBytes: 512 * 1024, pendingRequests: 16,
  requestsPerMinute: 60, rateWindowMs: 60_000, initializationMs: 10_000,
  requestMs: 30_000, confirmationMs: 300_000, confirmedRequestMs: 330_000,
  framesPerWindow: 2, minHeight: 160, maxHeight: 640, resultCodePoints: 1024,
} as const;

export type PluginUiSurface = "tool-result" | "session-sidebar";
export interface PluginUiViewSnapshot {
  instanceId: string; revision: number; status: "open" | "resolved" | "dismissed";
  data: Record<string, JsonValue>;
  actions: Array<{ id: string; label: string; completion: "keep-open" | "resolve" }>;
  readOnly: boolean;
  activeAction?: PluginUiActionReceipt;
  lastAction?: { receipt: PluginUiActionReceipt; executionState: "not_started" | "completed" | "unknown"; message: string };
  theme: "light" | "dark"; locale: string; surface: PluginUiSurface;
}
export type PluginUiBridgeMethod = "getSnapshot" | "requestAction" | "openSidebar" | "resize" | "dismiss";
export interface PluginUiBridgeRequest {
  version: 1; mountId: string; id: string; method: PluginUiBridgeMethod;
  params: Record<string, unknown>;
}
export type PluginUiBridgeResponse = { version: 1; mountId: string; id: string } & (
  | { result: PluginUiViewSnapshot | PluginUiActionReceipt | null }
  | { error: { code: string; message: string } }
);
export type PluginUiBridgeNotification =
  | { version: 1; mountId: string; type: "snapshot"; snapshot: PluginUiViewSnapshot }
  | { version: 1; mountId: string; type: "dispose" };

export class PluginUiBridgeError extends Error {
  constructor(readonly code: string, message: string = code) { super(message); this.name = "PluginUiBridgeError"; }
}
function fail(code = "plugin_ui_invalid_message"): never { throw new PluginUiBridgeError(code); }
function record(value: unknown): Record<string, unknown> {
  if (!isPluginUiRecord(value)) fail();
  return value;
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (!required.every(key => Object.hasOwn(value, key))
    || !Object.keys(value).every(key => required.includes(key) || optional.includes(key))) fail();
}
const text = (value: unknown, maximum?: number): value is string =>
  typeof value === "string" && value.length > 0 && (maximum === undefined || [...value].length <= maximum);
const oneOf = (value: unknown, choices: readonly string[]): boolean =>
  typeof value === "string" && choices.includes(value);
function bytes(value: unknown, maximum: number): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum) fail("plugin_ui_payload_too_large");
}
function envelope(value: Record<string, unknown>): void {
  if (value.version !== 1 || !isPluginUiUuid(value.mountId)) fail();
}
export function parsePluginUiBridgeReceipt(value: unknown): PluginUiActionReceipt {
  const r = record(value);
  exact(r, ["requestId", "runId", "instanceId", "revision", "status"]);
  if (!isPluginUiUuid(r.requestId) || !isPluginUiUuid(r.instanceId) || !text(r.runId)
    || !isPluginUiRevision(r.revision)
    || !oneOf(r.status, ["pending", "running", "completed", "failed", "interrupted"])) fail();
  return structuredClone(r) as unknown as PluginUiActionReceipt;
}
export function parsePluginUiBridgeSnapshot(value: unknown): PluginUiViewSnapshot {
  const r = record(value);
  exact(r, ["instanceId", "revision", "status", "data", "actions", "readOnly", "theme", "locale", "surface"],
    ["activeAction", "lastAction"]);
  if (!isPluginUiUuid(r.instanceId) || !isPluginUiRevision(r.revision)
    || !oneOf(r.status, ["open", "resolved", "dismissed"])
    || typeof r.readOnly !== "boolean" || !oneOf(r.theme, ["light", "dark"])
    || !oneOf(r.surface, ["tool-result", "session-sidebar"]) || !text(r.locale)) fail();
  if (!isPluginUiJsonRecord(r.data, PLUGIN_UI_LIMITS.dataBytes)) fail();
  if (!Array.isArray(r.actions) || r.actions.length > PLUGIN_UI_LIMITS.actionsPerComponent) fail();
  const ids = new Set<string>();
  for (const action of r.actions) {
    const a = record(action);
    exact(a, ["id", "label", "completion"]);
    if (!text(a.id) || !text(a.label, PLUGIN_UI_LIMITS.titleCodePoints)
      || !oneOf(a.completion, ["keep-open", "resolve"]) || ids.has(a.id)) fail();
    ids.add(a.id);
  }
  if (Object.hasOwn(r, "activeAction")) {
    const receipt = parsePluginUiBridgeReceipt(r.activeAction);
    if (receipt.instanceId !== r.instanceId || receipt.revision > (r.revision as number)) fail();
  }
  if (Object.hasOwn(r, "lastAction")) {
    const last = record(r.lastAction);
    exact(last, ["receipt", "executionState", "message"]);
    const receipt = parsePluginUiBridgeReceipt(last.receipt);
    if (receipt.instanceId !== r.instanceId || receipt.revision > (r.revision as number)
      || !oneOf(last.executionState, ["not_started", "completed", "unknown"])
      || typeof last.message !== "string" || [...last.message].length > PLUGIN_UI_BRIDGE_LIMITS.resultCodePoints) fail();
  }
  bytes(r, PLUGIN_UI_BRIDGE_LIMITS.snapshotBytes);
  return structuredClone(r) as unknown as PluginUiViewSnapshot;
}
export function parsePluginUiBridgeRequest(value: unknown): PluginUiBridgeRequest {
  const r = record(value);
  exact(r, ["version", "mountId", "id", "method", "params"]);
  envelope(r);
  if (!text(r.id, 80)) fail();
  const p = record(r.params);
  switch (r.method) {
    case "getSnapshot": case "openSidebar": exact(p, []); break;
    case "resize":
      exact(p, ["height"]);
      if (typeof p.height !== "number" || !Number.isFinite(p.height)
        || p.height < PLUGIN_UI_BRIDGE_LIMITS.minHeight || p.height > PLUGIN_UI_BRIDGE_LIMITS.maxHeight) fail();
      break;
    case "dismiss":
      exact(p, ["expectedRevision"]);
      if (!isPluginUiRevision(p.expectedRevision)) fail();
      break;
    case "requestAction":
      exact(p, ["actionId", "args", "expectedRevision"]);
      if (!text(p.actionId) || !isPluginUiRevision(p.expectedRevision)) fail();
      const checked = validatePluginUiJsonRecord(p.args, PLUGIN_UI_LIMITS.actionArgsBytes);
      if (!checked.valid) fail(checked.reason === "payload_too_large" ? "plugin_ui_payload_too_large" : "plugin_ui_invalid_message");
      break;
    default: fail("plugin_ui_method_not_supported");
  }
  bytes(r, PLUGIN_UI_BRIDGE_LIMITS.requestBytes);
  return structuredClone(r) as unknown as PluginUiBridgeRequest;
}
export function readPluginUiBridgeResponse(value: unknown): PluginUiBridgeResponse | undefined {
  try {
    const r = record(value);
    envelope(r);
    if (!text(r.id, 80)) fail();
    if (Object.hasOwn(r, "error")) {
      exact(r, ["version", "mountId", "id", "error"]);
      const e = record(r.error); exact(e, ["code", "message"]);
      if (!text(e.code, 80) || !/^plugin_ui_[a-z0-9_]+$/.test(e.code)
        || typeof e.message !== "string" || [...e.message].length > 1024) fail();
    } else {
      exact(r, ["version", "mountId", "id", "result"]);
      if (r.result !== null) {
        const result = record(r.result);
        if (Object.hasOwn(result, "requestId")) parsePluginUiBridgeReceipt(result);
        else parsePluginUiBridgeSnapshot(result);
      }
    }
    bytes(r, PLUGIN_UI_BRIDGE_LIMITS.snapshotBytes);
    return structuredClone(r) as unknown as PluginUiBridgeResponse;
  } catch { return undefined; }
}
export function readPluginUiBridgeNotification(value: unknown): PluginUiBridgeNotification | undefined {
  try {
    const r = record(value); envelope(r);
    if (r.type === "dispose") exact(r, ["version", "mountId", "type"]);
    else if (r.type === "snapshot") {
      exact(r, ["version", "mountId", "type", "snapshot"]);
      parsePluginUiBridgeSnapshot(r.snapshot);
    } else fail();
    bytes(r, PLUGIN_UI_BRIDGE_LIMITS.snapshotBytes);
    return structuredClone(r) as unknown as PluginUiBridgeNotification;
  } catch { return undefined; }
}
/** Wire JSON is size-checked before parsing; domain validators own their depth limits. */
export function decodePluginUiBridgeMessage(value: unknown, maximum: number = PLUGIN_UI_BRIDGE_LIMITS.requestBytes): unknown {
  if (typeof value !== "string") fail();
  if (value.length > maximum || new TextEncoder().encode(value).byteLength > maximum) fail("plugin_ui_payload_too_large");
  try { return JSON.parse(value); } catch { return fail(); }
}
export function encodePluginUiBridgeMessage(value: unknown): string {
  const r = record(value);
  if (Object.hasOwn(r, "method")) return JSON.stringify(parsePluginUiBridgeRequest(r));
  const message = Object.hasOwn(r, "type") ? readPluginUiBridgeNotification(r) : readPluginUiBridgeResponse(r);
  if (!message) fail();
  return JSON.stringify(message);
}
