import { describe, expect, it } from "vitest";
import { settleSessionToolMetadata } from "./session-model.js";

describe("settleSessionToolMetadata", () => {
  it.each(["preparing", "waiting_permission", "queued"])("closes %s as not started without a guessed output", phase => {
    expect(settleSessionToolMetadata({ outcome: "pending", toolProgress: { phase } })).toEqual({
      toolProgress: null, executionState: "not_started", outcome: "interrupted", failureKind: "interrupted",
    });
  });

  it.each([
    { phase: "completed", executionState: "completed", outcome: "completed" },
    { phase: "failed", executionState: "completed", outcome: "failed", failureKind: "command" },
    { phase: "completed", executionState: "not_started", outcome: "completed" },
    { phase: "unknown", executionState: "unknown", outcome: "unknown", failureKind: "timeout" },
    { phase: "unknown", executionState: "unknown", outcome: "failed", failureKind: "timeout" },
  ])("preserves returned facts: %j", ({ phase, ...facts }) => {
    const { executionState, ...existing } = facts;
    const metadata = settleSessionToolMetadata({ ...existing, toolProgress: { phase, executionState } });
    expect(metadata).toMatchObject({ ...facts, toolProgress: null });
    expect(metadata).not.toHaveProperty("output");
    if (facts.outcome === "completed") expect(metadata).not.toHaveProperty("failureKind");
  });

  it("preserves durable returned facts after progress was cleared", () => {
    expect(settleSessionToolMetadata({ executionState: "completed", outcome: "failed", failureKind: "command", toolProgress: null }))
      .toEqual({ executionState: "completed", outcome: "failed", failureKind: "command", toolProgress: null });
  });

  it("does not retain a legacy unknown failure kind for a known unstarted call", () => {
    expect(settleSessionToolMetadata({ executionState: "not_started", outcome: "failed", failureKind: "unknown_outcome" }))
      .toEqual({ executionState: "not_started", outcome: "failed", failureKind: "interrupted", toolProgress: null });
  });

  it.each([{}, { toolProgress: { phase: "running" } }, { executionState: "invalid", toolProgress: [] }])("marks missing reliable facts as unknown: %j", metadata => {
    expect(settleSessionToolMetadata(metadata)).toMatchObject({ executionState: "unknown", outcome: "unknown", failureKind: "unknown_outcome" });
  });
});
