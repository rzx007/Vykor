/** Product application query results; adapted to transport at HTTP. */
import type { PluginAppSource, PluginAppRecord, PluginAppActionReceipt } from "@vykor/domain-contracts/plugin-apps";
import type { PluginAppRuntimeLease, PluginAppToolDescriptor } from "@vykor/plugin-contracts/runtime";
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

export interface PluginAppAdmissionRejection {
  code: "plugin_app_not_accepted";
  reason?: "busy";
  kind: "tool" | "message";
  source: PluginAppSource;
  requestId: string;
  expectedRevision: number;
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
