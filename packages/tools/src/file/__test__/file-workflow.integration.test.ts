import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  QueryEngine, ToolRegistry, type AgentExecutionContext, type Message, type StreamEvent,
} from "@vykor/core";
import { fileReadTool } from "../read.js";
import { fileWriteTool } from "../write.js";
import { fileEditTool } from "../edit.js";
import { applyPatchTool } from "../apply-patch.js";
import { buildRuntimeSystemPrompt } from "../../../../prompts/src/index.js";
import { CodexSubscriptionClient } from "../../../../api/src/providers/codex.js";
import { OpenAICompatibleClient } from "../../../../api/src/providers/openai.js";
import { computeFileChange } from "../preview.js";

async function defaultPrompt(cwd: string) {
  const previousConfigDir = process.env.VYKOR_CONFIG_DIR;
  process.env.VYKOR_CONFIG_DIR = join(cwd, "fixture-config");
  try { return await buildRuntimeSystemPrompt({ cwd }); }
  finally {
    if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
    else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
  }
}

// Assert at the consuming request boundary, independently of the prompt builder.
function expectWriteGuidance(system: string | undefined) {
  expect(system).toContain("To create or fully replace a file, call Write once with file_path and complete content");
  expect(system).toContain("The reference copies only content; permission and file-state checks still apply.");
}

describe("one complete file workflow", () => {
  it.each([
    { fault: "missing new_string", wrapped: false },
    { fault: "13923 instead of observed 10099", wrapped: true },
  ])("keeps $fault intact through offline SSE and rejects it before a short correction", async ({ fault, wrapped }) => {
    const dir = await mkdtemp(join(tmpdir(), "oh-offline-edit-input-"));
    try {
      const file = join(dir, "fixture.txt");
      const original = "const todo = 10099;\nconst done = 7;\n";
      const corrected = "const todo = 10099;\nconst done = 8;\n";
      await writeFile(file, original);
      const faultyInput: Record<string, unknown> = fault === "missing new_string"
        ? { file_path: file, old_string: "const done = 7;" }
        : { file_path: file, old_string: "const todo = 13923;", new_string: "const todo = 10099;" };
      const correction = { file_path: file, old_string: "const done = 7;", new_string: "const done = 8;" };
      const calls = [
        { name: "Read", id: "inspect", input: { file_path: file } },
        { name: "Edit", id: "bad-edit", input: wrapped ? { arguments: faultyInput } : faultyInput },
        { name: "Edit", id: "correct-edit", input: { arguments: correction } },
      ];
      const requests: Array<{ messages: Array<{ role: string; tool_call_id?: string; content?: string }> }> = [];
      let beforeCorrection: string | undefined;
      const offlineFetch = async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://offline.invalid/v1/chat/completions");
        const turn = requests.length;
        requests.push(JSON.parse(String(init?.body)));
        if (turn === 2) beforeCorrection = await readFile(file, "utf8");
        const call = calls[turn];
        const chunks: Array<Record<string, unknown>> = [];
        const frame = (delta: object, finishReason: string | null = null) => ({
          id: "chatcmpl-fixture-" + turn, object: "chat.completion.chunk", created: 0, model: "fixture",
          choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
        });
        chunks.push(frame({ role: "assistant", content: "" }));
        if (call) {
          const argumentsJson = JSON.stringify(call.input);
          const split = Math.floor(argumentsJson.length / 2);
          chunks.push(frame({ tool_calls: [{ index: 0, id: call.id, type: "function", function: {
            name: call.name, arguments: argumentsJson.slice(0, split),
          } }] }));
          chunks.push(frame({ tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(split) } }] }));
        }
        chunks.push(frame({}, call ? "tool_calls" : "stop"));
        chunks.push({ id: "chatcmpl-fixture-" + turn, object: "chat.completion.chunk", created: 0, model: "fixture",
          choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
        return new Response(chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      };
      const checked: Array<{ name: string; input: Record<string, unknown> }> = [];
      const approved: Record<string, unknown>[] = [];
      const registry = new ToolRegistry();
      registry.register(fileReadTool); registry.register(fileEditTool);
      const execution = {
        scope: { agentId: "fixture", sessionId: "fixture", inputId: "fixture", runId: "fixture", traceId: "fixture", cwd: dir,
          signal: new AbortController().signal },
        effects: { requestPermission: async (request: { input?: Record<string, unknown> }) => {
          approved.push(structuredClone(request.input!)); return { status: "approved" };
        } },
        emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {},
      } as unknown as AgentExecutionContext;
      const client = new OpenAICompatibleClient({ apiKey: "offline-fixture", baseURL: "https://offline.invalid/v1" });
      // The installed SDK captures its own node-fetch; replace only that HTTP boundary.
      vi.spyOn(client.client as unknown as { fetch: typeof fetch }, "fetch").mockImplementation(offlineFetch);
      const engine = new QueryEngine(client,
        registry, { checkTool: async (name, input) => {
          checked.push({ name, input: structuredClone(input) }); return { action: name === "Read" ? "allow" : "ask" };
        } }, { register() {}, execute: async () => ({ blocked: false }) }, {
          cwd: dir, model: "fixture", trajectoryTrackerFactory: false,
          settings: { model: "fixture", apiFormat: "openai", maxTurns: 10, permission: { mode: "default" }, sandbox: { enabled: false } },
        });
      const events: StreamEvent[] = [];
      for await (const event of engine.submitMessage("offline fixture", { execution })) events.push(event);
      const ends = events.filter(event => event.type === "tool_use_end");
      expect(ends.map(event => event.toolUseId)).toEqual(["inspect", "bad-edit", "correct-edit"]);
      expect(ends[0]?.result.isError).not.toBe(true);
      expect(JSON.stringify(ends[0]?.result.content)).toContain("const todo = 10099;");
      const firstResult = ends[1]!.result;
      expect(firstResult.isError).toBe(true);
      expect(firstResult).toMatchObject({ failureKind: fault === "missing new_string" ? "invalid_input" : "precondition", executionState: "not_started" });
      expect(beforeCorrection).toBe(original);
      expect(checked).toEqual([
        { name: "Read", input: { file_path: file } },
        { name: "Edit", input: faultyInput },
        { name: "Edit", input: correction },
      ]);
      expect(approved).toEqual([faultyInput, correction]);
      if (fault === "missing new_string") expect(checked[1]!.input).not.toHaveProperty("new_string");
      else expect(checked[1]!.input.old_string).toBe("const todo = 13923;");
      expect(ends[2]?.result).toMatchObject({ executionState: "completed" });
      expect(ends[2]?.result.isError).not.toBe(true);
      expect(requests).toHaveLength(4);
      const feedback = requests[2]!.messages.find(message => message.role === "tool" && message.tool_call_id === "bad-edit");
      expect(feedback).toBeDefined();
      if (fault !== "missing new_string") expect(feedback!.content).toContain("const todo = 10099;");
      expect(await readFile(file, "utf8")).toBe(corrected);
    } finally { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); }
  });

  it.each([false, true])("preserves optional Write fields through Codex, reuse and current permissions (deny retry: %s)", async denyRetry => {
    const dir = await mkdtemp(join(tmpdir(), "oh-codex-write-contract-"));
    try {
      const file = join(dir, "target.txt"); await writeFile(file, "old");
      const body = "complete generated body\n".repeat(200);
      const hash = createHash("sha256").update("old").digest("hex");
      const calls = [
        { file_path: file, content: body, expected_sha256: "0".repeat(64) },
        { file_path: file, content_from: "source", expected_sha256: hash },
      ];
      const requests: Array<{ tools: Array<{ name: string; strict?: boolean; parameters: Record<string, unknown> }> }> = [];
      vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
        const turn = requests.length;
        requests.push(JSON.parse(String(init?.body)));
        const frames: Array<Record<string, unknown>> = [];
        if (calls[turn]) frames.push({ type: "response.output_item.done", item: {
          type: "function_call", id: "fc-" + turn, call_id: turn === 0 ? "source" : "retry", name: "Write",
          arguments: JSON.stringify(calls[turn]),
        } });
        frames.push({ type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1 } } });
        return new Response(frames.map(frame => "data: " + JSON.stringify(frame) + "\n\n").join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      });
      const token = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url") + "."
        + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url") + ".sig";
      const checked: Record<string, unknown>[] = [];
      const hooked: Record<string, unknown>[] = [];
      const previews: Array<Awaited<ReturnType<typeof computeFileChange>>> = [];
      const registry = new ToolRegistry(); registry.register(fileWriteTool);
      const engine = new QueryEngine(new CodexSubscriptionClient({ apiKey: token }), registry, {
        checkTool: async (_name, input) => {
          checked.push({ ...input }); previews.push(await computeFileChange("Write", input));
          return { action: denyRetry && checked.length === 2 ? "deny" : "allow" };
        },
      }, { register() {}, execute: async (event, context) => {
        if (event === "pre_tool_use") hooked.push(context.input as Record<string, unknown>);
        return { blocked: false };
      } }, { cwd: dir, model: "gpt-test", trajectoryTrackerFactory: false,
        settings: { model: "gpt-test", apiFormat: "codex", maxTurns: 10, permission: { mode: "default" }, sandbox: { enabled: false } } });
      const events: StreamEvent[] = [];
      for await (const event of engine.submitMessage("fixture")) events.push(event);
      expect(requests).toHaveLength(3);
      for (const request of requests) {
        const tool = request.tools.find(tool => tool.name === "Write")!;
        expect(tool.strict).toBe(false);
        expect(tool.parameters.required).toEqual(["file_path"]);
        expect(Object.keys(tool.parameters.properties as object)).toEqual(["file_path", "content", "content_from", "expected_sha256"]);
      }
      const ends = events.filter(event => event.type === "tool_use_end");
      expect(ends[0]?.result).toMatchObject({ failureKind: "precondition", executionState: "not_started" });
      expect(JSON.stringify(ends[0]?.result.content)).toContain("content_from");
      expect(checked).toHaveLength(2);
      expect(checked[1]).toEqual({ file_path: file, content: body, expected_sha256: hash });
      expect(calls[1]).not.toHaveProperty("content");
      expect(hooked).toHaveLength(denyRetry ? 1 : 2);
      expect(previews[1]).toMatchObject({ before: "old", after: body });
      expect(ends[1]?.result).toMatchObject(denyRetry
        ? { isError: true, failureKind: "permission", executionState: "not_started" }
        : { executionState: "completed" });
      expect(await readFile(file, "utf8")).toBe(denyRetry ? "old" : body);
    } finally { vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps wrong numeric Edit matches rejected and then accepts a complete Write without an extra flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-write-recovery-"));
    try {
      const file = join(dir, "verify.cjs");
      const original = "const todo = 23;\nconst done = 7;\n";
      await writeFile(file, original);
      let requests = 0;
      const checked: string[] = [];
      const registry = new ToolRegistry();
      registry.register(fileEditTool); registry.register(fileWriteTool);
      const engine = new QueryEngine({ async *streamMessage(): AsyncIterable<StreamEvent> {
        const turn = ++requests;
        if (turn <= 2) {
          expect(await readFile(file, "utf8")).toBe(original);
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "edit-" + turn, name: "Edit",
            input: { file_path: file, old_string: "const todo = " + (turn === 1 ? 325 : 884) + ";", new_string: "const todo = 23;" } } };
        } else if (turn === 3) {
          expect(await readFile(file, "utf8")).toBe(original);
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "write", name: "Write",
            input: { file_path: file, content: "const todo = 23;\nconst done = 8;\n" } } };
        }
        yield { type: "complete", stopReason: turn <= 3 ? "tool_use" : "end_turn" };
      } }, registry, { checkTool: async name => { checked.push(name); return { action: "allow" }; } },
      { register() {}, execute: async () => ({ blocked: false }) }, { cwd: dir, trajectoryTrackerFactory: false });
      const events: StreamEvent[] = [];
      for await (const event of engine.submitMessage("fixture")) events.push(event);
      const ends = events.filter(event => event.type === "tool_use_end");
      expect(ends.slice(0, 2).map(e => e.result)).toEqual([
        expect.objectContaining({ failureKind: "precondition", executionState: "not_started" }),
        expect.objectContaining({ failureKind: "precondition", executionState: "not_started" }),
      ]);
      expect(JSON.stringify(ends[0]?.result.content)).toContain("const todo = 23;");
      expect(ends[2]?.result).toMatchObject({ executionState: "completed" });
      expect(ends[2]?.result.isError).not.toBe(true);
      expect(checked).toEqual(["Edit", "Edit", "Write"]);
      expect(requests).toBe(4);
      expect(await readFile(file, "utf8")).toBe("const todo = 23;\nconst done = 8;\n");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("creates a file with one Write while the model sees a stable flat schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-single-write-"));
    try {
      const target = join(dir, "new.html");
      const body = "<p>one call</p>\n".repeat(1200);
      const modelRequests: Array<{ tools: Array<{ name: string; inputSchema: Record<string, unknown> }>; system?: string }> = [];
      const registry = new ToolRegistry();
      registry.register(fileWriteTool, { kind: "builtin" });
      const engine = new QueryEngine({
        streamMessage: async function* (params: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }>; system?: string }): AsyncIterable<StreamEvent> {
          expectWriteGuidance(params.system);
          modelRequests.push({ tools: params.tools, system: params.system });
          if (modelRequests.length === 1) {
            yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "single-write", name: "Write", input: { file_path: target, content: body } } };
            yield { type: "complete", stopReason: "tool_calls" };
          } else yield { type: "complete", stopReason: "end_turn" };
        },
      }, registry, { checkTool: async () => ({ action: "allow" }) },
      { register() {}, execute: async () => ({ blocked: false }) }, {
        cwd: dir, trajectoryTrackerFactory: false, systemPrompt: await defaultPrompt(dir),
      });
      const events: StreamEvent[] = [];
      for await (const event of engine.submitMessage("create fixture")) events.push(event);
      const writeResults = events.filter(e => e.type === "tool_use_end" && e.result.toolName === "Write");
      expect(writeResults).toHaveLength(1);
      expect(writeResults[0]!.result.isError).not.toBe(true);
      expect(Buffer.from(await readFile(target))).toEqual(Buffer.from(body, "utf8"));
      expect(modelRequests).toHaveLength(2);
      const firstSchema = modelRequests[0]!.tools.find(t => t.name === "Write")!.inputSchema;
      expect(firstSchema).toMatchObject({ type: "object", required: ["file_path"], additionalProperties: false });
      expect(Object.keys(firstSchema.properties as object)).toEqual(["file_path", "content", "content_from", "expected_sha256"]);
      expect(modelRequests[1]!.tools.find(t => t.name === "Write")!.inputSchema).toEqual(firstSchema);
      expect(modelRequests[0]!.system).toContain("Write");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("checks first, displays generation, reuses a rejected body, then applies single-file and multi-file batches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-file-workflow-"));
    try {
      const target = join(dir, "index.html");
      await writeFile(target, "old", "utf8");
      const body = "alpha\nbeta\n" + "generated-content".repeat(1500);
      const patch = "--- /dev/null\n+++ a.txt\n@@ -0,0 +1 @@\n+A\n--- /dev/null\n+++ b.txt\n@@ -0,0 +1 @@\n+B\n";
      const approvals: Record<string, unknown>[] = [];
      const lifecycle: Array<{ name: string; phase?: string }> = [];
      const requests: Message[][] = [];
      const systemPrompt = await defaultPrompt(dir);
      let step = 0;
      let inspectedHash: string | undefined;
      const client = {
        streamMessage: async function* (params: { messages: Message[]; system?: string }): AsyncIterable<StreamEvent> {
          expectWriteGuidance(params.system);
          requests.push(structuredClone(params.messages));
          const turn = step++;
          let name: string;
          let input: Record<string, unknown>;
          let id: string;
          if (turn === 0) { name = "Read"; id = "inspect"; input = { file_path: target, info_only: true }; }
          else if (turn === 1) {
            const result = params.messages.find(m => m.type === "tool_result" && m.toolUseId === "inspect");
            if (result?.type === "tool_result") {
              const text = result.content.find(b => b.type === "text");
              if (text?.type === "text") inspectedHash = JSON.parse(text.text).sha256;
            }
            yield { type: "tool_generation_progress", toolKey: "write-body", toolUseId: "write-body", toolName: "Write", receivedChars: 100 };
            yield { type: "tool_generation_progress", toolKey: "write-body", toolUseId: "write-body", toolName: "Write", receivedChars: body.length };
            name = "Write"; id = "write-body"; input = { file_path: target, content: body, expected_sha256: "0".repeat(64) };
          } else if (turn === 2) {
            const feedback = JSON.stringify(params.messages.filter(m => m.type === "tool_result" && m.toolUseId === "write-body"));
            expect(feedback).toContain("Supply the explicit target and intent options in the new call.");
            expect(feedback).toContain("Reusing data does not inherit authorization; normal permissions and state checks still apply.");
            name = "Write"; id = "reuse-body";
            input = { file_path: target, expected_sha256: inspectedHash, content_from: "write-body" };
          } else if (turn === 3) {
            name = "Edit"; id = "batch-edit"; input = { file_path: target, edits: [
              { old_string: "alpha", new_string: "ALPHA" }, { old_string: "beta", new_string: "BETA" },
            ] };
          } else if (turn === 4) { name = "ApplyPatch"; id = "patch-files"; input = { patch }; }
          else { yield { type: "complete", stopReason: "end_turn" }; return; }
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id, name, input } };
          yield { type: "complete", stopReason: "tool_calls" };
        },
      };
      const registry = new ToolRegistry();
      for (const tool of [fileReadTool, fileWriteTool, fileEditTool, applyPatchTool]) registry.register(tool, { kind: "builtin" });
      const signal = new AbortController().signal;
      const execution = {
        scope: { agentId: "fixture", sessionId: "fixture", inputId: "fixture", runId: "fixture", traceId: "fixture", cwd: dir, signal },
        effects: { requestPermission: async (request: { input?: Record<string, unknown> }) => {
          approvals.push({ ...request.input }); return { status: "approved" };
        } },
        emit: async (event: { type: string; data: { name?: string; payload?: { phase?: string } } }) => {
          if (event.type === "domain.event") lifecycle.push({ name: event.data.name!, phase: event.data.payload?.phase });
        },
        takeSteeredInputs: async () => [], closeSteering() {},
      } as unknown as AgentExecutionContext;
      const engine = new QueryEngine(client, registry, { checkTool: async name => ({ action: name === "Read" ? "allow" : "ask" }) },
        { register() {}, execute: async () => ({ blocked: false }) }, {
          cwd: dir, trajectoryTrackerFactory: false, systemPrompt,
          settings: { model: "fixture", apiFormat: "openai", maxTurns: 10, permission: { mode: "default" }, sandbox: { enabled: false } },
        });
      const events: StreamEvent[] = [];
      for await (const event of engine.submitMessage("fixture", { execution })) events.push(event);
      expect(inspectedHash).toMatch(/^[a-f0-9]{64}$/);
      expect(events.filter(e => e.type === "tool_generation_progress").at(-1)).toMatchObject({ receivedChars: body.length, generationId: expect.any(String) });
      const ends = events.filter(e => e.type === "tool_use_end");
      expect(ends.map(e => e.toolUseId)).toEqual(["inspect", "write-body", "reuse-body", "batch-edit", "patch-files"]);
      expect(ends[1]?.result).toMatchObject({ isError: true, executionState: "not_started" });
      expect(ends.slice(2).every(e => !e.result.isError)).toBe(true);
      const rawRetry = requests[3]!.filter(m => m.type === "assistant").flatMap(m => m.toolUses ?? []).find(c => c.id === "reuse-body");
      // In-memory history expands the reference; the actual next model input did not resend a body.
      expect(approvals[1]).toMatchObject({ content: body, expected_sha256: inspectedHash });
      expect(approvals[1]).not.toHaveProperty("content_from");
      expect(rawRetry?.input.content).toBe(body);
      expect(rawRetry?.input.file_path).toBe(target);
      expect(lifecycle.some(e => e.phase === "waiting_permission")).toBe(true);
      expect(lifecycle.some(e => e.phase === "running")).toBe(true);
      expect(await readFile(target, "utf8")).toBe("ALPHA\nBETA\n" + "generated-content".repeat(1500));
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("A\n");
      expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("B\n");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

});
