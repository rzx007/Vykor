import type { ToolDispatchReceipt, ToolExecutionResult, ToolOperationTicket } from "@vykor/agent-contracts/tool-data";

export interface ToolReconciliationRecord {
  outcome: "applied" | "not_applied" | "unknown";
  evidence: string;
  at: number;
}

/** 一次 Run 的执行头；S1 不保存续跑检查点。 */
export interface ExecutionRecord {
  id: string;
  sessionId: string;
  runId: string;
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ToolOperationRecord extends ToolOperationTicket {
  id: string;
  sessionId: string;
  runId: string;
  executionId: string;
  agentId: string;
  inputId: string;
  traceId: string;
  cwd: string;
  toolCallId: string;
  generationId?: string;
  toolName: string;
  /** 宿主确认的来源及版本；不序列化定义、函数或凭据。 */
  toolIdentity: string;
  normalizedInput: Record<string, unknown>;
  parentOperationId?: string;
  policyVersion?: string;
  activeAttemptId?: string;
  reconciliation?: ToolReconciliationRecord;
  reconciliations?: ToolReconciliationRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface ToolDispatchAttemptRecord extends ToolDispatchReceipt {
  id: string;
  sessionId: string;
  runId: string;
  executionId: string;
  status: "dispatching" | "confirmed" | "not_applied" | "unknown";
  startedAt: number;
  finishedAt?: number;
  result?: ToolExecutionResult;
  reconciliations?: ToolReconciliationRecord[];
}
