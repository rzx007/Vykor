import type { TerminalEventListener } from "./events";
import type {
  TerminalCreateRequest,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalSignalRequest,
  TerminalWaitResult,
  TerminalWriteRequest,
} from "@vykor/protocol";

/** Terminal 包对外汇总它实际使用的跨端协议类型。 */
export type {
  TerminalCreateRequest,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalRuntime,
  TerminalSessionInfo,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSignalRequest,
  TerminalScope,
  TerminalSource,
  TerminalWaitResult,
  TerminalWriteRequest,
} from "@vykor/protocol";

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
  list(): Promise<TerminalSessionInfo[]>;
  subscribe(listener: TerminalEventListener): () => void;
}

export type TerminalConnection = TerminalProvider;
