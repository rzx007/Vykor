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

export interface WorkflowRunClaim {
  ownerId: string;
  generation: number;
  claimedAt: number;
}

export function storedWorkflowRunFromRow(
  row: Record<string, unknown>,
): StoredWorkflowRunRecord {
  return {
    runId: row.run_id as string,
    ...(row.owner_session_id
      ? { ownerSessionId: row.owner_session_id as string }
      : {}),
    ...(row.owner_input_id ? { ownerInputId: row.owner_input_id as string } : {}),
    ...(row.owner_run_id ? { ownerRunId: row.owner_run_id as string } : {}),
    status: row.status as string,
    ...(row.termination ? { termination: row.termination as string } : {}),
    snapshotJson: row.snapshot_json as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
