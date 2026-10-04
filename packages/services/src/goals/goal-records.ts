import type {
  GoalAssessment,
  GoalStatus,
  GoalWait,
  SessionGoal,
} from "@vykor/protocol";
import type {
  sessionGoalRequests,
  sessionGoals,
} from "../session-runtime/schema.js";

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

export function sessionGoalFromRow(
  row: typeof sessionGoals.$inferSelect,
): SessionGoal {
  const wait =
    typeof row.waitJson === "string"
      ? (JSON.parse(row.waitJson) as GoalWait)
      : undefined;
  const evidence =
    typeof row.evidenceJson === "string"
      ? (JSON.parse(row.evidenceJson) as string[])
      : [];
  const assessment =
    typeof row.lastAssessmentJson === "string"
      ? (JSON.parse(row.lastAssessmentJson) as GoalAssessment)
      : undefined;
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    objective: String(row.objective),
    ...(typeof row.pluginId === "string" ? { pluginId: row.pluginId } : {}),
    revision: Number(row.revision),
    status: String(row.status) as GoalStatus,
    maxAutoTurns: Number(row.maxAutoTurns),
    autoTurnsUsed: Number(row.autoTurnsUsed),
    noProgressCount: Number(row.noProgressCount),
    ...(typeof row.blockerKey === "string"
      ? { blockerKey: row.blockerKey }
      : {}),
    ...(typeof row.currentRunId === "string"
      ? { currentRunId: row.currentRunId }
      : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    ...(wait ? { wait } : {}),
    evidence,
    ...(assessment ? { assessment } : {}),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export function goalRequestFromRow(
  row: typeof sessionGoalRequests.$inferSelect,
): SessionGoalRequestRecord {
  return {
    requestId: String(row.requestId),
    sessionId: String(row.sessionId),
    fingerprint: String(row.fingerprint),
    status: String(row.status) as SessionGoalRequestRecord["status"],
    ...(typeof row.goalId === "string" ? { goalId: row.goalId } : {}),
    ...(typeof row.resultJson === "string"
      ? { result: JSON.parse(row.resultJson) as Record<string, unknown> }
      : {}),
    ...(typeof row.error === "string" ? { error: row.error } : {}),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}
