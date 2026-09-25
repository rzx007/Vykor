import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@vykor/core";
import type { BehaviorObservation } from "./cases.js";
import { behaviorCases } from "./cases.js";
import { runBehaviorCase } from "./run.js";
import type { StreamingMessageClient } from "@vykor/core";

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
  it.each([
    ["Relevant test exited 0; no edits needed.", "passed"],
    ["Test passed: exit code 0, 1 test passed.", "passed"],
    ["The relevant test passed.", "passed"],
    ["Test failed: exit code 1.", "failed"],
    ["1 test passed, but exit code 1.", "failed"],
    ["The relevant test did not pass.", "failed"],
    ["The relevant test didn't pass.", "failed"],
    ["Exit code 0, but the test failed.", "failed"],
    ["0 tests passed.", "failed"],
    ["No tests passed.", "failed"],
    ["No tests passed, but the single test passed.", "failed"],
  ] as const)("C3 classifies grounded answer %s", async (answer, expected) => {
    const item = behaviorCases.find((entry) => entry.id === "C3")!;
    let requests = 0;
    const client: StreamingMessageClient = { async *streamMessage() {
      if (requests++ === 0) {
        yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const,
          id: "relevant-test", name: "RunRelevantTest", input: {} } };
        yield { type: "complete" as const, stopReason: "tool_use" };
      } else {
        yield { type: "text_delta" as const, delta: answer };
        yield { type: "complete" as const, stopReason: "end_turn" };
      }
    } };
    const result = await runBehaviorCase(item, { client, model: "scripted", revision: "c3-phrasing",
      repeat: 1, maxRequests: 4, timeoutMs: 10_000 });
    expect(result.evidence?.events.find((event) => event.type === "tool.completed"))
      .toMatchObject({ content: [{ type: "text", text: "exit 0; 1 test passed" }] });
    expect(result.status).toBe(expected);
  });

  it("C3 rejects an unsupported success claim without running the relevant test", async () => {
    const item = behaviorCases.find((entry) => entry.id === "C3")!;
    const client: StreamingMessageClient = { async *streamMessage() {
      yield { type: "text_delta" as const, delta: "The relevant test passed." };
      yield { type: "complete" as const, stopReason: "end_turn" };
    } };
    const result = await runBehaviorCase(item, { client, model: "scripted", revision: "c3-missing-tool",
      repeat: 1, maxRequests: 2, timeoutMs: 10_000 });
    expect(result.status).toBe("failed");
  });

  it.each([true, false])("J3 rejects B before compaction or absent after compaction (early B=%s)", async (earlyB) => {
    const item = behaviorCases.find((entry) => entry.id === "J3")!;
    let request = 0;
    const client: StreamingMessageClient = { async *streamMessage(params) {
      if (params.maxTokens === 20_000 && !params.tools) {
        yield { type: "text_delta", delta: "A completed; continue B; keep job-17." };
      } else {
        const name = request++ === 0 ? "CompleteA" : earlyB && request === 2 ? "CompleteB" : undefined;
        if (name) {
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id: name, name, input: {} } };
          yield { type: "complete", stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta", delta: "done" };
      }
      yield { type: "complete", stopReason: "end_turn" };
    } };
    const result = await runBehaviorCase(item, { client, model: "scripted", revision: "negative", repeat: 1, maxRequests: 25, timeoutMs: 120_000 });
    expect(result.reason).toContain(`A=1; B=${earlyB ? 1 : 0}; compacted=true`);
    expect(result.reason).toContain("ordered=false");
    expect(result.status).toBe("failed");
  });

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
