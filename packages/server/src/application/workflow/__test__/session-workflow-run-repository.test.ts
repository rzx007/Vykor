import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
  type WorkflowRunEvent,
  type WorkflowSpec,
} from "@vykor/coordinator";
import { SessionStore } from "@vykor/services";
import { afterEach, describe, expect, it } from "vitest";

import { SessionWorkflowRunRepository } from "../session-workflow-run-repository.js";
import { recoverInterruptedWorkflows } from "../../session/workflow-recovery.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "vykor-workflow-diagnostics-"));
  temporaryDirectories.push(directory);
  return directory;
}

function workflowRepository(store: SessionStore): SessionWorkflowRunRepository {
  return new SessionWorkflowRunRepository({
    workflows: store.workflows,
    events: {
      latestEventSeq: () => store.conversations.latestEventSeq(),
      appendEvent: (input) => store.conversations.appendEvent(input),
    },
    path: store.path,
    sessionExists: (id: string) => !!store.sessions.get(id),
  });
}

describe("SessionWorkflowRunRepository diagnostics", () => {
  it("recovers a persisted temporary workflow after restart without recreating chat events or notifying its formal source", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "sessions.db");
    const store = new SessionStore({ path });
    try {
      store.sessions.create({ id: "main", cwd: process.cwd(), model: "m" });
      store.sessions.create({ id: "temporary", storage: "memory", cwd: process.cwd(), model: "m", metadata: { fork: { sourceSessionId: "main" } } });
      const repository = workflowRepository(store);
      const spec: WorkflowSpec = { mode: "sequential", tasks: [{ id: "one" }] };
      repository.save(createWorkflowRunSnapshot({
        runId: "temporary-workflow", ownerSession: "temporary", status: "running", summary: "running",
        spec, plan: createWorkflowPlan(spec), results: new Map(), running: new Set(["one"]), createdAt: 10,
      }));
      repository.appendEvent({
        version: 1, runId: "temporary-workflow", type: "workflow_started", timestamp: 11, status: "running",
      });
      expect(store.conversations.listEvents({ sessionId: "temporary" })).toContainEqual(expect.objectContaining({ type: "workflow.workflow_started" }));
      expect((store as any).storage.database.connection.prepare("SELECT count(*) AS count FROM session_event WHERE session_id = ?").get("temporary"))
        .toEqual({ count: 0 });
    } finally { store.close(); }

    const reopened = new SessionStore({ path });
    try {
      expect(reopened.sessions.get("temporary")).toBeUndefined();
      const repository = workflowRepository(reopened);
      const eventsBeforeRecovery = reopened.conversations.listEvents();
      await expect(recoverInterruptedWorkflows({ workflows: repository })).resolves.toBeUndefined();
      expect(repository.load("temporary-workflow")).toMatchObject({
        ownerSession: "temporary", status: "failed", termination: "cancelled",
      });
      expect(repository.loadEvents("temporary-workflow")).toContainEqual(expect.objectContaining({ type: "workflow_cancelled" }));
      expect(reopened.conversations.listEvents()).toEqual(eventsBeforeRecovery);
      expect(reopened.sessions.get("temporary")).toBeUndefined();
      expect(reopened.workflows.listRuns({ ownerSessionId: "main" })).toEqual([]);
      expect((reopened as any).storage.database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally { reopened.close(); }
  });

  it("returns usable workflow data with safe diagnostics for corrupt sqlite records", () => {
    const directory = temporaryDirectory();
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const repository = workflowRepository(store);
      const spec: WorkflowSpec = { mode: "sequential", tasks: [{ id: "one" }] };
      repository.save(createWorkflowRunSnapshot({
        runId: "valid",
        status: "running",
        summary: "valid",
        spec,
        plan: createWorkflowPlan(spec),
        results: new Map(),
        running: new Set(["one"]),
        createdAt: 10,
      }));
      const started: WorkflowRunEvent = {
        version: 1,
        runId: "valid",
        type: "workflow_started",
        timestamp: 11,
        status: "running",
      };
      repository.appendEvent(started);

      store.workflows.saveRun({
        runId: "broken",
        status: "running",
        snapshotJson: "{broken",
        createdAt: 1,
        updatedAt: 1,
        taskAttempts: [],
      });
      store.workflows.saveRun({
        runId: "identity-mismatch",
        status: "running",
        snapshotJson: JSON.stringify({
          ...createWorkflowRunSnapshot({
            runId: "another-run",
            status: "running",
            summary: "mismatch",
            spec,
            plan: createWorkflowPlan(spec),
            results: new Map(),
            running: new Set(["one"]),
            createdAt: 10,
          }),
        }),
        createdAt: 1,
        updatedAt: 1,
        taskAttempts: [],
      });
      store.workflows.appendEvent({
        runId: "valid",
        type: "broken",
        eventJson: "{broken",
        createdAt: 12,
      });
      store.workflows.appendEvent({
        runId: "valid",
        type: "workflow_finished",
        eventJson: JSON.stringify({
          version: 1,
          runId: "another-run",
          type: "workflow_finished",
          timestamp: 13,
        }),
        createdAt: 13,
      });

      expect(repository.listWithDiagnostics()).toMatchObject({
        snapshots: [expect.objectContaining({ runId: "valid" })],
        diagnostics: expect.arrayContaining([
          { code: "invalid_workflow_snapshot", sourceId: "broken" },
          { code: "invalid_workflow_snapshot", sourceId: "identity-mismatch" },
        ]),
      });
      expect(repository.loadEventsWithDiagnostics("valid")).toMatchObject({
        events: [expect.objectContaining({ type: "workflow_started" })],
        diagnostics: [
          expect.objectContaining({ code: "invalid_workflow_event" }),
          expect.objectContaining({ code: "invalid_workflow_event" }),
        ],
      });
    } finally {
      store.close();
    }
  });
});
