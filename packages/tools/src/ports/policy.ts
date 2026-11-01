import type { Settings } from "@vykor/host-config";
import type { ShellOutputLogHost, ToolContext } from "@vykor/agent-contracts";
import type { AgentBackgroundShellHost } from "./host.js";

/** Host-selected settings snapshot, bound before model input is accepted. */
export interface ToolHostPolicyPort { readonly settings?: Settings }

export interface FileToolHost extends ToolHostPolicyPort {
  /** Host-only attachment bytes; validate ownership for the actual calling context. */
  readonly readAttachment?: (uri: string, context: ToolContext) => Promise<Uint8Array>;
  readonly shellOutputLogs?: ShellOutputLogHost;
  readonly outputPolicy?: { readonly inlineChars: number };
}

export interface ShellToolHost extends ToolHostPolicyPort {
  readonly backgroundShell?: AgentBackgroundShellHost;
  readonly shellOutputLogs?: ShellOutputLogHost;
}
