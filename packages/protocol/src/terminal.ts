import type { JobStatus } from "./job.js";

export type TerminalRuntime = "local" | "environment";
export type TerminalSessionStatus = JobStatus;
export type TerminalSource = "user" | "agent";
export type TerminalSignal = "interrupt" | "eof" | "terminate";

export type TerminalScope =
  | { kind: "project"; projectId: string }
  | { kind: "session"; sessionId: string };

export interface TerminalCreateRequest {
  scope: TerminalScope;
  runtime: TerminalRuntime;
  cols: number;
  rows: number;
  name?: string;
  shell?: string;
  cwd?: string;
  source?: TerminalSource;
}

/** 可以通过 HTTP/SSE 发送的终端状态，不包含 PTY 或子进程对象。 */
export interface TerminalSessionInfo {
  id: string;
  name: string;
  scope: TerminalScope;
  projectId?: string;
  runtime: TerminalRuntime;
  source: TerminalSource;
  sessionId?: string;
  status: TerminalSessionStatus;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: string;
  exitedAt?: string;
  exitCode?: number | null;
}

export interface TerminalWriteRequest {
  terminalId: string;
  data: string;
}

export interface TerminalResizeRequest {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalReadRequest {
  terminalId: string;
  after?: number;
  maxChars?: number;
}

export interface TerminalReadResult {
  terminalId: string;
  data: string;
  sequence: number;
  truncated: boolean;
}

export interface TerminalSignalRequest {
  terminalId: string;
  signal: TerminalSignal;
}

export interface TerminalWaitResult extends TerminalReadResult {
  terminal: TerminalSessionInfo;
  timedOut: boolean;
}

export type TerminalEvent =
  | { type: "data"; terminalId: string; data: string; sequence: number }
  | { type: "status"; terminalId: string; status: "stopping" | "killed" }
  | { type: "exit"; terminalId: string; exitCode: number | null }
  | { type: "title"; terminalId: string; title: string }
  | { type: "error"; terminalId: string; message: string };
