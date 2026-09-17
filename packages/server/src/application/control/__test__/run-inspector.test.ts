import { describe, expect, it, vi } from "vitest";

import { inspectDurableRun, listProjectionDiagnostics } from "../run-inspector.js";

function createStore() {
  const run = { id: "r1", sessionId: "s1", inputId: "i1", status: "failed", metadata: { traceId: "trace-1", sourceRunId: "old-run" }, createdAt: 1, updatedAt: 9 };
  return {
    runs: {
      getRun: vi.fn(() => run),
      listRunAttempts: vi.fn(() => [{ id: "a1", runId: "r1", sequence: 1, status: "running", createdAt: 2, updatedAt: 2 }]),
    },
    conversations: {
      getInput: vi.fn(() => ({ id: "i1", sessionId: "s1", seq: 1, delivery: "queue", content: "secret prompt", metadata: {}, createdAt: 1 })),
      listMessages: vi.fn(() => [{ id: "m1", sessionId: "s1", seq: 1, role: "assistant", runId: "r1", metadata: {}, createdAt: 2, updatedAt: 2 }]),
      listMessageParts: vi.fn(() => [{ id: "p1", sessionId: "s1", messageId: "m1", seq: 1, type: "tool", status: "failed", text: "secret output", input: { token: "secret" }, output: "secret result", metadata: { failureKind: "unknown_outcome", toolAttemptId: "ta1" }, createdAt: 3, updatedAt: 4 }]),
      listEvents: vi.fn(() => [{ id: "e1", seq: 1, type: "not.registered", schemaVersion: 1, sessionId: "s1", payload: { runId: "r1", secret: "event content" }, createdAt: 3 }]),
    },
    listSessionTasks: vi.fn(() => []),
    listProjectionSettlements: vi.fn(() => [{ id: "set1", projector: "agent", rootSessionId: "s1", eventSequence: 1, action: "retry-terminal-projection", payload: { runId: "r1", secret: "hide" }, status: "pending", attemptCount: 1, createdAt: 4, updatedAt: 4 }]),
  };
}

const permissions = {
  list: vi.fn(() => [{ id: "perm1", sessionId: "s1", runId: "r1", toolName: "shell", payload: { command: "secret" }, status: "approved", createdAt: 3, updatedAt: 3 }]),
};

const workflowQueries = {
  listRuns: () => [
    { runId: "workflow-1", ownerRunId: "r1", status: "running", snapshotJson: '{"summary":"private workflow"}', createdAt: 1, updatedAt: 2 },
    { runId: "other-workflow", ownerRunId: "r2", status: "running", snapshotJson: "{}", createdAt: 1, updatedAt: 2 },
  ],
};

describe("inspectDurableRun", () => {
  it("redacts structured input text, names and paths unless content is requested", () => {
    const store = createStore();
    const items = [
      { type: "text", text: "private task text" },
      { type: "skill", name: "private-skill", path: "/private/skill/SKILL.md" },
      { type: "mention", name: "private-resource", path: "app://private-resource" },
    ];
    const input = { ...store.conversations.getInput(), items };
    store.conversations.getInput.mockReturnValue(input);
    const hidden = inspectDurableRun(store as any, permissions as any, workflowQueries, "r1")!;
    for (const value of ["private task text", "private-skill", "/private/skill/SKILL.md", "private-resource", "app://private-resource"])
      expect(JSON.stringify(hidden)).not.toContain(value);
    expect(inspectDurableRun(store as any, permissions as any, workflowQueries, "r1", true)!.input?.items).toEqual(items);
  });
  it("redacts content by default and reports relationships that need operator attention", () => {
    const store = createStore();
    const result = inspectDurableRun(store as any, permissions as any, workflowQueries, "r1")!;
    expect(result.workflows).toEqual([{ runId: "workflow-1", ownerRunId: "r1", status: "running" }]);
    expect(JSON.stringify(result)).not.toContain("private workflow");
    expect(result.input?.content).toBe("[redacted]");
    expect(result.parts[0]).toMatchObject({ text: "[redacted]", input: { redacted: true }, output: "[redacted]" });
    expect(result.permissions[0]?.payload).toEqual({ redacted: true });
    expect(result.run.metadata).toEqual({ traceId: "trace-1", sourceRunId: "old-run" });
    expect(JSON.stringify(result)).not.toContain("secret prompt");
    expect(JSON.stringify(result)).not.toContain("secret output");
    expect(JSON.stringify(result)).not.toContain("secret result");
    expect(result.warnings.map((row) => row.code)).toEqual(expect.arrayContaining([
      "active_attempt_on_closed_run", "unknown_event", "pending_settlement", "unknown_tool_outcome",
    ]));
    expect(result.diagnosticOk).toBe(false);
    expect(result.traceIds).toEqual(["trace-1"]);
  });

  it("only reveals content after an explicit opt-in", () => {
    const store = createStore();
    const result = inspectDurableRun(store as any, permissions as any, workflowQueries, "r1", true)!;
    expect(result.workflows[0]?.snapshot).toEqual({ summary: "private workflow" });
    expect(result.input?.content).toBe("secret prompt");
    expect(result.parts[0]?.output).toBe("secret result");
    expect(result.sensitiveContentWarning).toContain("secrets");
  });
});

describe("listProjectionDiagnostics", () => {
  it("returns a failing diagnostic status while settlement work remains", () => {
    const result = listProjectionDiagnostics(createStore() as any);
    expect(result.pending).toBe(1);
    expect(result.diagnosticOk).toBe(false);
    expect(result.settlements[0]?.payload).toEqual({ redacted: true });
  });
});
