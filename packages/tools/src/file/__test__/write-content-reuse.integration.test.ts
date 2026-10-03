import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  QueryEngine, ToolRegistry, type AgentExecutionContext, type IHookExecutor,
  type IPermissionChecker, type Message, type StreamEvent,
} from "@vykor/core";
import { fileWriteTool } from "../write.js";
import { computeFileChange } from "../preview.js";

async function scenario(options: { deny?: boolean; ask?: boolean; conflict?: boolean; body?: string; changeBeforeRetry?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oh-write-reuse-"));
  try {
    const file = join(dir, "index.html");
    const body = options.body ?? "<!DOCTYPE html>\n<p>完整内容</p>\n".repeat(1000);
    await writeFile(file, "old", "utf8");
    const retry = { file_path: file, content_from: "original-write",
      ...(options.changeBeforeRetry ? { expected_sha256: createHash("sha256").update("old").digest("hex") } : {}),
      ...(options.conflict ? { expected_sha256: createHash("sha256").update("snapshot before concurrent change").digest("hex") } : {}) };
    let request = 0;
    const modelHistory: Message[][] = [];
    const client = {
      streamMessage: async function* (params: { messages: Message[] }): AsyncIterable<StreamEvent> {
        modelHistory.push(structuredClone(params.messages));
        const step = request++;
        if (step === 1 && options.changeBeforeRetry) await writeFile(file, "externally updated", "utf8");
        if (step < 2) yield { type: "tool_use_start", toolUse: {
          type: "tool_use", id: step === 0 ? "original-write" : "retry-write", name: "Write",
          input: step === 0 ? { file_path: file, content: body, expected_sha256: "0".repeat(64) } : retry,
        } };
        yield { type: "complete", stopReason: step < 2 ? "tool_calls" : "end_turn" };
      },
    };
    const checked: Record<string, unknown>[] = [];
    const requested: Record<string, unknown>[] = [];
    const hooked: Record<string, unknown>[] = [];
    const previews: Array<Awaited<ReturnType<typeof computeFileChange>>> = [];
    const permissions: IPermissionChecker = { checkTool: async (_, input) => {
      checked.push({ ...input });
      previews.push(await computeFileChange("Write", input));
      return { action: options.deny && checked.length === 2 ? "deny" : options.ask ? "ask" : "allow" };
    } };
    const hooks: IHookExecutor = { register() {}, execute: async (event, context) => {
      if (event === "pre_tool_use") hooked.push({ ...context.input as Record<string, unknown> });
      return { blocked: false };
    } };
    const signal = new AbortController().signal;
    const execution = {
      scope: { agentId: "test", sessionId: "test", inputId: "test", runId: "test", traceId: "test", cwd: dir, signal },
      effects: { requestPermission: async (permission: { input?: Record<string, unknown> }) => {
        requested.push({ ...permission.input });
        return { status: "approved" };
      } },
      emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {},
    } as unknown as AgentExecutionContext;
    const registry = new ToolRegistry();
    registry.register(fileWriteTool, { kind: "builtin" });
    const engine = new QueryEngine(client, registry, permissions, hooks, { cwd: dir, trajectoryTrackerFactory: false });
    const results: StreamEvent[] = [];
    for await (const event of engine.submitMessage("fixture", options.ask ? { execution } : {})) results.push(event);
    return { text: await readFile(file, "utf8"), body, retry, checked, requested, hooked, previews, results, modelHistory };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Write content reuse with the real file tool", () => {
  it("recovers one generated body using the failure text and a flat reference call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-write-visible-body-reuse-"));
    try {
      const file = join(dir, "target.html"); await writeFile(file, "original");
      const body = "<!doctype html>\n<p>body generated once</p>\n".repeat(1000);
      let step = 0; let generatedBodies = 0; let contentFrom: string | undefined;
      const first = { arguments: { content: body, prepared_from: "obsolete-reference" }, file_path: file };
      const client = { streamMessage: async function* (params: { messages: Message[] }): AsyncIterable<StreamEvent> {
        const turn = step++;
        const texts = params.messages.filter(m => m.type === "tool_result").at(-1)?.content
          .filter(c => c.type === "text").map(c => c.text) ?? [];
        let input: Record<string, unknown> | undefined;
        if (turn === 0) { input = first; generatedBodies++; }
        if (turn === 1) {
          const feedback = texts.join("\n");
          expect(feedback).not.toContain("body generated once");
          expect(feedback).not.toMatch(/regenerate|resend.*body/i);
          const reference = feedback.match(/content_from=("(?:[^"\\]|\\.)*")/);
          expect(reference).not.toBeNull();
          contentFrom = JSON.parse(reference![1]!);
          expect(await readFile(file, "utf8")).toBe("original");
          input = { file_path: file, content_from: contentFrom };
        }
        if (input) yield { type: "tool_use_start", toolUse: { type: "tool_use", id: randomUUID(), name: "Write", input } };
        yield { type: "complete", stopReason: input ? "tool_calls" : "end_turn" };
      } };
      const registry = new ToolRegistry(); registry.register(fileWriteTool);
      const engine = new QueryEngine(client, registry, { checkTool: async () => ({ action: "allow" }) },
        { register() {}, execute: async () => ({ blocked: false }) }, { cwd: dir, trajectoryTrackerFactory: false });
      const results: StreamEvent[] = []; for await (const event of engine.submitMessage("fixture")) results.push(event);
      const ends = results.filter(e => e.type === "tool_use_end");
      expect(ends).toHaveLength(2);
      expect(ends[0]!.result).toMatchObject({ isError: true, executionState: "not_started" });
      expect(first).toEqual({ arguments: { content: body, prepared_from: "obsolete-reference" }, file_path: file });
      expect(contentFrom).toBe(ends[0]!.toolUseId);
      expect(ends[1]!.result).toMatchObject({ executionState: "completed" });
      expect(generatedBodies).toBe(1);
      expect(await readFile(file)).toEqual(Buffer.from(body, "utf8"));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("applies a large body from a short reference through approval, preview and hooks", async () => {
    const result = await scenario({ ask: true });
    expect(result.text).toBe(result.body);
    expect(result.retry).not.toHaveProperty("content");
    expect(result.checked[1]).toMatchObject({ content: result.body });
    expect(result.checked[1]).not.toHaveProperty("content_from");
    expect(result.requested).toEqual(result.checked);
    expect(result.hooked).toEqual(result.checked);
    expect(result.previews[1]).toMatchObject({ before: "old", after: result.body });
    expect(result.checked[1]).toHaveProperty("file_path");
    expect(result.checked[1]).not.toHaveProperty("prepared_from");
    const feedback = result.modelHistory[1]!.filter(m => m.type === "tool_result");
    expect(JSON.stringify(feedback)).toContain("original-write");
    expect(JSON.stringify(feedback)).toContain("content_from");
    expect(JSON.stringify(feedback)).not.toContain("完整内容");
  });

  it("keeps the current file when referenced overwrite fails the hash guard", async () => {
    const result = await scenario({ conflict: true });
    expect(result.text).toBe("old");
    expect(result.results.filter(e => e.type === "tool_use_end").at(-1)).toMatchObject({
      result: { isError: true, failureKind: "precondition", executionState: "not_started" },
    });
  });

  it("checks actual file changes between a failed Write and its content_from retry", async () => {
    const result = await scenario({ changeBeforeRetry: true });
    expect(result.retry).not.toHaveProperty("content");
    expect(result.retry.content_from).toBe("original-write");
    expect(result.checked[1]).toMatchObject({ content: result.body });
    expect(result.text).toBe("externally updated");
    expect(result.results.filter(e => e.type === "tool_use_end").at(-1)).toMatchObject({
      result: { isError: true, failureKind: "precondition", executionState: "not_started" },
    });
  });

  it("keeps the current file when current permissions reject the referenced write", async () => {
    const result = await scenario({ deny: true });
    expect(result.text).toBe("old");
    expect(result.hooked).toHaveLength(1);
    expect(result.results.filter(e => e.type === "tool_use_end").at(-1)).toMatchObject({
      result: { failureKind: "permission", executionState: "not_started" },
    });
  });

  it("can reference an empty body to intentionally empty an existing file", async () => {
    const result = await scenario({ body: "" });
    expect(result.text).toBe("");
    expect(result.results.filter(e => e.type === "tool_use_end").at(-1)).toMatchObject({
      result: { executionState: "completed" },
    });
  });
});
