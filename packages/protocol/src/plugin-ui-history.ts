export { type PluginUiInventory, type PluginUiInstanceRecord, type PluginUiActionReceipt, type PluginUiActionResponse, type PluginUiActionRunMetadata, readPluginUiInstance, readPluginUiAction, type PluginUiConversationReceipt, type PluginUiSubmissionRecord } from "@vykor/domain-contracts/plugin-apps/history";
import { parsePluginUiConversationReceipt as domainConversationReceipt, parsePluginUiSubmissionRecord as domainSubmissionRecord, type PluginUiConversationReceipt, type PluginUiSubmissionRecord } from "@vykor/domain-contracts/plugin-apps/history";
import { isUuid as isPluginUiUuid } from "./json.js";
import { ProtocolValidationError } from "./requests.js";
import { adaptDomainValidation } from "./domain-validation.js";
export function parsePluginUiConversationReceipt(value: unknown): PluginUiConversationReceipt { return adaptDomainValidation(() => domainConversationReceipt(value)); }
export function parsePluginUiSubmissionRecord(value: unknown): PluginUiSubmissionRecord { return adaptDomainValidation(() => domainSubmissionRecord(value)); }
export function parsePluginUiRouteIds(value: { sessionId: string; instanceId: string; requestId?: string }) {
  if (!value.sessionId.trim()) throw new ProtocolValidationError("sessionId is required", "sessionId");
  if (!isPluginUiUuid(value.instanceId)) throw new ProtocolValidationError("instanceId must be a UUID", "instanceId");
  if (value.requestId !== undefined && !isPluginUiUuid(value.requestId)) throw new ProtocolValidationError("requestId must be a UUID", "requestId");
  return value;
}
