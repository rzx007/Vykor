import { and, asc, desc, eq, placeholder } from "drizzle-orm";

import type { StorageContext } from "../database/storage-context.js";
import {
  workflowEvents,
  workflowExecutionClaims,
  workflowRuns,
  workflowTaskAttempts,
} from "../session-runtime/schema.js";
import {
  storedWorkflowRunFromRow,
  type StoredWorkflowRunInput,
  type StoredWorkflowRunRecord,
  type StoredWorkflowEventInput,
  type StoredWorkflowEventRecord,
  type WorkflowRunClaim,
} from "./workflow-records.js";

export class WorkflowRepository {
  constructor(private readonly storage: StorageContext) {}

  saveRun(input: StoredWorkflowRunInput): void {
    this.storage.assertWritable();
    const database = this.storage.database.orm;
    this.storage.database.connection.transaction(() => {
      database
        .insert(workflowRuns)
        .values({
          runId: input.runId,
          ownerSessionId: input.ownerSessionId ?? null,
          ownerInputId: input.ownerInputId ?? null,
          ownerRunId: input.ownerRunId ?? null,
          status: input.status,
          termination: input.termination ?? null,
          snapshotJson: input.snapshotJson,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        })
        .onConflictDoUpdate({
          target: workflowRuns.runId,
          set: {
            ownerSessionId: input.ownerSessionId ?? null,
            ownerInputId: input.ownerInputId ?? null,
            ownerRunId: input.ownerRunId ?? null,
            status: input.status,
            termination: input.termination ?? null,
            snapshotJson: input.snapshotJson,
            updatedAt: input.updatedAt,
          },
        })
        .run();
      database
        .delete(workflowTaskAttempts)
        .where(eq(workflowTaskAttempts.workflowRunId, input.runId))
        .run();
      const insertAttempt = database.insert(workflowTaskAttempts).values({
        workflowRunId: input.runId,
        taskId: placeholder("taskId"),
        attempt: placeholder("attempt"),
        status: placeholder("status"),
        payloadJson: placeholder("payloadJson"),
        startedAt: placeholder("startedAt"),
        finishedAt: placeholder("finishedAt"),
      }).prepare();
      for (const attempt of input.taskAttempts) {
        insertAttempt.run({
          taskId: attempt.taskId,
          attempt: attempt.attempt,
          status: attempt.status,
          payloadJson: attempt.payloadJson,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt ?? null,
        });
      }
    })();
  }

  loadRun(runId: string): StoredWorkflowRunRecord | undefined {
    const row = this.storage.database.orm
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .get();
    return row ? storedWorkflowRunFromRow(row) : undefined;
  }

  listRuns(
    options: { ownerSessionId?: string; status?: string } = {},
  ): StoredWorkflowRunRecord[] {
    return this.storage.database.orm
      .select()
      .from(workflowRuns)
      .where(and(
        options.ownerSessionId ? eq(workflowRuns.ownerSessionId, options.ownerSessionId) : undefined,
        options.status ? eq(workflowRuns.status, options.status) : undefined,
      ))
      .orderBy(desc(workflowRuns.updatedAt))
      .all()
      .map(storedWorkflowRunFromRow);
  }

  appendEvent(input: StoredWorkflowEventInput): number {
    this.storage.assertWritable();
    const result = this.storage.database.orm
      .insert(workflowEvents)
      .values({
        workflowRunId: input.runId,
        type: input.type,
        eventJson: input.eventJson,
        createdAt: input.createdAt,
      })
      .run();
    return Number(result.lastInsertRowid);
  }

  listEventRecords(runId: string): StoredWorkflowEventRecord[] {
    return this.storage.database.orm
      .select({ seq: workflowEvents.seq, eventJson: workflowEvents.eventJson })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowRunId, runId))
      .orderBy(asc(workflowEvents.seq))
      .all()
      .map((row) => ({ id: String(row.seq), eventJson: row.eventJson }));
  }

  listEvents(runId: string): string[] {
    return this.listEventRecords(runId).map((row) => row.eventJson);
  }

  claimRun(runId: string, ownerId: string): WorkflowRunClaim {
    this.storage.assertWritable();
    const database = this.storage.database.orm;
    return this.storage.database.connection.transaction(() => {
      const current = database
        .select()
        .from(workflowExecutionClaims)
        .where(eq(workflowExecutionClaims.workflowRunId, runId))
        .get();
      if (current?.status === "running" && current.ownerId === ownerId) {
        throw new Error(
          `Workflow run is already claimed by this Application: ${runId}`,
        );
      }
      const generation = (current?.generation ?? 0) + 1;
      const claimedAt = Date.now();
      const claim = {
        ownerId,
        generation,
        claimedAt,
        heartbeatAt: claimedAt,
        finishedAt: null,
        status: "running",
      };
      database
        .insert(workflowExecutionClaims)
        .values({ workflowRunId: runId, ...claim })
        .onConflictDoUpdate({ target: workflowExecutionClaims.workflowRunId, set: claim })
        .run();
      return { ownerId, generation, claimedAt };
    })();
  }

  finishClaim(runId: string, ownerId: string, status: string): void {
    this.storage.assertWritable();
    const timestamp = Date.now();
    const result = this.storage.database.orm
      .update(workflowExecutionClaims)
      .set({ status, finishedAt: timestamp, heartbeatAt: timestamp })
      .where(and(
        eq(workflowExecutionClaims.workflowRunId, runId),
        eq(workflowExecutionClaims.ownerId, ownerId),
        eq(workflowExecutionClaims.status, "running"),
      ))
      .run();
    if (result.changes !== 1) {
      throw new Error(
        `Workflow run claim is not active for this Application: ${runId}`,
      );
    }
  }
}
