import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "@vykor/core";
import { SessionStore } from "@vykor/services";
import { describe, expect, it } from "vitest";

import {
  projectionSettlementInput,
  recoverProjectionSettlements,
} from "../projection-settlement-recovery.js";

describe("projection settlement recovery", () => {
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
  type: "child.created" | "child.closed",
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
