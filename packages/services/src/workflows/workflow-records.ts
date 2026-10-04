import type { workflowRuns } from "../session-runtime/schema.js";
import { parseChatResourceSource, type ChatResourceSource } from "@vykor/protocol";

export interface StoredWorkflowRunInput {
  runId: string;
  ownerSessionId?: string;
  ownerInputId?: string;
  ownerRunId?: string;
  origin?: ChatResourceSource;
  status: string;
  termination?: string;
  snapshotJson: string;
  createdAt: number;
  updatedAt: number;
  taskAttempts: Array<{
    taskId: string;
    attempt: number;
    status: string;
    payloadJson: string;
    startedAt: number;
    finishedAt?: number;
  }>;
}

export interface StoredWorkflowRunRecord
  extends Omit<StoredWorkflowRunInput, "taskAttempts"> {}

export interface StoredWorkflowEventInput {
  runId: string;
  type: string;
  eventJson: string;
  createdAt: number;
}

/** 原始事件记录：`id` 是持久层稳定序号，用于在不泄漏内容的前提下定位坏记录。 */
export interface StoredWorkflowEventRecord {
  id: string;
  eventJson: string;
}

export interface WorkflowRunClaim {
  ownerId: string;
  generation: number;
  claimedAt: number;
}

export function storedWorkflowRunFromRow(
  row: typeof workflowRuns.$inferSelect,
): StoredWorkflowRunRecord {
  const origin = row.originJson ? parseChatResourceSource(JSON.parse(row.originJson)) : undefined;
  const ownerSessionId = row.ownerSessionId ?? (origin?.storage === "memory" ? origin.sessionId : undefined);
  const ownerInputId = row.ownerInputId ?? (origin?.storage === "memory" ? origin.inputId : undefined);
  const ownerRunId = row.ownerRunId ?? (origin?.storage === "memory" ? origin.runId : undefined);
  return {
    runId: row.runId,
    ...(ownerSessionId
      ? { ownerSessionId }
      : {}),
    ...(ownerInputId ? { ownerInputId } : {}),
    ...(ownerRunId ? { ownerRunId } : {}),
    ...(origin ? { origin } : {}),
    status: row.status,
    ...(row.termination ? { termination: row.termination } : {}),
    snapshotJson: row.snapshotJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
