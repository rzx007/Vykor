import type {
  AgentChildResult,
  ChildFailureKind,
  ChildPartialResult,
} from "@vykor/agent-contracts";
import type { Settings } from "@vykor/host-config";
import type { ShellDescriptor, EnvironmentProcessExecutor } from "@vykor/environment";
import type { SandboxPolicy } from "@vykor/sandbox";

export type ExecutionBackend = "detached_process" | "child_agent";
export type ExecutionType = "shell" | "agent" | "dream";
export type ExecutionStatus = "pending" | "running" | "stopping" | "completed" | "failed" | "stopped";
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

export type ProcessCompletionListener = (
  execution: DetachedProcessExecution,
) => void | Promise<void>;
export type ProcessExecutionListener = (
  execution: DetachedProcessExecution,
  event: ExecutionEvent,
) => void | Promise<void>;
export interface AwaitExecutionResult {
  status: ExecutionStatus;
  output: string;
  /** Exact framework-child outcome; process backends may omit it. */
  failureKind?: AgentChildResult["status"];
  /** Trusted child failure source; process backends never set it. */
  childFailureKind?: ChildFailureKind;
  /** Bounded unfinished work from a framework child; process backends never set it. */
  partialResult?: ChildPartialResult;
  /** The timeout stop could not be confirmed within the cleanup grace window. */
  cleanupUnconfirmed?: boolean;
  exitCode?: number;
  timedOut?: boolean;
}

export interface ShellAdmissionPorts {
  reserve(input: StartShellExecutionOptions): Promise<void>;
  load(id: string): Promise<DetachedProcessExecution | undefined>;
  save(execution: DetachedProcessExecution): Promise<void>;
  acquireEnvironment(input: StartShellExecutionOptions): Promise<{ launch: StartShellExecutionOptions; release(): Promise<void> }>;
}

export interface StartShellExecutionOptions {
  executionCwd?: string;
  shellDescriptor?: ShellDescriptor;
  requestId?: string;
  requestNamespace?: string;
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

export interface ExecutionRuntimeScope {
  cwd: string;
  sessionId?: string;
}
