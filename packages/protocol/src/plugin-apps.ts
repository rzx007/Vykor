import type { PluginAppRuntimeLease, PluginAppToolDescriptor } from "@vykor/plugin-contracts/runtime";
import { validatePluginAppConversationInput, validatePluginAppSource, validateOpenPluginAppInput, validateClosePluginAppInput,
  validatePluginAppToolInput, validatePluginAppComposerContexts, type PluginAppToolInput, type PluginAppConversationInput,
  type OpenPluginAppInput, type ClosePluginAppInput, type ValidationResult,
  type PluginAppRecord, type PluginAppSource, type PluginAppActionReceipt } from "@vykor/domain-contracts/plugin-apps";

export type { PluginAppResourceDefinition, PluginAppNativeToolDefinition, PluginAppToolPolicyDefinition,
  PluginAppNativeBackendDefinition, PluginAppMcpBackendDefinition, PluginAppBackendDefinition,
  PluginAppSurfaceDefinition, PluginAppManifest, PluginAppBackendKind } from "@vykor/plugin-contracts/manifest";
export type { PluginAppRuntimeLease, PluginAppToolPolicy, PluginAppToolDescriptor, PluginAppToolOrigin } from "@vykor/plugin-contracts/runtime";
export type { PluginAppJson } from "@vykor/plugin-contracts/runtime-data";
export { copyPluginAppJson } from "@vykor/plugin-contracts/runtime-data";
export type { PluginAppRecord, PluginAppSource, PluginAppOrigin, PluginAppActionMetadata,
  PluginAppActionReceipt, PluginAppSubmissionReceipt, PluginAppExecutionState } from "@vykor/domain-contracts/plugin-apps";
export { readPluginAppAction } from "@vykor/domain-contracts/plugin-apps";

export type { PluginAppInvokeInput, OpenPluginAppInput, ClosePluginAppInput } from "@vykor/domain-contracts/plugin-apps";
export interface PluginAppToolRequest extends PluginAppToolInput {}
export interface PluginAppAvailability {
  canReadResource: boolean;
  canInvokeTools: boolean;
  canMessage: boolean;
  reason?: "closed" | "revoked" | "session-unavailable" | "snapshot-changed" | "permission-missing" | "runtime-unavailable" | "action-unconfirmed";
}
export interface PluginAppResponse { source: PluginAppSource; app: PluginAppRecord; availability: PluginAppAvailability; lease?: PluginAppRuntimeLease; tools?: PluginAppToolDescriptor[] }
export interface PluginAppListResponse { apps: PluginAppResponse[] }
export interface PluginAppActionResponse {
  receipt: PluginAppActionReceipt;
  result?: import("@vykor/agent-contracts/tool-data").McpCallResultData;
  dataError?: "plugin_app_invalid_data" | "plugin_app_data_too_large" | "plugin_app_unsupported_content" | "plugin_app_result_unavailable";
}
export interface PluginAppConversationRequest extends PluginAppConversationInput {}

function parsed<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(result.code);
  return result.value;
}
export function parsePluginAppConversationRequest(value: unknown): PluginAppConversationRequest { return parsed(validatePluginAppConversationInput(value)); }
export function parsePluginAppSource(value: unknown): PluginAppSource { return parsed(validatePluginAppSource(value)); }
export function parseOpenPluginAppInput(value: unknown): OpenPluginAppInput { return parsed(validateOpenPluginAppInput(value)); }
export function parseClosePluginAppInput(value: unknown): ClosePluginAppInput { return parsed(validateClosePluginAppInput(value)); }
export function parsePluginAppToolRequest(value: unknown): PluginAppToolRequest { return parsed(validatePluginAppToolInput(value)); }
export function parsePluginAppComposerContexts(value: unknown): PluginAppConversationRequest[] { return parsed(validatePluginAppComposerContexts(value)); }
/** A synchronous admission failure, not a missing receipt or an execution-state estimate. */
export interface PluginAppAdmissionRejection {
  code: "plugin_app_not_accepted";
  reason?: "busy";
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
    && (proof.reason === undefined || proof.reason === "busy")
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
