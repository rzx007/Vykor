import type { Settings } from "@vykor/host-config";
import type { ShellOutputLogHost } from "@vykor/agent-contracts";
import type { AgentBackgroundShellHost } from "./host.js";

/** Host-selected settings snapshot, bound before model input is accepted. */
export interface ToolHostPolicyPort { readonly settings?: Settings }

export interface FileToolHost extends ToolHostPolicyPort {
  readonly shellOutputLogs?: ShellOutputLogHost;
  readonly outputPolicy?: { readonly inlineChars: number };
}

export interface ShellToolHost extends ToolHostPolicyPort {
  readonly backgroundShell?: AgentBackgroundShellHost;
  readonly shellOutputLogs?: ShellOutputLogHost;
}
