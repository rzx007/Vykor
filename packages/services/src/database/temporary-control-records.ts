import type {
  projectionSettlements,
  sessionGoalAssessments,
  sessionGoalContinuations,
  sessionGoalRequests,
  sessionGoals,
} from "../session-runtime/schema.js";

export interface TemporaryControlSnapshot {
  goals: Map<string, typeof sessionGoals.$inferSelect>;
  requests: Map<string, typeof sessionGoalRequests.$inferSelect>;
  assessments: Map<string, typeof sessionGoalAssessments.$inferSelect>;
  continuations: Map<string, typeof sessionGoalContinuations.$inferSelect>;
  settlements: Map<string, typeof projectionSettlements.$inferSelect>;
}

/** Process-local rows for control records owned by temporary chats. */
export class TemporaryControlRecords implements TemporaryControlSnapshot {
  readonly goals: TemporaryControlSnapshot["goals"] = new Map();
  readonly requests: TemporaryControlSnapshot["requests"] = new Map();
  readonly assessments: TemporaryControlSnapshot["assessments"] = new Map();
  readonly continuations: TemporaryControlSnapshot["continuations"] = new Map();
  readonly settlements: TemporaryControlSnapshot["settlements"] = new Map();

  snapshot(): TemporaryControlSnapshot {
    return structuredClone({
      goals: this.goals,
      requests: this.requests,
      assessments: this.assessments,
      continuations: this.continuations,
      settlements: this.settlements,
    });
  }

  restore(snapshot: TemporaryControlSnapshot): void {
    const rows = structuredClone(snapshot);
    replaceRows(this.goals, rows.goals);
    replaceRows(this.requests, rows.requests);
    replaceRows(this.assessments, rows.assessments);
    replaceRows(this.continuations, rows.continuations);
    replaceRows(this.settlements, rows.settlements);
  }

  deleteSession(sessionId: string): void {
    const goalIds = new Set(
      [...this.goals.values()]
        .filter((row) => row.sessionId === sessionId)
        .map((row) => row.id),
    );
    for (const id of goalIds) this.goals.delete(id);
    for (const [id, row] of this.requests) {
      if (row.sessionId === sessionId) this.requests.delete(id);
    }
    for (const [id, row] of this.assessments) {
      if (goalIds.has(row.goalId)) this.assessments.delete(id);
    }
    for (const [id, row] of this.continuations) {
      if (goalIds.has(row.goalId)) this.continuations.delete(id);
    }
    for (const [id, row] of this.settlements) {
      if (row.rootSessionId === sessionId) this.settlements.delete(id);
    }
  }
}

function replaceRows<T>(target: Map<string, T>, rows: Map<string, T>): void {
  target.clear();
  for (const [id, row] of rows) target.set(id, row);
}
