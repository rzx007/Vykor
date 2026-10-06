import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryEngine, ToolRegistry, type StreamEvent } from "@vykor/core";
import { OpenAICompatibleClient } from "../../../../api/src/providers/openai.js";
import { PermissionChecker } from "../../../../permissions/src/index.js";
import { fileWriteTool } from "../write.js";

// Synthetic replays of observed failure shapes, not captured provider transcripts.
// Only the HTTP boundary is replaced; SDK decoding, permissions and file writes run for real.
const original = "unchanged before a committed call\n";
type ReplayRequest = {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
};

afterEach(() => vi.restoreAllMocks());

function frame(delta: object, finishReason: string | null = null) {
  return {
    id: "chatcmpl-offline", object: "chat.completion.chunk", created: 0, model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  };
}

function nativeCall(id: string, file: string, content: string) {
  return frame({ tool_calls: [{ index: 0, id, type: "function", function: {
    name: "Write", arguments: JSON.stringify({ file_path: file, content }),
  } }] });
}

function dsmlCall(file: string, content: string) {
  return [
    frame({ content: '<｜DSML｜tool_calls><｜DSML｜invoke name="Write"><｜DSML｜parameter name="arguments" string="false">' }),
    frame({ content: JSON.stringify({ file_path: file, content }) }),
    frame({ content: "</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>" }),
    frame({}, "stop"),
  ];
}

function replay(cwd: string, attempts: unknown[][]) {
  const requests: ReplayRequest[] = [];
  const client = new OpenAICompatibleClient({ apiKey: "offline-fixture", baseURL: "https://offline.invalid/v1" });
  vi.spyOn(client.client as unknown as { fetch: typeof fetch }, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://offline.invalid/v1/chat/completions");
    const frames = attempts[requests.length];
    requests.push(JSON.parse(String(init?.body)) as ReplayRequest);
    if (!frames) throw new Error("Unexpected extra replay request");
    let position = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (init?.signal?.aborted) { controller.error(init.signal.reason); return; }
        if (position === frames.length) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } else controller.enqueue(encoder.encode(`data: ${JSON.stringify(frames[position++])}\n\n`));
      },
    }, { highWaterMark: 0 });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const registry = new ToolRegistry();
  registry.register(fileWriteTool, { kind: "builtin" });
  const permissions = new PermissionChecker({ mode: "default", cwd, autoApproveTools: ["Write"] });
  const engine = new QueryEngine(client, registry, permissions,
    { register() {}, execute: async () => ({ blocked: false }) }, {
      cwd, model: "fixture", trajectoryTrackerFactory: false,
      modelRetry: { baseDelayMs: 0, maxDelayMs: 0 },
      settings: { model: "fixture", apiFormat: "openai", maxTurns: 4, permission: { mode: "default" }, sandbox: { enabled: false } },
    });
  return { engine, requests };
}

describe("offline protocol replay through real file tools", () => {
  it("continues after a wrapped DSML Write and preserves its tool-call identity through execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oh-dsml-file-replay-"));
    try {
      const file = join(directory, "fixture.txt");
      const body = "complete DSML fixture content\n";
      await writeFile(file, original);
      const { engine, requests } = replay(directory, [dsmlCall(file, body), [frame({ content: "done" }, "stop")]]);
      const events: StreamEvent[] = [];
      for await (const event of engine.submitMessage("replace the fixture")) {
        events.push(event);
        if (event.type === "tool_generation_progress") {
          expect(await readFile(file, "utf8")).toBe(original);
          expect(JSON.stringify(event)).not.toContain(body.trim());
        }
      }
      const progress = events.filter(event => event.type === "tool_generation_progress");
      expect(progress).not.toHaveLength(0);
      expect(progress.at(-1)).toMatchObject({ toolKey: "dsml_0", toolUseId: "dsml_0", attempt: 1 });
      const starts = events.filter(event => event.type === "tool_use_start");
      expect(starts).toHaveLength(1);
      expect(starts[0]!.toolUse).toMatchObject({ id: "dsml_0", name: "Write" });
      expect(events.indexOf(progress.at(-1)!)).toBeLessThan(events.indexOf(starts[0]!));
      expect(events.filter(event => event.type === "tool_use_end")).toMatchObject([
        { toolUseId: "dsml_0", result: { executionState: "completed" } },
      ]);
      expect(events.filter(event => event.type === "tool_use_end")[0]!.result.isError).not.toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.messages.some(message => message.role === "tool" && message.tool_call_id === "dsml_0")).toBe(true);
      expect(events.filter(event => event.type === "text_delta").map(event => event.delta).join("")).toBe("done");
      expect(await readFile(file, "utf8")).toBe(body);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["upstream error", "missing completion"])("does not write an abandoned native invocation after %s", async fault => {
    const directory = await mkdtemp(join(tmpdir(), "oh-interrupted-file-replay-"));
    try {
      const file = join(directory, "fixture.txt");
      await writeFile(file, original);
      const abandoned: unknown[] = [nativeCall("abandoned", file, "must never reach disk\n")];
      if (fault === "upstream error") abandoned.push({ error: { message: "Upstream stream terminated unexpectedly before completion" } });
      const { engine, requests } = replay(directory, [
        abandoned,
        [nativeCall("accepted", file, "accepted after recovery\n"), frame({}, "tool_calls")],
        [frame({ content: "done" }, "stop")],
      ]);
      const events: StreamEvent[] = [];
      for await (const event of engine.submitMessage("replace the fixture")) {
        events.push(event);
        if (event.type === "model_retry") expect(await readFile(file, "utf8")).toBe(original);
      }
      expect(requests).toHaveLength(3);
      expect(requests[1]!.messages).toEqual(requests[0]!.messages);
      expect(events.filter(event => event.type === "model_retry")).toMatchObject([{ reason: "stream_incomplete", retryNumber: 1 }]);
      expect(events.filter(event => event.type === "tool_use_start").map(event => event.toolUse.id)).toEqual(["accepted"]);
      expect(events.filter(event => event.type === "tool_use_end").map(event => event.toolUseId)).toEqual(["accepted"]);
      expect(engine.getHistory().filter(message => message.type === "assistant").flatMap(message => message.toolUses ?? []).map(call => call.id))
        .toEqual(["accepted"]);
      expect(events.filter(event => event.type === "model_attempt_finished").map(event => event.status)).toEqual(["failed", "completed", "completed"]);
      expect(await readFile(file, "utf8")).toBe("accepted after recovery\n");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["native", "DSML"])("keeps the file unchanged when the user cancels during %s argument generation", async protocol => {
    const directory = await mkdtemp(join(tmpdir(), "oh-cancel-file-replay-"));
    try {
      const file = join(directory, "fixture.txt");
      await writeFile(file, original);
      const controller = new AbortController();
      const reason = new Error("offline user cancellation");
      const prefix = `{"file_path":${JSON.stringify(file)},"content":"`;
      // DSML counts tag characters too; put partial JSON in the first progress-producing frame.
      const frames = protocol === "DSML" ? [
        frame({ content: '<｜DSML｜tool_calls><｜DSML｜invoke name="Write"><｜DSML｜parameter name="arguments" string="false">' + prefix }),
        frame({ content: 'cancelled body"}</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>' }),
        frame({}, "stop"),
      ] : [
        frame({ tool_calls: [{ index: 0, id: "cancelled", type: "function", function: { name: "Write", arguments: prefix } }] }),
        frame({ tool_calls: [{ index: 0, function: { arguments: 'cancelled body"}' } }] }),
        frame({}, "tool_calls"),
      ];
      const { engine, requests } = replay(directory, [frames]);
      const events: StreamEvent[] = [];
      await expect((async () => {
        for await (const event of engine.submitMessage("replace the fixture", { signal: controller.signal })) {
          events.push(event);
          if (event.type === "tool_generation_progress" && event.receivedChars > 0) controller.abort(reason);
        }
      })()).rejects.toBe(reason);
      expect(requests).toHaveLength(1);
      expect(events.some(event => event.type === "tool_generation_progress" && event.receivedChars > 0)).toBe(true);
      expect(events.some(event => event.type === "model_retry" || event.type === "tool_use_start" || event.type === "tool_use_end")).toBe(false);
      expect(events.filter(event => event.type === "model_attempt_finished")).toMatchObject([{ status: "interrupted" }]);
      expect(engine.getHistory().filter(message => message.type === "assistant").flatMap(message => message.toolUses ?? [])).toEqual([]);
      expect(await readFile(file, "utf8")).toBe(original);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
