import type { GoalStatus, GoalStopReason, GoalWait, GoalUsage, SessionGoal } from "@vykor/domain-contracts/goals";
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
  tokenBudget?: number;
}

export interface UpdateSessionGoalStoreInput {
  expectedRevision: number;
  objective?: string;
  objectiveVersion?: number;
  pluginId?: string;
  status?: GoalStatus;
  maxAutoTurns?: number;
  tokenBudget?: number | null;
  autoTurnsUsed?: number;
  currentRunId?: string | null;
  reason?: string | null;
  stopReason?: GoalStopReason | null;
  wait?: GoalWait | null;
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

export interface GoalContinuationRecord {
  goalId: string;
  revision: number;
  previousRunId: string;
  inputId: string;
  runId: string;
  status: "pending" | "dispatched" | "cancelled";
}

export function sessionGoalFromRow(
  row: typeof sessionGoals.$inferSelect,
): SessionGoal {
  const wait =
    typeof row.waitJson === "string"
      ? (JSON.parse(row.waitJson) as GoalWait)
      : undefined;
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    objective: String(row.objective),
    objectiveVersion: Number(row.objectiveVersion),
    ...(typeof row.pluginId === "string" ? { pluginId: row.pluginId } : {}),
    revision: Number(row.revision),
    status: String(row.status) as GoalStatus,
    maxAutoTurns: Number(row.maxAutoTurns),
    ...(row.tokenBudget === null ? {} : { tokenBudget: row.tokenBudget }),
    usage: JSON.parse(row.usageJson) as GoalUsage,
    autoTurnsUsed: Number(row.autoTurnsUsed),
    ...(typeof row.currentRunId === "string"
      ? { currentRunId: row.currentRunId }
      : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    ...(typeof row.stopReasonJson === "string"
      ? { stopReason: JSON.parse(row.stopReasonJson) as GoalStopReason }
      : {}),
    ...(wait ? { wait } : {}),
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
