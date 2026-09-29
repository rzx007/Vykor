import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "@vykor/services";
import { afterEach, describe, expect, it } from "vitest";

import {
  readSessionExecutionObservations,
  type SessionObservationSource,
} from "./session-execution-observation-reader.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "vykor-session-observation-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sourceFor(store: SessionStore): SessionObservationSource {
  return {
    listSessions: () => store.sessions.list({ includeArchived: true }),
    listRuns: (sessionId) => store.runs.listRuns(sessionId),
    listRunAttempts: (runId) => store.runs.listRunAttempts(runId),
    listSessionTasks: (sessionId) => store.runs.listSessionTasks(sessionId),
  };
}

function completeRun(store: SessionStore, runId: string): void {
  store.runs.updateRun(runId, { status: "running" });
  store.runs.updateRun(runId, { status: "completed" });
}

describe("readSessionExecutionObservations", () => {
  it("projects root and child runs with follow-ups, usage, and backing links", () => {
    const directory = temporaryDirectory();
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.sessions.create({ id: "root-session", cwd: directory, model: "root-model" });
      store.runs.createRun({
        id: "root-run",
        sessionId: "root-session",
        metadata: {
          traceId: "trace-1",
          usage: {
            inputTokens: 30,
            outputTokens: 7,
            cacheReadTokens: 5,
            cacheCreationTokens: 2,
          },
          modelUsage: { incomplete: false, unknownAttempts: 0, partialAttempts: 0 },
        },
      });
      const firstAttempt = store.runs.createRunAttempt({
        runId: "root-run",
        sequence: 1,
        model: "first-model",
        provider: "provider-a",
      });
      store.runs.updateRunAttempt(firstAttempt.id, { status: "completed" });
      const finalAttempt = store.runs.createRunAttempt({
        runId: "root-run",
        sequence: 2,
        model: "final-model",
        provider: "provider-b",
      });
      store.runs.updateRunAttempt(finalAttempt.id, { status: "completed" });
      completeRun(store, "root-run");

      store.sessions.create({
        id: "child-session-1",
        parentId: "root-session",
        cwd: directory,
        model: "child-model",
        metadata: { childId: "child-1" },
      });
      for (const runId of ["child-run-1", "child-run-2"]) {
        store.runs.createRun({
          id: runId,
          sessionId: "child-session-1",
          metadata: { parentRunId: "root-run" },
        });
        const attempt = store.runs.createRunAttempt({
          runId,
          sequence: 1,
          model: "child-model",
          provider: "provider-c",
        });
        store.runs.updateRunAttempt(attempt.id, { status: "completed" });
        completeRun(store, runId);
      }

      store.runs.createSessionTask({
        id: "child-1",
        sessionId: "root-session",
        childSessionId: "child-session-1",
        type: "agent",
        description: "child",
        cwd: directory,
        metadata: {},
      });

      const result = readSessionExecutionObservations(sourceFor(store));

      expect(result.records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          executionKind: "root_agent_run",
          executionId: "agent-run:root-run",
          model: "final-model",
          provider: "provider-b",
          usage: expect.objectContaining({ inputTokens: 30, outputTokens: 7, totalTokens: 37, completeness: "complete" }),
        }),
        expect.objectContaining({
          executionKind: "child_agent_run",
          executionId: "agent-run:child-run-2",
          parentExecutionId: "agent-run:root-run",
          childId: "child-1",
        }),
      ]));
      expect(result.backingExecutionsByTaskId.get("child-1")).toEqual([
        "agent-run:child-run-1",
        "agent-run:child-run-2",
      ]);
    } finally {
      store.close();
    }
  });

  it("maps an interrupted run to unknown instead of guessing a failure kind", () => {
    const directory = temporaryDirectory();
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.sessions.create({ id: "s1", cwd: directory, model: "m" });
      store.runs.createRun({ id: "r-interrupted", sessionId: "s1" });
      store.runs.updateRun("r-interrupted", { status: "running" });
      store.runs.updateRun("r-interrupted", { status: "interrupted" });

      const result = readSessionExecutionObservations(sourceFor(store));
      const record = result.records.find((row) => row.runId === "r-interrupted");
      expect(record).toMatchObject({ outcome: "unknown" });
      expect(record?.failureKind).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("marks usage partial when the model usage summary is incomplete", () => {
    const directory = temporaryDirectory();
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.sessions.create({ id: "s1", cwd: directory, model: "m" });
      store.runs.createRun({
        id: "r-partial",
        sessionId: "s1",
        metadata: {
          usage: { inputTokens: 5, outputTokens: 3 },
          modelUsage: { incomplete: true, unknownAttempts: 0, partialAttempts: 0 },
        },
      });
      completeRun(store, "r-partial");

      const result = readSessionExecutionObservations(sourceFor(store));
      const record = result.records.find((row) => row.runId === "r-partial");
      expect(record?.usage).toMatchObject({ inputTokens: 5, completeness: "partial" });
      expect(result.warnings).toContainEqual({
        code: "partial_usage",
        sourceId: "agent-run:r-partial",
      });
    } finally {
      store.close();
    }
  });

  it("does not call empty or legacy usage complete", () => {
    const directory = temporaryDirectory();
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.sessions.create({ id: "s1", cwd: directory, model: "m" });
      store.runs.createRun({ id: "empty", sessionId: "s1", metadata: { usage: {} } });
      store.runs.createRun({
        id: "legacy",
        sessionId: "s1",
        metadata: { usage: { inputTokens: 4, outputTokens: 2 } },
      });
      completeRun(store, "empty");
      completeRun(store, "legacy");

      const result = readSessionExecutionObservations(sourceFor(store));
      expect(result.records.find((row) => row.runId === "empty")?.usage.completeness).toBe("unknown");
      expect(result.records.find((row) => row.runId === "legacy")?.usage).toMatchObject({
        totalTokens: 6,
        completeness: "partial",
      });
      expect(result.warnings).toContainEqual({ code: "partial_usage", sourceId: "agent-run:empty" });
      expect(result.warnings).toContainEqual({ code: "partial_usage", sourceId: "agent-run:legacy" });
    } finally {
      store.close();
    }
  });

  it("flags a child run without a parent run instead of inventing one", () => {
    const directory = temporaryDirectory();
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.sessions.create({ id: "parent-session", cwd: directory, model: "m" });
      store.sessions.create({
        id: "orphan-session",
        parentId: "parent-session",
        cwd: directory,
        model: "m",
        metadata: { childId: "orphan-child" },
      });
      store.runs.createRun({ id: "r-orphan", sessionId: "orphan-session" });
      completeRun(store, "r-orphan");

      const result = readSessionExecutionObservations(sourceFor(store));
      const record = result.records.find((row) => row.runId === "r-orphan");
      expect(record).toMatchObject({ executionKind: "child_agent_run", completeness: "partial" });
      expect(record?.parentExecutionId).toBeUndefined();
      expect(result.warnings).toContainEqual({
        code: "missing_parent_execution",
        sourceId: "agent-run:r-orphan",
      });
    } finally {
      store.close();
    }
  });

  it("projects bounded automatic review outcomes and ignores invalid metadata", () => {
    const directory = temporaryDirectory();
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.sessions.create({ id: "s1", cwd: directory, model: "m" });
      store.runs.createRun({
        id: "with-review",
        sessionId: "s1",
        metadata: {
          autoReview: {
            version: 1,
            policyVersion: "risk-v1",
            mode: "risk_based",
            riskLevel: "high",
            status: "findings",
            reasons: ["sensitive_path"],
            verdict: "fail",
            findingCount: 2,
          },
        },
      });
      completeRun(store, "with-review");
      store.runs.createRun({
        id: "bad-review",
        sessionId: "s1",
        metadata: { autoReview: { version: 1, status: "wibble" } },
      });
      completeRun(store, "bad-review");

      const result = readSessionExecutionObservations(sourceFor(store));
      const reviewed = result.records.find((row) => row.runId === "with-review");
      expect(reviewed?.review).toEqual({
        policyVersion: "risk-v1",
        riskLevel: "high",
        status: "findings",
        verdict: "fail",
        findingCount: 2,
      });
      expect(JSON.stringify(reviewed?.review)).not.toContain("sensitive_path");
      expect(result.records.find((row) => row.runId === "bad-review")?.review).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
