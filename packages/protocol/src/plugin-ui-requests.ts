import {
  validatePluginUiJsonRecord, isPluginUiRecord, isPluginUiRevision, isPluginUiUuid, PLUGIN_UI_LIMITS,
  type DismissPluginUiInput, type InvokePluginUiActionInput,
} from "./plugin-ui.js";
import { ProtocolValidationError } from "./requests.js";

export function parsePluginUiRouteIds(value: { sessionId: string; instanceId: string; requestId?: string }) {
  if (!value.sessionId.trim()) throw new ProtocolValidationError("sessionId is required", "sessionId");
  if (!isPluginUiUuid(value.instanceId)) throw new ProtocolValidationError("instanceId must be a UUID", "instanceId");
  if (value.requestId !== undefined && !isPluginUiUuid(value.requestId)) throw new ProtocolValidationError("requestId must be a UUID", "requestId");
  return value;
}

function request(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isPluginUiRecord(value)) throw new ProtocolValidationError("Request body must be a JSON object");
  const unknown = Object.keys(value).find(key => !fields.includes(key));
  if (unknown !== undefined) throw new ProtocolValidationError(`Unknown Plugin UI field: ${unknown}`, unknown);
  if (!isPluginUiUuid(value.requestId)) throw new ProtocolValidationError("requestId must be a UUID", "requestId");
  if (!isPluginUiRevision(value.expectedRevision)) {
    throw new ProtocolValidationError("expectedRevision must be a nonnegative safe integer", "expectedRevision");
  }
  return value;
}

export function parseInvokePluginUiActionInput(value: unknown): InvokePluginUiActionInput {
  const body = request(value, ["requestId", "expectedRevision", "actionId", "args"]);
  if (typeof body.actionId !== "string" || !body.actionId.trim()) {
    throw new ProtocolValidationError("actionId must be a nonempty string", "actionId");
  }
  const args = validatePluginUiJsonRecord(body.args, PLUGIN_UI_LIMITS.actionArgsBytes);
  if (!args.valid) {
    throw new ProtocolValidationError("args must be finite JSON within Plugin UI size and depth limits", "args", args.reason);
  }
  return { requestId: body.requestId as string, expectedRevision: body.expectedRevision as number, actionId: body.actionId, args: args.value };
}

export function parseDismissPluginUiInput(value: unknown): DismissPluginUiInput {
  const body = request(value, ["requestId", "expectedRevision"]);
  return { requestId: body.requestId as string, expectedRevision: body.expectedRevision as number };
}
