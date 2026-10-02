import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  QueryEngine, ToolRegistry, type AgentExecutionContext, type IHookExecutor,
  type IPermissionChecker, type Message, type StreamEvent,
} from "@vykor/core";
import { fileWriteTool } from "../write.js";
import { computeFileChange } from "../preview.js";

async function scenario(options: { deny?: boolean; ask?: boolean; hash?: string; body?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oh-write-reuse-"));
  try {
    const file = join(dir, "index.html");
    const body = options.body ?? "<!DOCTYPE html>\n<p>完整内容</p>\n".repeat(1000);
    await writeFile(file, "old", "utf8");
    const retry = {
      file_path: file, content_from: "original-write", overwrite: true,
      ...(options.hash ? { expected_sha256: options.hash } : {}),
    };
    let request = 0;
    const modelHistory: Message[][] = [];
    const client = {
      streamMessage: async function* (params: { messages: Message[] }): AsyncIterable<StreamEvent> {
        modelHistory.push(structuredClone(params.messages));
        const step = request++;
        if (step < 2) yield { type: "tool_use_start", toolUse: {
          type: "tool_use", id: step === 0 ? "original-write" : "retry-write", name: "Write",
          input: step === 0 ? { file_path: file, content: body } : retry,
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
      return { action: input.overwrite && options.deny ? "deny" : options.ask ? "ask" : "allow" };
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
  it("applies a large body from a short reference through approval, preview and hooks", async () => {
    const result = await scenario({ ask: true });
    expect(result.text).toBe(result.body);
    expect(result.retry).not.toHaveProperty("content");
    expect(result.checked[1]).toMatchObject({ content: result.body, overwrite: true });
    expect(result.checked[1]).not.toHaveProperty("content_from");
    expect(result.requested).toEqual(result.checked);
    expect(result.hooked).toEqual(result.checked);
    expect(result.previews[1]).toMatchObject({ before: "old", after: result.body });
    const feedback = result.modelHistory[1]!.filter(m => m.type === "tool_result");
    expect(JSON.stringify(feedback)).toContain("original-write");
    expect(JSON.stringify(feedback)).toContain("content_from");
    expect(JSON.stringify(feedback)).not.toContain("完整内容");
  });

  it("keeps the current file when referenced overwrite fails the hash guard", async () => {
    const result = await scenario({ hash: "0".repeat(64) });
    expect(result.text).toBe("old");
    expect(result.results.filter(e => e.type === "tool_use_end").at(-1)).toMatchObject({
      result: { isError: true, failureKind: "invalid_input", executionState: "not_started" },
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
