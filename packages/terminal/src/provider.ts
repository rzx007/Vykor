import type { TerminalEventListener } from "./events";
import type { TerminalCreateRequest, TerminalReadRequest, TerminalReadResult, TerminalResizeRequest, TerminalSessionInfo, TerminalSignalRequest, TerminalWaitResult, TerminalWriteRequest } from "./contracts.js";

export type { TerminalCreateRequest, TerminalReadRequest, TerminalReadResult, TerminalResizeRequest, TerminalRuntime, TerminalSessionInfo, TerminalSessionStatus, TerminalSignal, TerminalSignalRequest, TerminalScope, TerminalSource, TerminalWaitResult, TerminalWriteRequest } from "./contracts.js";

export interface TerminalWaitRequest extends TerminalReadRequest {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AgentTerminalOpenRequest {
  sessionId: string;
  cwd: string;
  name?: string;
  cols?: number;
  rows?: number;
  shell?: string;
  command?: string;
}

/** Host-owned Terminal producer. Observation and control use AgentJobHost. */
export interface AgentTerminalHost {
  open(input: AgentTerminalOpenRequest): Promise<TerminalSessionInfo>;
}

export interface TerminalProvider {
  create(input: TerminalCreateRequest): Promise<TerminalSessionInfo>;
  write(input: TerminalWriteRequest): Promise<void>;
  resize(input: TerminalResizeRequest): Promise<void>;
  read(input: TerminalReadRequest): Promise<TerminalReadResult>;
  wait(input: TerminalWaitRequest): Promise<TerminalWaitResult>;
  signal(input: TerminalSignalRequest): Promise<void>;
  kill(terminalId: string): Promise<void>;
  get(terminalId: string): Promise<TerminalSessionInfo | undefined>;
  list(): Promise<TerminalSessionInfo[]>;
  subscribe(listener: TerminalEventListener): () => void;
}

export type TerminalConnection = TerminalProvider;
