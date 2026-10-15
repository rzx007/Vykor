import type {
  projectionSettlements,
  sessionGoalContinuations,
  sessionGoalRequests,
  sessionGoalModelAttempts,
  sessionGoals,
  sessionGoalVersions,
} from "../session-runtime/schema.js";
import type { TransactionJournal } from "./transaction-journal.js";

export interface TemporaryControlSnapshot {
  goals: Map<string, typeof sessionGoals.$inferSelect>;
  versions: Map<string, typeof sessionGoalVersions.$inferSelect>;
  goalModelAttempts: Map<string, typeof sessionGoalModelAttempts.$inferSelect>;
  requests: Map<string, typeof sessionGoalRequests.$inferSelect>;
  continuations: Map<string, typeof sessionGoalContinuations.$inferSelect>;
  settlements: Map<string, typeof projectionSettlements.$inferSelect>;
}

/** Process-local rows for control records owned by temporary chats. */
export class TemporaryControlRecords implements TemporaryControlSnapshot {
  readonly goals: TemporaryControlSnapshot["goals"] = new Map();
  readonly versions: TemporaryControlSnapshot["versions"] = new Map();
  readonly goalModelAttempts: TemporaryControlSnapshot["goalModelAttempts"] = new Map();
  readonly requests: TemporaryControlSnapshot["requests"] = new Map();
  readonly continuations: TemporaryControlSnapshot["continuations"] = new Map();
  readonly settlements: TemporaryControlSnapshot["settlements"] = new Map();

  constructor(private readonly journal?: () => TransactionJournal | undefined) {}

  capture<K, V>(map: Map<K, V>, key: K): void {
    this.journal?.()?.captureMap(map, key);
  }

  snapshot(): TemporaryControlSnapshot {
    return structuredClone({
      goals: this.goals,
      versions: this.versions,
      goalModelAttempts: this.goalModelAttempts,
      requests: this.requests,
      continuations: this.continuations,
      settlements: this.settlements,
    });
  }

  restore(snapshot: TemporaryControlSnapshot): void {
    const rows = structuredClone(snapshot);
    replaceRows(this.goals, rows.goals);
    replaceRows(this.versions, rows.versions);
    replaceRows(this.goalModelAttempts, rows.goalModelAttempts);
    replaceRows(this.requests, rows.requests);
    replaceRows(this.continuations, rows.continuations);
    replaceRows(this.settlements, rows.settlements);
  }

  deleteSession(sessionId: string): void {
    const goalIds = new Set(
      [...this.goals.values()]
        .filter((row) => row.sessionId === sessionId)
        .map((row) => row.id),
    );
    for (const id of goalIds) {
      this.capture(this.goals, id);
      this.goals.delete(id);
    }
    for (const [key, row] of this.goalModelAttempts) {
      if (goalIds.has(row.goalId)) {
        this.capture(this.goalModelAttempts, key);
        this.goalModelAttempts.delete(key);
      }
    }
    for (const [key, row] of this.versions) {
      if (goalIds.has(row.goalId)) {
        this.capture(this.versions, key);
        this.versions.delete(key);
      }
    }
    for (const [id, row] of this.requests) {
      if (row.sessionId === sessionId) {
        this.capture(this.requests, id);
        this.requests.delete(id);
      }
    }
    for (const [id, row] of this.continuations) {
      if (goalIds.has(row.goalId)) {
        this.capture(this.continuations, id);
        this.continuations.delete(id);
      }
    }
    for (const [id, row] of this.settlements) {
      if (row.rootSessionId === sessionId) {
        this.capture(this.settlements, id);
        this.settlements.delete(id);
      }
    }
  }
}

function replaceRows<T>(target: Map<string, T>, rows: Map<string, T>): void {
  target.clear();
  for (const [id, row] of rows) target.set(id, row);
}
