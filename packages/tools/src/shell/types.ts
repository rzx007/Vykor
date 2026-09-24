import type { Settings } from "@vykor/core";
import type { HostShellLauncher, SandboxBackend, SandboxPolicy } from "@vykor/sandbox";

export interface ShellExecRequest {
  command: string;
  timeoutMs?: number;
  workdir?: string;
  env?: Record<string, string>;
  maxOutputChars?: number;
}

export interface ShellExecContext {
  cwd: string;
  sessionId?: string;
  settings?: Settings;
  policy?: SandboxPolicy;
}

export type ShellRunnerMode =
  | "host"
  | "sandbox-preferred"
  | "sandbox-required"
  | "sandbox-active";

export interface ShellRunnerSpec {
  mode: ShellRunnerMode;
  backend?: SandboxBackend;
  fallbackToHost: boolean;
}

export interface ShellExecSpec {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  env?: Record<string, string>;
  sessionId?: string;
  settings?: Settings;
  policy: SandboxPolicy;
  hostShell: HostShellLauncher;
  runner: ShellRunnerSpec;
}

export type ShellRunStatus = "completed" | "failed" | "timed_out" | "interrupted";
export type ShellFailureKind = "command" | "runner" | "policy" | "timeout" | "interrupted";

export interface ShellRunnerError {
  name: string;
  message: string;
}

export interface ShellRunResult {
  status: ShellRunStatus;
  failureKind?: ShellFailureKind;
  output: string;
  outputTruncated: boolean;
  exitCode: number | null;
  runnerError?: ShellRunnerError;
}

export interface ShellExecutor {
  resolve(request: ShellExecRequest, context: ShellExecContext): Promise<ShellExecSpec>;
  run(spec: ShellExecSpec, signal?: AbortSignal): Promise<ShellRunResult>;
}
