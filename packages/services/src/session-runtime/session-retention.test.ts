import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { SessionDatabase } from "../database/session-database.js";
import {
  projectionSettlements, sessionEvents, sessionRunAttempts, sessionRuns,
  sessions, workflowEvents, workflowExecutionClaims, workflowRuns,
} from "./schema.js";
import {
  applyRetention, DEFAULT_RETENTION_POLICY, latestRetentionAudit,
  listRetentionAudits, recordRetentionAudit,
} from "./session-retention.js";
import { emptyState } from "./store-state.js";

function withDatabase(test: (database: SessionDatabase) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-retention-"));
  const database = SessionDatabase.open({ path: join(directory, "sessions.db") });
  try {
    test(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("session retention", () => {
  it("prunes old terminal records while protecting active work and cutoff boundaries", () => {
    withDatabase(({ orm }) => {
      const policy = {
        ...DEFAULT_RETENTION_POLICY,
        durableEventMaxAgeMs: 100,
        workflowEventMaxAgeMs: 100,
        workflowRunMaxAgeMs: 100,
        runAttemptMaxAgeMs: 100,
        projectionSettlementMaxAgeMs: 100,
      };
      const workflows = [
        { runId: "terminal", status: "completed", updatedAt: 1 },
        { runId: "running", status: "running", updatedAt: 1 },
        { runId: "claimed", status: "completed", updatedAt: 1 },
        { runId: "boundary", status: "completed", updatedAt: 900 },
      ];
      orm.insert(workflowRuns).values(workflows.map((run) => ({
        ...run, snapshotJson: "{}", createdAt: 1,
      }))).run();
      orm.insert(workflowEvents).values(workflows.map((run) => ({
        workflowRunId: run.runId, type: "done", eventJson: "{}", createdAt: run.updatedAt,
      }))).run();
      orm.insert(workflowExecutionClaims).values({
        workflowRunId: "claimed", ownerId: "owner", generation: 1,
        claimedAt: 1, heartbeatAt: 1, status: "running",
      }).run();
      orm.insert(sessions).values([
        { id: "idle", status: "archived" },
        { id: "pending", status: "archived" },
        { id: "running", status: "archived" },
        { id: "active", status: "active" },
      ].map((session) => ({
        ...session, cwd: ".", title: session.id, model: "m",
        metadataJson: "{}", createdAt: 1, updatedAt: 1,
      }))).run();
      orm.insert(sessionRuns).values(["pending", "running"].map((status) => ({
        id: `run-${status}`, sessionId: status, status,
        metadataJson: "{}", createdAt: 1, updatedAt: 1,
      }))).run();
      const events = [
        { id: "remove", sessionId: "idle", createdAt: 1 },
        { id: "pending", sessionId: "pending", createdAt: 1 },
        { id: "running", sessionId: "running", createdAt: 1 },
        { id: "active", sessionId: "active", createdAt: 1 },
        { id: "orphan", sessionId: "missing", createdAt: 1 },
        { id: "global", sessionId: null, createdAt: 1 },
        { id: "boundary", sessionId: "idle", createdAt: 900 },
      ].map((event, index) => ({
        ...event, seq: index + 1, type: "daemon.heartbeat", schemaVersion: 1,
      }));
      orm.insert(sessionEvents).values(events.map((event) => ({
        ...event, payloadJson: "{}",
      }))).run();
      orm.insert(sessionRunAttempts).values(["completed", "pending", "running"].map((status, index) => ({
        id: status, runId: "run", sequence: index,
        status, createdAt: 1, updatedAt: 1,
      }))).run();
      orm.insert(projectionSettlements).values(["resolved", "abandoned", "pending", "retrying"].map((status, index) => ({
        id: status, projector: "p", rootSessionId: "root", eventSequence: index,
        action: "repair", payloadJson: "{}", status, createdAt: 1, updatedAt: 1,
      }))).run();
      const state = emptyState();
      state.events = events.map(({ sessionId, ...event }) => ({
        ...event, ...(sessionId !== null ? { sessionId } : {}), payload: {},
      }));

      const result = applyRetention(orm, state, policy, 1_000);

      expect(result).toEqual({ events: 1, workflowEvents: 2, workflows: 1, runAttempts: 1, settlements: 2 });
      expect(orm.select().from(workflowRuns).all().map((run) => run.runId).sort()).toEqual(["boundary", "claimed", "running"]);
      expect(orm.select().from(workflowEvents).all().map((event) => event.workflowRunId).sort()).toEqual(["boundary", "running"]);
      expect(state.events.map((event) => event.id)).toEqual(events.filter((event) => event.id !== "remove").map((event) => event.id));
      expect(orm.select().from(sessionEvents).all()).toHaveLength(state.events.length);
      expect(orm.select().from(sessionRunAttempts).all().map((attempt) => attempt.status).sort()).toEqual(["pending", "running"]);
      expect(orm.select().from(projectionSettlements).all().map((settlement) => settlement.status).sort()).toEqual(["pending", "retrying"]);
      expect(listRetentionAudits(orm)[0]).toMatchObject({ policy: JSON.stringify(policy), result_json: JSON.stringify(result), created_at: 1_000 });
    });
  });

  it("reuses the deletion query when pruning many historical events", () => {
    withDatabase(({ orm, connection }) => {
      orm.insert(sessions).values({
        id: "archived", status: "archived", cwd: ".", title: "old", model: "m",
        metadataJson: "{}", createdAt: 1, updatedAt: 1,
      }).run();
      orm.insert(sessionEvents).values(Array.from({ length: 100 }, (_, index) => ({
        id: `event-${index}`, seq: index + 1, sessionId: "archived", type: "daemon.heartbeat",
        schemaVersion: 1, payloadJson: "{}", createdAt: 1,
      }))).run();
      const state = emptyState();
      const prepare = vi.spyOn(connection, "prepare");
      let preparations: number;
      let deletedEvents: number;
      try {
        deletedEvents = applyRetention(orm, state, { ...DEFAULT_RETENTION_POLICY, durableEventMaxAgeMs: 100 }, 1_000).events;
        preparations = prepare.mock.calls.length;
      } finally {
        prepare.mockRestore();
      }
      expect(deletedEvents).toBe(100);
      expect(orm.select().from(sessionEvents).all()).toEqual([]);
      expect(preparations).toBeLessThanOrEqual(10);
    });
  });

  it("returns raw audit fields and picks the last inserted audit for tied timestamps", () => {
    withDatabase(({ orm }) => {
      expect(latestRetentionAudit(orm, "gc")).toBeUndefined();
      recordRetentionAudit(orm, { policy: "gc", result: { count: 1 }, timestamp: 10 });
      recordRetentionAudit(orm, { policy: "gc", result: { count: 2 }, timestamp: 10 });
      recordRetentionAudit(orm, { policy: "other", result: {}, timestamp: 20 });

      expect(latestRetentionAudit(orm, "gc")).toMatchObject({ policy: "gc", result: { count: 2 }, createdAt: 10 });
      const audits = listRetentionAudits(orm);
      expect(audits.map((audit) => audit.created_at)).toEqual([20, 10, 10]);
      expect(Object.keys(audits[0]!).sort()).toEqual(["created_at", "id", "policy", "result_json"]);
    });
  });
});
