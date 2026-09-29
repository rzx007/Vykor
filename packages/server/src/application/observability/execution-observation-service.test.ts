import type {
  ExecutionKind,
  ExecutionObservation,
  ExecutionObservationWarning,
  ExecutionOutcome,
} from "@vykor/protocol";
import { describe, expect, it } from "vitest";

import { ExecutionObservationService } from "./execution-observation-service.js";

function observation(
  input: Partial<ExecutionObservation> & {
    executionKind: ExecutionKind;
    executionId: string;
    outcome: ExecutionOutcome;
  },
): ExecutionObservation {
  return {
    schemaVersion: 1,
    usage: { completeness: "unknown" },
    source: { kind: "session_run", id: input.executionId },
    completeness: "complete",
    ...input,
  };
}

function serviceWith(options: {
  sessionRecords?: ExecutionObservation[];
  sessionWarnings?: ExecutionObservationWarning[];
  workflowRecords?: ExecutionObservation[];
  workflowWarnings?: ExecutionObservationWarning[];
  now?: number;
}): ExecutionObservationService {
  return new ExecutionObservationService({
    readSessions: () => ({
      records: options.sessionRecords ?? [],
      warnings: options.sessionWarnings ?? [],
      backingExecutionsByTaskId: new Map(),
    }),
    readWorkflows: () => ({
      records: options.workflowRecords ?? [],
      warnings: options.workflowWarnings ?? [],
    }),
    now: () => options.now ?? 1_000,
  });
}

describe("ExecutionObservationService", () => {
  it("groups summaries by kind without cross-kind totals", () => {
    const service = serviceWith({
      sessionRecords: [
        observation({
          executionKind: "child_agent_run",
          executionId: "agent-run:c1",
          outcome: "completed",
          startedAt: 10,
          durationMs: 100,
          usage: { inputTokens: 10, outputTokens: 5, completeness: "complete" },
        }),
        observation({
          executionKind: "child_agent_run",
          executionId: "agent-run:c2",
          outcome: "failed",
          startedAt: 20,
          durationMs: 300,
          usage: { inputTokens: 4, outputTokens: 1, completeness: "partial" },
        }),
      ],
      workflowRecords: [
        observation({
          executionKind: "workflow_task",
          executionId: "workflow-task:wf:t1",
          outcome: "completed",
          backingExecutionIds: ["agent-run:c1", "agent-run:c2"],
          startedAt: 30,
        }),
        observation({ executionKind: "workflow_task", executionId: "workflow-task:wf:t2", outcome: "skipped" }),
        observation({ executionKind: "workflow_task", executionId: "workflow-task:wf:t3", outcome: "cancelled" }),
      ],
      now: 1_000,
    });

    const report = service.query({});
    expect(report.generatedAt).toBe(1_000);
    expect(report.summary.child_agent_run).toMatchObject({
      total: 2,
      technicalTerminal: 2,
      completed: 1,
      failed: 1,
      completionRate: 0.5,
      failureRate: 0.5,
    });
    expect(report.summary.workflow_task).toMatchObject({
      total: 3,
      skipped: 1,
      cancelled: 1,
      cancellationRate: 1 / 3,
      skipRate: 1 / 3,
    });
    expect(report.summary).not.toHaveProperty("all");
  });

  it("filters and sorts by startedAt falling back to createdAt only", () => {
    const service = serviceWith({
      sessionRecords: [
        observation({ executionKind: "root_agent_run", executionId: "agent-run:b", outcome: "completed", startedAt: 200 }),
        observation({ executionKind: "root_agent_run", executionId: "agent-run:a", outcome: "failed", startedAt: 100 }),
        observation({ executionKind: "root_agent_run", executionId: "agent-run:none", outcome: "running" }),
        observation({
          executionKind: "child_agent_run",
          executionId: "agent-run:c",
          outcome: "completed",
          createdAt: 150,
          model: "m1",
          provider: "p1",
          sessionId: "s1",
          childId: "ch1",
        }),
      ],
    });

    expect(service.query({}).records.map((row) => row.executionId)).toEqual([
      "agent-run:a",
      "agent-run:c",
      "agent-run:b",
      "agent-run:none",
    ]);
    expect(service.query({ from: 120, to: 180 }).records.map((row) => row.executionId)).toEqual([
      "agent-run:c",
    ]);
    expect(
      service.query({
        executionKinds: ["child_agent_run"],
        outcomes: ["completed"],
        sessionId: "s1",
        childId: "ch1",
        model: "m1",
        provider: "p1",
      }).records.map((row) => row.executionId),
    ).toEqual(["agent-run:c"]);
  });

  it("ties same-timestamp records by execution id", () => {
    const service = serviceWith({
      sessionRecords: [
        observation({ executionKind: "root_agent_run", executionId: "agent-run:z", outcome: "completed", startedAt: 5 }),
        observation({ executionKind: "root_agent_run", executionId: "agent-run:a", outcome: "completed", startedAt: 5 }),
      ],
    });
    expect(service.query({}).records.map((row) => row.executionId)).toEqual([
      "agent-run:a",
      "agent-run:z",
    ]);
  });

  it("reports duration samples and usage completeness per record", () => {
    const service = serviceWith({
      sessionRecords: [
        observation({ executionKind: "child_agent_run", executionId: "c1", outcome: "completed", durationMs: 100, usage: { inputTokens: 10, outputTokens: 5, completeness: "complete" } }),
        observation({ executionKind: "child_agent_run", executionId: "c2", outcome: "completed", durationMs: 300, usage: { inputTokens: 4, outputTokens: 1, completeness: "partial" } }),
        observation({ executionKind: "child_agent_run", executionId: "c3", outcome: "running" }),
      ],
    });

    const summary = service.query({}).summary.child_agent_run;
    expect(summary?.duration).toEqual({ count: 2, sumMs: 400, minMs: 100, maxMs: 300 });
    expect(summary?.usage).toEqual({
      inputTokens: 14,
      outputTokens: 6,
      totalTokens: 20,
      inputTokenRecords: 2,
      outputTokenRecords: 2,
      totalTokenRecords: 2,
      averageInputTokens: 7,
      averageOutputTokens: 3,
      averageTotalTokens: 10,
      completeRecords: 1,
      partialRecords: 1,
      unknownRecords: 1,
    });
  });

  it("counts unclassified technical failures as unknown and filters them", () => {
    const service = serviceWith({
      sessionRecords: [
        observation({ executionKind: "root_agent_run", executionId: "failed", outcome: "failed" }),
        observation({ executionKind: "root_agent_run", executionId: "completed", outcome: "completed" }),
        observation({ executionKind: "root_agent_run", executionId: "running", outcome: "running" }),
        observation({
          executionKind: "root_agent_run",
          executionId: "timeout",
          outcome: "timed_out",
          failureKind: "timeout",
        }),
      ],
    });

    expect(service.query({}).summary.root_agent_run?.failures).toEqual({
      unknown: 1,
      timeout: 1,
    });
    expect(service.query({ failureKinds: ["unknown"] }).records.map((row) => row.executionId))
      .toEqual(["failed"]);
  });

  it("deduplicates warnings by code and source id", () => {
    const service = serviceWith({
      sessionWarnings: [
        { code: "missing_parent_execution", sourceId: "x" },
        { code: "missing_parent_execution", sourceId: "x" },
      ],
      workflowWarnings: [
        { code: "missing_parent_execution", sourceId: "x" },
        { code: "invalid_workflow_event", sourceId: "y" },
      ],
    });

    expect(service.query({}).warnings).toEqual([
      { code: "missing_parent_execution", sourceId: "x" },
      { code: "invalid_workflow_event", sourceId: "y" },
    ]);
  });

  it("never exports record content or absolute paths", () => {
    const dirty = {
      ...observation({ executionKind: "root_agent_run", executionId: "agent-run:x", outcome: "completed" }),
      prompt: "prompt secret",
      output: "tool secret",
      error: "raw error",
      cwd: "C:\\secret\\path",
      baseUrl: "https://provider.example/v1",
    } as ExecutionObservation;

    const json = JSON.stringify(serviceWith({ sessionRecords: [dirty] }).query({}));
    expect(json).not.toContain("prompt secret");
    expect(json).not.toContain("tool secret");
    expect(json).not.toContain("raw error");
    expect(json).not.toContain("provider.example");
    expect(json).not.toMatch(/[A-Z]:\\/);
  });

  it("filters and summarizes bounded automatic review outcomes", () => {
    const service = serviceWith({
      sessionRecords: [
        observation({
          executionKind: "root_agent_run",
          executionId: "agent-run:r1",
          outcome: "completed",
          review: { policyVersion: "risk-v1", riskLevel: "high", status: "findings", verdict: "fail", findingCount: 2 },
        }),
        observation({
          executionKind: "root_agent_run",
          executionId: "agent-run:r2",
          outcome: "completed",
          review: { policyVersion: "risk-v1", riskLevel: "medium", status: "passed", verdict: "pass" },
        }),
        observation({ executionKind: "root_agent_run", executionId: "agent-run:r3", outcome: "completed" }),
      ],
    });

    const filtered = service.query({ reviewStatuses: ["findings"], reviewRiskLevels: ["high"] });
    expect(filtered.records.map((record) => record.executionId)).toEqual(["agent-run:r1"]);

    const all = service.query({});
    expect(all.summary.root_agent_run?.reviews).toEqual({ findings: 1, passed: 1 });
  });
});
