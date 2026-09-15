import type {
  GoalAssessment,
  GoalStatus,
  GoalWait,
  SessionGoal,
} from "@openharness/protocol";

export interface CreateSessionGoalStoreInput {
  id?: string;
  sessionId: string;
  objective: string;
  pluginId?: string;
  maxAutoTurns: number;
}

export interface UpdateSessionGoalStoreInput {
  expectedRevision: number;
  objective?: string;
  pluginId?: string;
  status?: GoalStatus;
  maxAutoTurns?: number;
  autoTurnsUsed?: number;
  noProgressCount?: number;
  blockerKey?: string | null;
  currentRunId?: string | null;
  reason?: string | null;
  wait?: GoalWait | null;
  evidence?: string[];
  assessment?: GoalAssessment | null;
}

export interface SessionGoalRequestRecord {
  requestId: string;
  sessionId: string;
  fingerprint: string;
  status: "pending" | "completed" | "failed";
  goalId?: string;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export function sessionGoalFromRow(row: Record<string, unknown>): SessionGoal {
  const wait =
    typeof row.wait_json === "string"
      ? (JSON.parse(row.wait_json) as GoalWait)
      : undefined;
  const evidence =
    typeof row.evidence_json === "string"
      ? (JSON.parse(row.evidence_json) as string[])
      : [];
  const assessment =
    typeof row.last_assessment_json === "string"
      ? (JSON.parse(row.last_assessment_json) as GoalAssessment)
      : undefined;
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    objective: String(row.objective),
    ...(typeof row.plugin_id === "string" ? { pluginId: row.plugin_id } : {}),
    revision: Number(row.revision),
    status: String(row.status) as GoalStatus,
    maxAutoTurns: Number(row.max_auto_turns),
    autoTurnsUsed: Number(row.auto_turns_used),
    noProgressCount: Number(row.no_progress_count),
    ...(typeof row.blocker_key === "string"
      ? { blockerKey: row.blocker_key }
      : {}),
    ...(typeof row.current_run_id === "string"
      ? { currentRunId: row.current_run_id }
      : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    ...(wait ? { wait } : {}),
    evidence,
    ...(assessment ? { assessment } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function goalRequestFromRow(
  row: Record<string, unknown>,
): SessionGoalRequestRecord {
  return {
    requestId: String(row.request_id),
    sessionId: String(row.session_id),
    fingerprint: String(row.fingerprint),
    status: String(row.status) as SessionGoalRequestRecord["status"],
    ...(typeof row.goal_id === "string" ? { goalId: row.goal_id } : {}),
    ...(typeof row.result_json === "string"
      ? { result: JSON.parse(row.result_json) as Record<string, unknown> }
      : {}),
    ...(typeof row.error === "string" ? { error: row.error } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
