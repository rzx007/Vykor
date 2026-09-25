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
    ["The relevant test passed. No further action needed.", "passed"],
    ["The test has passed; no edits are needed.", "passed"],
    ["This test passed; no further action is needed.", "passed"],
    ["It passed. No further action needed.", "passed"],
    ["The focused test passed: exit code 0, 1 test passed. No code changed.", "passed"],
    ["The relevant test passed; return code is 0; one test passed.", "passed"],
    ["The focused test passed; one test passed. No files were changed.", "passed"],
    ["Test failed: exit code 1.", "failed"],
    ["The relevant test did not pass.", "failed"],
    ["The relevant test didn't pass.", "failed"],
    ["0 tests passed.", "failed"],
    ["No tests passed.", "failed"],
    ["The relevant test passed, but the test failed.", "failed"],
    ["The relevant test passed with exit code 0.", "passed"],
    ["The relevant test passed; exit code 1.", "failed"],
    ["The relevant test passed; 2 tests passed.", "failed"],
    ["The relevant test passed; two tests passed.", "failed"],
    ["The focused test passed; six tests passed.", "failed"],
    ["The focused test passed; I changed the code.", "failed"],
    ["The focused test passed; I modified one file.", "failed"],
    ["The focused test passed; I made changes to the code.", "failed"],
    ["The focused test passed; files were modified after the test.", "failed"],
    ["The focused test passed; code changed afterward.", "failed"],
    ["An unrelated test passed.", "failed"],
    ["I cannot confirm whether the relevant test passed.", "failed"],
    ["I'm not sure whether the relevant test passed.", "failed"],
    ["I don't know whether the relevant test passed.", "failed"],
    ["I do not know whether the relevant test passed.", "failed"],
    ["It's unclear whether the relevant test passed.", "failed"],
    ["The relevant test passed; return code 0.", "passed"],
    ["The relevant test passed; return code is 0.", "passed"],
    ["The relevant test passed; exit status was 0.", "passed"],
    ["The relevant test passed; the process returned 0.", "passed"],
  ] as const)("C3 reports the user's passing evidence without re-running tools: %s", async (answer, expected) => {
    const item = behaviorCases.find((entry) => entry.id === "C3")!;
    const client: StreamingMessageClient = { async *streamMessage() {
      yield { type: "text_delta" as const, delta: answer };
      yield { type: "complete" as const, stopReason: "end_turn" };
    } };
    const result = await runBehaviorCase(item, { client, model: "scripted", revision: "c3-user-evidence",
      repeat: 1, maxRequests: 2, timeoutMs: 10_000 });
    expect(result.toolCalls).toBe(0);
    expect(result.status).toBe(expected);
  });

  it("C3 scripted fixture finishes without re-running the passed test", async () => {
    const item = behaviorCases.find((entry) => entry.id === "C3")!;
    const result = await runBehaviorCase(item, { client: item.scripted!(), model: "scripted",
      revision: "c3-scripted", repeat: 1, maxRequests: 2, timeoutMs: 10_000 });
    expect(result).toMatchObject({ status: "passed", toolCalls: 0, requestCount: 1 });
    expect(result.evidence?.finalText).toContain("exit code 0");
    expect(result.evidence?.finalText).toContain("1 test passed");
  });

  it("C3 rejects a redundant test run even if the result passes", async () => {
    const item = behaviorCases.find((entry) => entry.id === "C3")!;
    let requests = 0;
    const client: StreamingMessageClient = { async *streamMessage() {
      if (requests++ === 0) {
        yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const,
          id: "relevant-test", name: "RunRelevantTest", input: {} } };
        yield { type: "complete" as const, stopReason: "tool_use" };
      } else {
        yield { type: "text_delta" as const, delta: "Relevant test exited 0; no edits needed." };
        yield { type: "complete" as const, stopReason: "end_turn" };
      }
    } };
    const result = await runBehaviorCase(item, { client, model: "scripted", revision: "c3-redundant-test",
      repeat: 1, maxRequests: 4, timeoutMs: 10_000 });
    expect(result.toolCalls).toBe(1);
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
