import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "@vykor/agent-contracts";
import { SessionStore } from "@vykor/services";
import { describe, expect, it, vi } from "vitest";
import { DaemonAgentEventProjector } from "../daemon-agent-event-projector.js";
import { SessionExecutionProjector } from "../../session/transcript/session-execution-projector.js";
import { SessionTranscriptProjection } from "../../session/transcript/transcript-projection.js";

import {
  projectionSettlementInput,
  recoverProjectionSettlements,
} from "../projection-settlement-recovery.js";

describe("projection settlement recovery", () => {
  // Missing durable persistence or replay deduplication must leave this test
  // with a running task after restart, or more than one terminal event.
  it.each(["completed", "failed", "interrupted", "stopped"] as const)(
    "persists a failed %s child close and recovers it once after restart",
    async (status) => {
      const directory = mkdtempSync(join(tmpdir(), "vk-child-close-restart-"));
      const path = join(directory, "store.db");
      let store = new SessionStore({ path });
      const publisher = { checkpoint: () => store.conversations.latestEventSeq(), publish() {}, publishSince() {} };
      const makeProjector = (projectorId: string) => new DaemonAgentEventProjector({
        projectorId, rootSessionId: "parent", store, rootAgent: {} as any,
        transcriptProjection: new SessionTranscriptProjection(store),
        liveChildren: { register() {}, unregister() {} }, events: publisher, log() {},
      });
      try {
        store.sessions.create({ id: "parent", cwd: directory, model: "m", metadata: { runtime: { model: "m" } } });
        const projector = makeProjector("daemon-agent:old-agent");
        await projector.apply(childEvent("child.created", 1, {
          childId: "child-1", sessionId: "child-session", cwd: directory,
          spawn: { agent: "worker", prompt: "inspect", description: "child", cwd: directory },
        }));
        const updateTask = store.runs.updateSessionTask.bind(store.runs);
        vi.spyOn(store.runs, "updateSessionTask").mockImplementation((id, input) => {
          if (input.status === status) throw new Error("terminal task write unavailable");
          return updateTask(id, input);
        });
        const result = { status, output: status === "failed" ? "child failed" : "child finished" };
        const closed = childEvent("child.closed", 2, { childId: "child-1", sessionId: "child-session", result });
        await expect(projector.apply(closed)).rejects.toThrow("terminal task write unavailable");
        expect(store.getSessionTask("child-1")?.status).not.toBe(status);
        expect(store.listProjectionSettlements()).toMatchObject([{
          status: "pending", attemptCount: 1, lastError: "terminal task write unavailable",
          payload: { event: { id: closed.id, type: "child.closed", data: { result } } },
        }]);
        expect(store.conversations.listEvents().filter(event => event.type === "agent.child.closed")).toHaveLength(0);
        store.close();
        store = new SessionStore({ path });

        const restarted = makeProjector("daemon-agent:new-agent");
        await restarted.apply(closed);
        await restarted.apply(closed);
        expect(store.getSessionTask("child-1")).toMatchObject({ status, output: result.output });
        expect(store.listProjectionSettlements()).toMatchObject([{ status: "resolved", attemptCount: 2 }]);
        expect(recoverProjectionSettlements(store)).toEqual({ resolved: 0, pending: 0 });
        expect(store.conversations.listEvents().filter(event => event.type === "agent.child.closed")).toHaveLength(1);
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("completes a child terminal projection after a daemon restart and is idempotent", () => {
    withStorePath((path) => {
      const first = new SessionStore({ path });
      first.sessions.create({ id: "parent", cwd: process.cwd(), model: "m" });
      first.sessions.create({ id: "child-session", parentId: "parent", cwd: process.cwd(), model: "m" });
      first.createSessionTask({
        id: "child-1",
        sessionId: "parent",
        childSessionId: "child-session",
        type: "agent",
        description: "child",
        cwd: process.cwd(),
      });
      const closed = childEvent("child.closed", 7, {
        childId: "child-1",
        sessionId: "child-session",
        result: { status: "completed", output: "done" },
      });
      first.createProjectionSettlement(projectionSettlementInput(
        "daemon-agent:old-agent",
        "parent",
        closed,
        "retry-terminal-projection",
        new Error("task completion write failed"),
      ));
      first.close();

      const restarted = new SessionStore({ path });
      try {
        expect(recoverProjectionSettlements(restarted)).toEqual({ resolved: 1, pending: 0 });
        expect(restarted.getSessionTask("child-1")).toMatchObject({
          status: "completed",
          output: "done",
        });
        expect(restarted.listProjectionSettlements()).toMatchObject([{
          status: "resolved",
          attemptCount: 1,
        }]);
        expect(restarted.conversations.listEvents().filter(
          (event) => event.type === "agent.child.closed" && event.payload.frameworkEventId === closed.id,
        )).toHaveLength(1);

        expect(recoverProjectionSettlements(restarted)).toEqual({ resolved: 0, pending: 0 });
        expect(restarted.conversations.listEvents().filter(
          (event) => event.type === "agent.child.closed" && event.payload.frameworkEventId === closed.id,
        )).toHaveLength(1);
      } finally {
        restarted.close();
      }
    });
  });

  it("preserves trusted child failure detail through compensation", () => {
    withStorePath((path) => {
      const first = new SessionStore({ path });
      first.sessions.create({ id: "parent", cwd: process.cwd(), model: "m" });
      first.sessions.create({ id: "child-session", parentId: "parent", cwd: process.cwd(), model: "m" });
      first.createSessionTask({
        id: "child-1",
        sessionId: "parent",
        childSessionId: "child-session",
        type: "agent",
        description: "child",
        cwd: process.cwd(),
      });
      const partialResult = {
        version: 1,
        childSessionId: "child-session",
        runId: "run-1",
        source: "limit_finalization",
        text: "final report",
        truncated: false,
      };
      first.createProjectionSettlement(projectionSettlementInput(
        "daemon-agent:old-agent",
        "parent",
        childEvent("run.failed", 11, {
          error: { name: "MaxTurnsExceeded", message: "Exceeded maximum agentic turns (2)" },
          output: "final report",
          failureKind: "max_turns",
          partialResult,
        }, { runId: "run-1" }),
        "compensate-child",
        new Error("terminal projection failed"),
      ));
      first.close();

      const restarted = new SessionStore({ path });
      try {
        expect(recoverProjectionSettlements(restarted)).toEqual({ resolved: 1, pending: 0 });
        expect(restarted.getSessionTask("child-1")).toMatchObject({
          status: "failed",
          metadata: { childFailure: { failureKind: "max_turns", partialResult } },
        });
        expect(recoverProjectionSettlements(restarted)).toEqual({ resolved: 0, pending: 0 });
      } finally {
        restarted.close();
      }
    });
  });

  it("uses durable compensation for live-only child creation after restart", () => {
    withStorePath((path) => {
      const first = new SessionStore({ path });
      first.sessions.create({ id: "parent", cwd: process.cwd(), model: "m" });
      first.sessions.create({ id: "child-session", parentId: "parent", cwd: process.cwd(), model: "m" });
      const input = first.conversationTransactions.admitPrompt({ id: "input-1", sessionId: "parent", content: "spawn" });
      const run = first.runs.createRun({ id: "run-1", sessionId: "parent", inputId: input.id });
      first.runs.updateRun(run.id, { status: "running" });
      first.createSessionTask({
        id: "child-1",
        sessionId: "parent",
        childSessionId: "child-session",
        runId: run.id,
        type: "agent",
        description: "child",
        cwd: process.cwd(),
      });
      first.createProjectionSettlement(projectionSettlementInput(
        "daemon-agent:old-agent",
        "parent",
        childEvent("child.created", 8, {
          childId: "child-1",
          sessionId: "child-session",
          spawn: { agent: "Explore", prompt: "inspect", description: "child" },
          cwd: process.cwd(),
        }, { runId: run.id }),
        "compensate-child",
        new Error("live route registration failed"),
      ));
      first.close();

      const restarted = new SessionStore({ path });
      try {
        expect(recoverProjectionSettlements(restarted)).toEqual({ resolved: 1, pending: 0 });
        expect(restarted.runs.getRun(run.id)).toMatchObject({
          status: "failed",
          error: "live route registration failed",
        });
        expect(restarted.getSessionTask("child-1")).toMatchObject({
          status: "failed",
          error: "live route registration failed",
        });
        expect(restarted.sessions.get("child-session")?.status).toBe("archived");
      } finally {
        restarted.close();
      }
    });
  });

  it("keeps an invalid repair pending with a visible attempt and error", () => {
    withStorePath((path) => {
      const store = new SessionStore({ path });
      store.createProjectionSettlement({
        projector: "daemon-agent:old-agent",
        rootSessionId: "parent",
        eventSequence: 9,
        action: "retry-terminal-projection",
        payload: { event: { type: "child.closed" }, cause: { message: "broken" } },
      });

      expect(recoverProjectionSettlements(store)).toEqual({ resolved: 0, pending: 1 });
      expect(store.listProjectionSettlements()).toMatchObject([{
        status: "pending",
        attemptCount: 1,
        lastError: expect.stringContaining("invalid Agent event"),
      }]);
      store.close();
    });
  });
});

function childEvent(
  type: "child.created" | "child.closed" | "run.failed",
  sequence: number,
  data: Record<string, unknown>,
  context: Record<string, unknown> = {},
): AgentEvent {
  return {
    id: `framework-${sequence}`,
    sequence,
    occurredAt: new Date().toISOString(),
    type,
    data,
    context: {
      agentId: "parent-agent",
      sessionId: "parent",
      childId: "child-1",
      traceId: "trace-1",
      ...context,
    },
  } as AgentEvent;
}

function withStorePath(test: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "vk-projection-settlement-"));
  try {
    test(join(dir, "store.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it.each([undefined, "turn limit"])("repairs error and missing metadata even when child status/output already match: %s", error => {
  withStorePath(path => {
    const store = new SessionStore({ path });
    try {
      store.sessions.create({ id: "parent", cwd: process.cwd(), model: "m" });
      store.sessions.create({ id: "child-session", parentId: "parent", cwd: process.cwd(), model: "m" });
      store.createSessionTask({ id: "child-1", sessionId: "parent", childSessionId: "child-session", type: "agent", cwd: process.cwd(), description: "check" });
      store.updateSessionTask("child-1", { status: "failed", output: "partial report", error: "partial report" });
      const result = { status: "failed", output: "partial report", ...(error ? { error } : {}), failureKind: "max_turns" };
      const closed = childEvent("child.closed", 41, { childId: "child-1", sessionId: "child-session", result });
      store.createProjectionSettlement(projectionSettlementInput("daemon-agent:test", "parent", closed, "retry-terminal-projection", new Error("save failed")));
      expect(recoverProjectionSettlements(store)).toEqual({ resolved: 1, pending: 0 });
      expect(store.getSessionTask("child-1")).toMatchObject({ status: "failed", output: "partial report", metadata: { childFailure: { failureKind: "max_turns" } } });
      expect(store.getSessionTask("child-1")?.error).toBe(error);
      expect(recoverProjectionSettlements(store)).toEqual({ resolved: 0, pending: 0 });
    } finally { store.close(); }
  });
});

it("does not apply an unpinned old child.closed result to a newer run", () => {
  withStorePath(path => {
    const store = new SessionStore({ path });
    try {
      store.sessions.create({ id: "parent", cwd: process.cwd(), model: "m" });
      store.sessions.create({ id: "child-session", parentId: "parent", cwd: process.cwd(), model: "m" });
      store.runs.createRun({ id: "new-B", sessionId: "child-session" });
      store.runs.updateRun("new-B", { status: "running" });
      store.createSessionTask({ id: "child-1", sessionId: "parent", childSessionId: "child-session", runId: "new-B", type: "agent", cwd: process.cwd(), description: "check", status: "running" });
      store.createProjectionSettlement(projectionSettlementInput("daemon-agent:test", "parent", childEvent("child.closed", 42, {
        childId: "child-1", sessionId: "child-session", result: { status: "completed", output: "old A" },
      }), "retry-terminal-projection", new Error("save failed")));
      expect(recoverProjectionSettlements(store)).toEqual({ resolved: 1, pending: 0 });
      expect(store.getSessionTask("child-1")).toMatchObject({ runId: "new-B", status: "running" });
      expect(store.getSessionTask("child-1")?.output).toBeUndefined();
    } finally { store.close(); }
  });
});

it("does not archive a child session when replaying creation compensation after a newer run", () => {
  withStorePath(path => {
    const store = new SessionStore({ path });
    try {
      store.sessions.create({ id: "parent", cwd: process.cwd(), model: "m" });
      store.sessions.create({ id: "child-session", parentId: "parent", cwd: process.cwd(), model: "m" });
      store.runs.createRun({ id: "new-B", sessionId: "child-session" });
      store.runs.updateRun("new-B", { status: "running" });
      store.createSessionTask({ id: "child-1", sessionId: "parent", childSessionId: "child-session", runId: "new-B", type: "agent", cwd: process.cwd(), description: "check", status: "running" });
      store.createProjectionSettlement(projectionSettlementInput("daemon-agent:test", "parent", childEvent("child.created", 43, { childId: "child-1", sessionId: "child-session" }, { runId: "original-parent" }), "compensate-child", new Error("old route failure")));
      expect(recoverProjectionSettlements(store)).toEqual({ resolved: 1, pending: 0 });
      expect(store.getSessionTask("child-1")).toMatchObject({ runId: "new-B", status: "running" });
      expect(store.sessions.get("child-session")?.status).not.toBe("archived");
    } finally { store.close(); }
  });
});

it("keeps a running child task when recovered compensation has no run identity", () => {
  withStorePath(path => {
    const store = new SessionStore({ path });
    try {
      store.sessions.create({ id: "parent", cwd: process.cwd(), model: "m" });
      store.sessions.create({ id: "child-session", parentId: "parent", cwd: process.cwd(), model: "m" });
      store.runs.createRun({ id: "current-B", sessionId: "child-session" });
      store.runs.updateRun("current-B", { status: "running" });
      store.createSessionTask({ id: "child-1", sessionId: "parent", childSessionId: "child-session", runId: "current-B", type: "agent", cwd: process.cwd(), description: "check", status: "running" });
      store.updateSessionTask("child-1", { output: "B progress" });
      store.createProjectionSettlement(projectionSettlementInput("daemon-agent:test", "parent", childEvent("run.failed", 44, {
        error: { name: "Error", message: "unscoped old event" }, output: "old report",
      }, { sessionId: "child-session" }), "compensate-child", new Error("missing run identity")));
      store.close();
      const restarted = new SessionStore({ path });
      try {
        expect(recoverProjectionSettlements(restarted)).toEqual({ resolved: 1, pending: 0 });
        expect(restarted.getSessionTask("child-1")).toMatchObject({ runId: "current-B", status: "running", output: "B progress" });
        expect(restarted.getSessionTask("child-1")?.error).toBeUndefined();
        expect(restarted.runs.getRun("current-B")?.status).toBe("running");
      } finally { restarted.close(); }
    } finally { store.close(); }
  });
});
