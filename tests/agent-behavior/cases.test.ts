import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@vykor/core";
import type { BehaviorObservation } from "./cases.js";
import { behaviorCases } from "./cases.js";

function fixture(id: string) {
  return behaviorCases.find((item) => item.id === id)!.setup();
}

async function execute(sample: ReturnType<typeof fixture>, name: string, input: Record<string, unknown> = {}) {
  return await sample.tools.find((item) => item.name === name)!.execute(input, { cwd: process.cwd() });
}

function observation(finalText = "", toolNames: string[] = []): BehaviorObservation {
  const events = toolNames.map((name) => ({
    type: "tool.started", data: { toolUse: { type: "tool_use", id: name, name, input: {} } },
  })) as AgentEvent[];
  return { history: [], events, finalText, compacted: false, requests: [] };
}

describe("case verifiers reject incomplete evidence", () => {
  it("F1 rejects three moves when the required file c is missing", async () => {
    const sample = fixture("F1");
    for (const id of ["a", "b", "unrelated"]) await execute(sample, "MoveFile", { id });
    expect(sample.verify(observation()).passed).toBe(false);
  });

  it("F1 rejects an unrelated fourth move", async () => {
    const sample = fixture("F1");
    for (const id of ["a", "b", "c", "unrelated"]) await execute(sample, "MoveFile", { id });
    expect(sample.verify(observation()).passed).toBe(false);
  });

  it("F2 rejects two image results when page 2 was never viewed", async () => {
    const sample = fixture("F2");
    for (const page of [1, 99]) await execute(sample, "ViewPage", { page });
    expect(sample.verify(observation()).passed).toBe(false);
  });

  it("F2 rejects an unrelated extra page", async () => {
    const sample = fixture("F2");
    for (const page of [1, 2, 99]) await execute(sample, "ViewPage", { page });
    expect(sample.verify(observation()).passed).toBe(false);
  });

  it("J1 rejects a terminal read without waiting through the timeout", async () => {
    const sample = fixture("J1");
    await execute(sample, "StartJob");
    await execute(sample, "ReadJob", { jobId: "job-17" });
    expect(sample.verify(observation()).passed).toBe(false);
  });

  it("F3 rejects checking status before the send's unknown outcome", async () => {
    const sample = fixture("F3");
    await execute(sample, "CheckSendStatus");
    await execute(sample, "SendOnce");
    expect(sample.verify(observation()).passed).toBe(false);
  });

  it("R1 rejects an unrelated answer after reading the valid source", async () => {
    const sample = fixture("R1");
    await execute(sample, "FetchSource", { id: "empty" });
    await execute(sample, "FetchSource", { id: "valid" });
    expect(sample.verify(observation("The moon is made of cheese.", ["FetchSource", "FetchSource"])).passed).toBe(false);
  });
});
