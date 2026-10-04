import type { workflowRuns } from "../session-runtime/schema.js";

export interface StoredWorkflowRunInput {
  runId: string;
  ownerSessionId?: string;
  ownerInputId?: string;
  ownerRunId?: string;
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
  return {
    runId: row.runId,
    ...(row.ownerSessionId
      ? { ownerSessionId: row.ownerSessionId }
      : {}),
    ...(row.ownerInputId ? { ownerInputId: row.ownerInputId } : {}),
    ...(row.ownerRunId ? { ownerRunId: row.ownerRunId } : {}),
    status: row.status,
    ...(row.termination ? { termination: row.termination } : {}),
    snapshotJson: row.snapshotJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
