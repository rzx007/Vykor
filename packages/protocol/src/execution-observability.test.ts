import { describe, expect, it } from "vitest";
import { parseExecutionObservationFilter } from "./execution-observability.js";

describe("parseExecutionObservationFilter", () => {
  it("parses bounded comma-separated filters", () => {
    expect(parseExecutionObservationFilter({
      kind: "child_agent_run,workflow_task",
      outcome: "completed,failed",
      from: "100",
      to: "200",
      sessionId: "s1",
      model: "deepseek-v4.1-flash",
    })).toEqual({
      executionKinds: ["child_agent_run", "workflow_task"],
      outcomes: ["completed", "failed"],
      from: 100,
      to: 200,
      sessionId: "s1",
      model: "deepseek-v4.1-flash",
    });
  });

  it.each([
    [{ kind: "other" }, "invalid_execution_kind"],
    [{ outcome: "success" }, "invalid_execution_outcome"],
    [{ from: "NaN" }, "invalid_observation_from"],
    [{ from: "200", to: "100" }, "invalid_observation_range"],
  ])("rejects %j", (input, code) => {
    expect(() => parseExecutionObservationFilter(input)).toThrow(code);
  });

  it("parses automatic review filters", () => {
    expect(
      parseExecutionObservationFilter({ reviewStatus: "passed,findings", reviewRisk: "high,medium" }),
    ).toEqual({
      reviewStatuses: ["passed", "findings"],
      reviewRiskLevels: ["high", "medium"],
    });
  });

  it("rejects unknown automatic review filters", () => {
    expect(() => parseExecutionObservationFilter({ reviewStatus: "wibble" })).toThrow(
      "invalid_execution_review_status",
    );
    expect(() => parseExecutionObservationFilter({ reviewRisk: "critical" })).toThrow(
      "invalid_execution_review_risk",
    );
  });
});
