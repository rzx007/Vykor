import type { VykorPluginPermissions } from "@vykor/plugins";
import type {
  NativeToolDefinition,
  NativeToolInvocationContext,
  NativeToolPluginIdentity,
} from "@vykor/plugins/sdk";

export type NativeToolRegistration = Pick<
  NativeToolDefinition,
  "name" | "description" | "inputSchema" | "safeToRetry"
>;

export type NativeToolCallContext = Pick<NativeToolInvocationContext, "cwd" | "sessionId" | "deadline">;

export interface NativeToolHostRequest {
  type: "request";
  id: string;
  method: "healthcheck" | "registerTools" | "callTool" | "shutdown";
  payload?: unknown;
}

export interface NativeToolHostCancel {
  type: "cancel";
  id: string;
}

export interface NativeToolHostResponse {
  type: "response";
  id: string;
  result?: unknown;
  error?: { code: string; message: string; stack?: string };
}

export interface NativeToolHostLog {
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface RegisterToolsPayload {
  plugin: NativeToolPluginIdentity;
  entries: Array<{
    entryPath: string;
    permissions: VykorPluginPermissions;
  }>;
}
