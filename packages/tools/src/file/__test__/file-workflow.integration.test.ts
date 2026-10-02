import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  QueryEngine, ToolRegistry, type AgentExecutionContext, type Message, type StreamEvent,
} from "@vykor/core";
import { fileReadTool } from "../read.js";
import { fileWriteTool } from "../write.js";
import { fileEditTool } from "../edit.js";
import { applyPatchTool } from "../apply-patch.js";

describe("one complete file workflow", () => {
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
      let step = 0;
      let inspectedHash: string | undefined;
      const client = {
        streamMessage: async function* (params: { messages: Message[] }): AsyncIterable<StreamEvent> {
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
            name = "Write"; id = "write-body"; input = { file_path: target, content: body };
          } else if (turn === 2) {
            name = "Write"; id = "reuse-body";
            input = { file_path: target, content_from: "write-body", overwrite: true, expected_sha256: inspectedHash };
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
          cwd: dir, trajectoryTrackerFactory: false,
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
      expect(approvals[1]).toMatchObject({ content: body, overwrite: true, expected_sha256: inspectedHash });
      expect(approvals[1]).not.toHaveProperty("content_from");
      expect(rawRetry?.input.content).toBe(body);
      expect(lifecycle.some(e => e.phase === "waiting_permission")).toBe(true);
      expect(lifecycle.some(e => e.phase === "running")).toBe(true);
      expect(await readFile(target, "utf8")).toBe("ALPHA\nBETA\n" + "generated-content".repeat(1500));
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("A\n");
      expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("B\n");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
