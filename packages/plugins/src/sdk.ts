import type { ToolResult } from "@vykor/core";
import type { VykorPluginPermissions } from "./types.js";

export type { ToolResult } from "@vykor/core";
export type { VykorPluginPermissions } from "./types.js";

export interface NativeToolPluginIdentity {
  id: string;
  name: string;
  version: string;
  root: string;
  /** Stable per-plugin data directory, independent of the installed version and cwd. */
  dataDir: string;
}

export interface NativeToolRegistrationContext {
  plugin: NativeToolPluginIdentity;
  permissions: VykorPluginPermissions;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface NativeToolInvocationContext {
  plugin: NativeToolPluginIdentity;
  permissions: VykorPluginPermissions;
  cwd: string;
  sessionId?: string;
  runId?: string;
  /** Actual bounded result selected by toolResultInput; current Run only. */
  readonly toolResult?: { toolUseId: string; toolName: string; content: ToolResult["content"]; isError?: boolean };
  /** Unix timestamp in milliseconds at which the call expires. */
  deadline: number;
  /** Host cancellation notification, for cooperative asynchronous work. */
  signal: AbortSignal;
}

export interface NativeToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  safeToRetry?: boolean;
  /** Input property containing an earlier tool call ID; the host resolves it without model-supplied content. */
  toolResultInput?: string;
  invoke(input: Record<string, unknown>, context: NativeToolInvocationContext): ToolResult | Promise<ToolResult>;
}

export type NativeToolRegister = (
  context: NativeToolRegistrationContext,
) => NativeToolDefinition[] | Promise<NativeToolDefinition[]>;
