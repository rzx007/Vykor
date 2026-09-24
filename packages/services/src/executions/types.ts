import type { AgentChildResult, Settings } from "@vykor/core";
import type { EnvironmentProcessExecutor } from "@vykor/environment";
import type { SandboxPolicy } from "@vykor/sandbox";

export type ExecutionBackend = "detached_process" | "child_agent";
export type ExecutionType = "shell" | "agent" | "dream";
export type ExecutionStatus = "pending" | "running" | "completed" | "failed" | "stopped";
export type ExecutionEvent = "created" | "updated" | "completed";

export interface ExecutionSnapshot {
  id: string;
  backend: ExecutionBackend;
  type: ExecutionType;
  status: ExecutionStatus;
  description: string;
  cwd: string;
  sessionId?: string;
  prompt?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  outputFile?: string;
  metadata: Record<string, string>;
}

export interface DetachedProcessExecution extends ExecutionSnapshot {
  backend: "detached_process";
  processExitCode?: number | null;
  command?: string;
  argv?: string[];
  env?: Record<string, string>;
}

export interface ChildAgentExecution extends ExecutionSnapshot {
  backend: "child_agent";
  type: "agent";
  sessionId: string;
  prompt: string;
}

export type ProcessCompletionListener = (
  execution: DetachedProcessExecution,
) => void | Promise<void>;
export type ProcessExecutionListener = (
  execution: DetachedProcessExecution,
  event: ExecutionEvent,
) => void | Promise<void>;
export type ChildAgentExecutionListener = (
  execution: ChildAgentExecution,
  event: ExecutionEvent,
) => void | Promise<void>;

export interface AwaitExecutionResult {
  status: ExecutionStatus;
  output: string;
  /** Exact framework-child outcome; process backends may omit it. */
  failureKind?: AgentChildResult["status"];
  exitCode?: number;
  timedOut?: boolean;
}

export interface StartShellExecutionOptions {
  id?: string;
  command?: string;
  argv?: string[];
  description: string;
  cwd: string;
  sessionId?: string;
  type?: ExecutionType;
  env?: Record<string, string>;
  settings?: Settings;
  policy?: SandboxPolicy;
  processExecutor?: EnvironmentProcessExecutor;
}

export interface StartAgentProcessOptions {
  id?: string;
  prompt: string;
  description: string;
  cwd: string;
  sessionId?: string;
  type?: ExecutionType;
  model?: string;
  command?: string;
  argv?: string[];
  env?: Record<string, string>;
  settings?: Settings;
  policy?: SandboxPolicy;
  processExecutor?: EnvironmentProcessExecutor;
}

export interface RegisterChildAgentExecutionOptions {
  id?: string;
  description: string;
  cwd: string;
  sessionId: string;
  childSessionId: string;
  prompt: string;
  onInput(data: string): Promise<void>;
  onStop(): Promise<void>;
}

export interface CompleteChildAgentExecutionInput {
  status: Extract<ExecutionStatus, "completed" | "failed" | "stopped">;
  output: string;
}

export interface ExecutionRuntimeScope {
  cwd: string;
  sessionId?: string;
}
