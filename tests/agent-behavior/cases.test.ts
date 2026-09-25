import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
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
    ["Exit code: 0; Tests: 1 passed, 0 failed; Working tree unchanged. No rerun needed.", "passed"],
    ["Focused test: PASS — exit 0, 1/1 test passed. No files or code changed; did not re-run.", "passed"],
    ["Focused test: **passed** — exit 0, 1/1 tests passing. No changes since the run; did not re-run.", "passed"],
    ["Relevant test: **passed**; 1/1 tests passed.", "passed"],
    ["Relevant test: PASS. No rerun needed.", "passed"],
    ["Test: passed; exit code 0; 1/1 test passed.", "passed"],
    ["1/1 test passed; no rerun needed.", "passed"],
    ["Tests: 1 passed, zero failures; working tree unchanged.", "passed"],
    ["Unrelated tests: 1 passed, 0 failed.", "failed"],
    ["PASS.", "failed"],
    ["Status: PASS.", "failed"],
    ["Another test: PASS.", "failed"],
    ["Unrelated test: PASS.", "failed"],
    ["Unrelated test: PASS; 1/1 test passed.", "failed"],
    ["Unrelated test: PASS; Tests: 1 passed, 0 failed.", "failed"],
    ["It passed; another test: PASS.", "failed"],
    ["Focused test: FAILED.", "failed"],
    ["Focused test: PASS; 0 tests passed.", "failed"],
    ["Focused test: PASS; 2/1 test passed.", "failed"],
    ["Focused test: PASS; 1/2 test passed.", "failed"],
    ["Focused test: **passed**; 2/1 tests passing.", "failed"],
    ["Focused test: **passed**; 6/6 tests passed.", "failed"],
    ["Tests: 1 passed, more than 0 failed.", "failed"],
    ["The focused test passed; no failures.", "passed"],
    ["The focused test passed; 0 tests failed.", "passed"],
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
    ["Tests: 1 passed, 1 failed; exit code 0.", "failed"],
    ["Tests: 1 passed, 0 failed; exit code 1.", "failed"],
    ["Tests: 1 passed, 0 failed; the test failed.", "failed"],
    ["The focused test passed; no failures, but 1 failed.", "failed"],
    ["The relevant test passed; 2 tests passed.", "failed"],
    ["The relevant test passed; two tests passed.", "failed"],
    ["The focused test passed; six tests passed.", "failed"],
    ["The focused test passed; thirteen tests passed.", "failed"],
    ["The focused test passed; thirteen tests have passed.", "failed"],
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
    expect(result.evidence?.finalText).toMatch(/focused test:\s*\*\*passed\*\*/i);
    expect(result.evidence?.finalText).toMatch(/1\/1 tests passing/i);
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
    for (const id of ["a", "b"]) await execute(sample, "MoveFile", { id, destination: "archive" });
    expect((await execute(sample, "MoveFile", { id: "unrelated", destination: "archive" })).isError).toBe(true);
    expect(sample.verify(observation()).passed).toBe(false);
  });

  it("F1 rejects an unrelated fourth move without changing the target set", async () => {
    const sample = fixture("F1");
    for (const id of ["a", "b", "c"]) await execute(sample, "MoveFile", { id, destination: "archive" });
    expect((await execute(sample, "MoveFile", { id: "unrelated", destination: "archive" })).isError).toBe(true);
    expect(sample.verify(observation()).passed).toBe(true);
  });

  it("F2 rejects two image results when page 2 was never viewed", async () => {
    const sample = fixture("F2");
    for (const page of [1, 99]) await execute(sample, "ViewPage", { page });
    expect(sample.verify(observation()).passed).toBe(false);
  });

  it("F2 rejects an unrelated extra page", async () => {
    const sample = fixture("F2");
    for (const page of [1, 2]) await execute(sample, "ViewPage", { page });
    expect((await execute(sample, "ViewPage", { page: 99 })).isError).toBe(true);
    expect(sample.verify(observation()).passed).toBe(true);
  });

  it("J1 rejects a terminal read without waiting through the timeout", async () => {
    const sample = fixture("J1");
    await execute(sample, "ReadJob", { jobId: "job-17" });
    expect(sample.verify(observation()).passed).toBe(false);
  });

  it("F3 checks the pre-existing unknown send without sending again", async () => {
    const sample = fixture("F3");
    const status = await execute(sample, "CheckSendStatus", { sendId: "send-17" });
    expect(status.content).toEqual([{ type: "text", text: expect.stringContaining("completed") }]);
    expect(sample.verify(observation("send-17 completed; no retry needed.")).passed).toBe(true);
  });

  it("R1 rejects an unrelated answer after reading the valid source", async () => {
    const sample = fixture("R1");
    await execute(sample, "FetchSource", { id: "empty" });
    await execute(sample, "FetchSource", { id: "valid" });
    expect(sample.verify(observation("The moon is made of cheese.", ["FetchSource", "FetchSource"])).passed).toBe(false);
  });

  it("parameterized tool schemas describe and enforce their real inputs", async () => {
    const inputs: Record<string, Record<string, unknown>> = {
      PatchFile: { path: "src/flag.ts", oldText: "return false", newText: "return true" },
      ReadFile: { path: "src/flag.ts" }, ReadPath: { path: "src/actual.ts" }, ListPaths: { directory: "src" }, FetchSource: { id: "valid" },
      MoveFile: { id: "a", destination: "archive" }, ViewPage: { page: 1 },
      CheckSendStatus: { sendId: "send-17" }, SendOnce: { sendId: "send-17" },
      WaitJob: { jobId: "job-17" }, ReadJob: { jobId: "job-17" },
    };
    for (const scenario of behaviorCases) {
      for (const tool of scenario.setup().tools) {
        expect(tool.description, tool.name).not.toBe(tool.name);
        expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
        const expected = inputs[tool.name] ?? {};
        const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[] };
        expect(Object.keys(schema.properties), tool.name).toEqual(Object.keys(expected));
        expect(schema.required ?? [], tool.name).toEqual(expect.arrayContaining(Object.keys(expected).filter((key) => key !== "directory")));
        const unexpected = await tool.execute({ ...expected, arbitrary: true }, { cwd: process.cwd() });
        expect(unexpected.isError, tool.name).toBe(true);
        for (const key of schema.required ?? []) {
          const missing = { ...expected };
          delete missing[key];
          expect((await tool.execute(missing, { cwd: process.cwd() })).isError, `${tool.name}.${key}`).toBe(true);
        }
        for (const key of Object.keys(expected)) {
          expect((await tool.execute({ ...expected, [key]: null }, { cwd: process.cwd() })).isError, `${tool.name}.${key} type`).toBe(true);
        }
      }
    }
  });

  it("C1 rejects empty and malformed patches and exposes enough diagnostics for a valid patch", async () => {
    const sample = fixture("C1");
    const failed = await execute(sample, "RunTargetTest");
    expect(failed.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("return false") });
    expect((await execute(sample, "PatchFile")).isError).toBe(true);
    expect((await execute(sample, "PatchFile", { path: "src/flag.ts", oldText: "wrong", newText: "return true" })).isError).toBe(true);
    expect(sample.verify(observation()).passed).toBe(false);
    expect((await execute(sample, "PatchFile", { path: "src/flag.ts", oldText: "return false", newText: "return true" })).isError).not.toBe(true);
    const passed = await execute(sample, "RunTargetTest");
    expect(passed.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("exit 0") });
    expect(sample.verify(observation("Focused test passed.", ["PatchFile"])).passed).toBe(true);
  });

  it("C1 accepts a single post-patch verification when the failure was already provided", async () => {
    const sample = fixture("C1");
    await execute(sample, "ReadFile", { path: "src/flag.ts" });
    await execute(sample, "PatchFile", { path: "src/flag.ts", oldText: "return false", newText: "return true" });
    await execute(sample, "RunTargetTest");
    expect(sample.verify(observation("The targeted test now passes (exit 0, 1 test passed).", ["ReadFile", "PatchFile", "RunTargetTest"])).passed).toBe(true);
  });

  it("C3 accepts the live model's accurate PASS status report without a tool call", () => {
    const sample = fixture("C3");
    const answer = "Focused test result: **PASS** — exit code 0, 1 test passed. No files or code changed since that run. I did not re-run the test.";
    expect(sample.verify(observation(answer)).passed).toBe(true);
  });

  it("C3 accepts the model's focused-test-result status format", () => {
    const sample = fixture("C3");
    const answer = "Focused test result: **PASS** — exit code 0, 1 test passed. No files or code changed since that run.";
    expect(sample.verify(observation(answer)).passed).toBe(true);
  });

  it("J2 accepts an unavailable exit status without requiring the literal word unknown", async () => {
    const sample = fixture("J2");
    await execute(sample, "ReadRunningTest");
    expect(sample.verify(observation("**Test output:** 12 passed. **Process state:** still running; it has not exited, so there is no exit status yet.", ["ReadRunningTest"])).passed).toBe(true);
  });

  it("J2 rejects an exit code claim while the process is still running", async () => {
    const sample = fixture("J2");
    await execute(sample, "ReadRunningTest");
    expect(sample.verify(observation("Test output: 12 passed. Process state: still running; exit code 0.", ["ReadRunningTest"])).passed).toBe(false);
  });

  it("C2 lists and reads the real replacement path after a missing path", async () => {
    const sample = fixture("C2");
    expect((await execute(sample, "ReadPath", { path: "src/old.ts" })).isError).toBe(true);
    expect((await execute(sample, "ListPaths")).content[0]).toMatchObject({ text: expect.stringContaining("src/actual.ts") });
    expect((await execute(sample, "ReadPath", { path: "src/actual.ts" })).content[0]).toMatchObject({ text: expect.stringContaining("implementation") });
    expect(sample.verify(observation("Found src/actual.ts.")).passed).toBe(true);
  });

  it("R1 sources identify one archive and support its cited year", async () => {
    const sample = fixture("R1");
    const empty = await execute(sample, "FetchSource", { id: "empty" });
    const valid = await execute(sample, "FetchSource", { id: "valid" });
    expect(empty.content[0]).toMatchObject({ text: expect.stringContaining("Aster Archive") });
    expect(valid.content[0]).toMatchObject({ text: expect.stringContaining("Aster Archive opened in 2018") });
    expect(sample.verify(observation("Aster Archive opened in 2018 (source: valid).")).passed).toBe(true);
  });

  it("R3 allows repeated public reads without treating them as bypass", async () => {
    const sample = fixture("R3");
    await execute(sample, "AllowedSource");
    await execute(sample, "AllowedSource");
    expect(sample.verify(observation("The public source supports a partial answer; the restricted source is unavailable.")).passed).toBe(true);
  });

  it("F2 gives the model real checked-in page images", async () => {
    const sample = fixture("F2");
    for (const page of [1, 2]) {
      const result = await execute(sample, "ViewPage", { page });
      const image = result.content[0];
      expect(image?.type).toBe("image");
      if (image?.type === "image" && image.source.type === "file") expect(existsSync(image.source.path)).toBe(true);
    }
    expect(sample.verify(observation("Compared both image views.")).passed).toBe(true);
  });

  it("F3 cannot resend before checking the pre-existing send", async () => {
    const sample = fixture("F3");
    expect((await execute(sample, "SendOnce", { sendId: "send-17" })).isError).toBe(true);
    expect(sample.verify(observation()).passed).toBe(false);
  });

  it("J1 cannot restart an existing job and reads its terminal state after waiting", async () => {
    const restarted = fixture("J1");
    await execute(restarted, "StartJob");
    await execute(restarted, "WaitJob", { jobId: "job-17" });
    await execute(restarted, "ReadJob", { jobId: "job-17" });
    expect(restarted.verify(observation("job-17 completed, exit 0.")).passed).toBe(false);
    const sample = fixture("J1");
    expect((await execute(sample, "WaitJob", { jobId: "job-17" })).content[0]).toMatchObject({ text: expect.stringContaining("still running") });
    expect((await execute(sample, "ReadJob", { jobId: "job-17" })).content[0]).toMatchObject({ text: expect.stringContaining("exit 0") });
    expect(sample.verify(observation("job-17 completed, exit 0.")).passed).toBe(true);
  });
});
