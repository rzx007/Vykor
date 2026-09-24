import type { StdioOptions } from "node:child_process";
import type { SandboxConfig, Settings } from "@vykor/core";
import type { EnvironmentExecutionOwner } from "@vykor/environment";

export type SandboxBackend = "srt";
export type SandboxPlatform = "linux" | "wsl" | "macos" | "windows" | "unknown";
export type SandboxNetworkMode = "none" | "bridge" | "host" | "proxy";
export type SandboxOperation = "read" | "write";
export type SandboxPolicyOperation = SandboxOperation | "execute" | "network";
export type SandboxFailureKind = "runner" | "policy" | "command";
export type SandboxPolicyMode = "off" | "read-only" | "workspace-write";
export type SandboxPolicyEnforcement = "off" | "best-effort" | "required";

export interface ResolvedSandboxConfig {
  enabled: boolean;
  backend: "srt";
  failIfUnavailable: boolean;
  enabledPlatforms: Array<"linux" | "wsl" | "macos">;
  filesystem: { allowRead: string[]; denyRead: string[]; allowWrite: string[]; denyWrite: string[]; extraAllowedRoots: string[] };
  network: { mode: SandboxNetworkMode; allowedDomains: string[]; deniedDomains: string[]; strictDomainPolicy: boolean };
  srt: { runtimeCommand: string };
}

export interface SandboxPolicyScope { cwd: string; workspaceRoot: string; sessionId?: string }
export interface SandboxPolicy {
  mode: SandboxPolicyMode; enforcement: SandboxPolicyEnforcement; enabled: boolean;
  backend: "srt"; failClosed: boolean; scope: SandboxPolicyScope;
  filesystem: ResolvedSandboxConfig["filesystem"]; network: ResolvedSandboxConfig["network"];
  config: ResolvedSandboxConfig;
}
export interface SandboxPolicyInput { cwd: string; workspaceRoot?: string; sessionId?: string; settings?: Settings; config?: SandboxConfig }
export interface SandboxPolicyService { resolvePolicy(input: SandboxPolicyInput): SandboxPolicy }
export interface SandboxPolicyDenial { kind: "policy"; code: "filesystem_denied" | "execution_denied" | "network_denied"; operation: SandboxPolicyOperation; reason: string }
export interface SandboxAvailability { enabled: boolean; available: boolean; active: boolean; backend?: "srt"; platform?: SandboxPlatform; reason?: string; degraded?: boolean; command?: string }
export type SandboxRuntimeEvent = { type: "check-availability" | "ready" | "unavailable"; backend: "srt"; reason?: string };
export type SandboxRuntimeReporter = (event: SandboxRuntimeEvent) => void;
export interface ShellSpawnOptions { cwd: string; settings?: Settings; stdio?: StdioOptions; env?: Record<string, string>; owner?: EnvironmentExecutionOwner; signal?: AbortSignal; detached?: boolean }
export interface ValidateSandboxPathOptions { sandboxRoot: string; operation: SandboxOperation; config?: SandboxConfig; policy?: SandboxPolicy; extraAllowedRoots?: string[] }
export interface SandboxPathValidationResult { allowed: boolean; decision: "allow" | "deny"; resolvedPath: string; reason?: string; failureKind?: "policy"; denial?: SandboxPolicyDenial }
