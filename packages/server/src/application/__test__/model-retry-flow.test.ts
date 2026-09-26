import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRequestFailure, QueryEngine, ToolRegistry, type AgentEvent, type StreamingMessageClient, type ToolDefinition } from "@vykor/core";
import { SessionStore } from "@vykor/services";
import { applyEvents, createInitialClientState, selectVisibleSessionMessagesWithParts } from "../../../../client/src/index.js";
import { FrameworkAgentRun } from "../../../../agent-runtime/src/framework-agent-run.js";
import { AgentEventBus } from "../../../../agent-runtime/src/event-source.js";
import { DaemonAgentEventProjector } from "../agent/daemon-agent-event-projector.js";
import { SessionTranscriptProjection } from "../session/transcript-projection.js";
import { buildAgentTranscript } from "../agent/agent-transcript.js";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) close(); });

function harness(client: StreamingMessageClient, tools: ToolDefinition[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "vykor-model-retry-flow-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "session.db");
  const store = new SessionStore({ path });
  cleanup.push(() => store.close());
  const session = store.sessions.create({ cwd: directory, model: "test", metadata: { runtime: { model: "test" } } });
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const engine = new QueryEngine(client, registry,
    { checkTool: async () => ({ action: "allow", reason: "test" }) } as any,
    { execute: async () => ({ blocked: false }) } as any,
    { cwd: directory, trajectoryTrackerFactory: false,
      modelRetry: { baseDelayMs: 0, maxDelayMs: 0, maxTotalRetries: 2 } });
  const events: AgentEvent[] = [];
  const projector = new DaemonAgentEventProjector({
    rootAgent: {} as any, store,
    transcriptProjection: new SessionTranscriptProjection(store),
    executionProjector: {} as any,
    liveChildren: { register() {}, unregister() {} },
    events: { checkpoint: () => store.conversations.latestEventSeq(), publish() {}, publishSince() {} },
    log() {},
  });
  const bus = new AgentEventBus(async event => { events.push(event); await projector.apply(event); });
  let count = 0;
  const start = (content = "work") => new FrameworkAgentRun({
    agentId: "a", ids: { inputId: `i${++count}`, runId: `r${count}`, traceId: `t${count}` },
    content, delivery: "queue", eventBus: bus,
    session: { id: session.id, getHistory: () => engine.getHistory(),
      submitMessage: (text: string, options: any) => engine.submitMessage(text, options) } as any,
    runtime: { queryEngine: engine } as any, effects: {} as any,
    children: { cwd: directory, createController: () => ({}) } as any, onSettled() {},
  });
  return { store, path, session, engine, events, projector, start };
}

function reset(): never {
  throw new ModelRequestFailure("socket reset", { kind: "network", phase: "stream", retryable: true });
}

describe("model retry through engine, runtime, durable projection and client", () => {
  it.each(["end_turn", "max_tokens"])("replaces partial text and restores committed history after %s", async stopReason => {
    let calls = 0;
    let requestedHistory = "";
    const h = harness({ async *streamMessage(params) {
      requestedHistory = JSON.stringify(params.messages);
      if (++calls === 1) {
        yield { type: "text_delta", delta: "obsolete" };
        yield { type: "reasoning_delta", delta: "obsolete thought", source: "think" };
        reset();
      }
      yield { type: "text_delta", delta: "answer" };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
      yield { type: "complete", stopReason };
    } });
    const run = h.start();
    const result = await run.result;
    expect(calls).toBe(2);
    expect(result.output).not.toContain("obsolete");
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, usageIncomplete: true });
    const durableRun = h.store.runs.getRun(run.id)!;
    expect(durableRun.status).toBe("completed");
    expect(durableRun.metadata.modelRetry).toBeNull();
    expect(durableRun.metadata.modelUsage).toMatchObject({ incomplete: true, unknownAttempts: 1 });
    const records = h.store.conversations.listEvents({ sessionId: h.session.id });
    const state = applyEvents(createInitialClientState(), records);
    const visible = selectVisibleSessionMessagesWithParts(state.buckets[h.session.id]);
    expect(JSON.stringify(visible)).not.toContain("obsolete");
    expect(JSON.stringify(visible)).toContain("answer");
    const restored = new SessionStore({ path: h.path });
    try {
      const transcript = buildAgentTranscript(restored.conversations.listMessages(h.session.id), restored.conversations.listMessageParts(h.session.id));
      expect(JSON.stringify(transcript.messages)).not.toContain("obsolete");
      expect(JSON.stringify(transcript.messages)).toContain("answer");
      if (stopReason === "max_tokens") {
        expect(result.output.match(/回复已被截断/g)).toHaveLength(1);
        expect(JSON.stringify(transcript.messages)).toContain("回复已被截断");
      }
      h.engine.loadMessages(transcript.messages);
      await h.start("follow up after reload").result;
      expect(requestedHistory).toContain("follow up after reload");
      expect(requestedHistory).toContain("answer");
      expect(requestedHistory).not.toContain("obsolete");
    } finally { restored.close(); }
    expect(applyEvents(state, records)).toEqual(state);
  });

  it("does not repeat a completed tool when the next model call disconnects", async () => {
    let calls = 0;
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }] }));
    const h = harness({ async *streamMessage() {
      calls++;
      if (calls === 1) {
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "tool1", name: "Counter", input: {} } };
        yield { type: "complete", stopReason: "tool_use" };
      } else if (calls === 2) { reset(); }
      else { yield { type: "text_delta", delta: "finished" }; yield { type: "complete", stopReason: "end_turn" }; }
    } }, [{ name: "Counter", description: "count", inputSchema: { type: "object", properties: {} }, execute }]);
    await h.start().result;
    expect(calls).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
    const history = buildAgentTranscript(h.store.conversations.listMessages(h.session.id), h.store.conversations.listMessageParts(h.session.id)).messages;
    expect(history.filter(m => m.type === "tool_result")).toHaveLength(1);
    expect(history.filter(m => m.type === "assistant").flatMap(m => m.toolUses ?? [])).toHaveLength(1);
  });

  it("never retries a projection failure after model output", async () => {
    const client: StreamingMessageClient = { streamMessage: vi.fn(async function* () {
      yield { type: "text_delta" as const, delta: "answer" };
      yield { type: "complete" as const, stopReason: "end_turn" };
    }) };
    const h = harness(client);
    const upsert = h.store.conversations.upsertMessagePart.bind(h.store.conversations);
    vi.spyOn(h.store.conversations, "upsertMessagePart").mockImplementation(input => {
      if (input.metadata?.modelGeneration) throw new Error("disk failed");
      return upsert(input);
    });
    await expect(h.start().result).rejects.toThrow("disk failed");
    expect(client.streamMessage).toHaveBeenCalledTimes(1);
    expect(h.events.filter(e => e.type === "model.retry.scheduled")).toHaveLength(0);
  });

  it.each([false, true])("settles retryable=%s exactly once after its bounded attempts", async retryable => {
    let calls = 0;
    const h = harness({ async *streamMessage() {
      calls++;
      throw new ModelRequestFailure("unavailable", {
        kind: retryable ? "network" : "authentication", phase: "request", retryable,
      });
    } });
    const run = h.start();
    await expect(run.result).rejects.toThrow("unavailable");
    expect(calls).toBe(retryable ? 3 : 1);
    expect(h.store.runs.getRun(run.id)?.status).toBe("failed");
    expect(h.events.filter(e => e.type === "run.failed")).toHaveLength(1);
    expect(h.store.runs.getRun(run.id)?.metadata.modelRetry ?? null).toBeNull();
  });

  it("cancels the wait without issuing another request", async () => {
    let calls = 0;
    const h = harness({ async *streamMessage() {
      calls++;
      throw new ModelRequestFailure("rate limited", { kind: "rate_limit", phase: "request", retryable: true, retryAfterMs: 30_000 });
    } });
    const run = h.start();
    const rejection = expect(run.result).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(h.events.some(e => e.type === "model.retry.scheduled")).toBe(true));
    await run.interrupt("stopped");
    await rejection;
    expect(calls).toBe(1);
    expect(h.store.runs.getRun(run.id)?.status).toBe("interrupted");
    expect(h.store.runs.getRun(run.id)?.metadata.modelRetry).toBeNull();
  });

  it("records an in-flight cancellation before interrupting the durable run", async () => {
    let calls = 0;
    const h = harness({ async *streamMessage(params) {
      calls++;
      yield { type: "text_delta", delta: "partial" };
      yield { type: "usage", usage: { inputTokens: 6, outputTokens: 2 } };
      await new Promise<void>((resolve) => params.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
      throw params.abortSignal?.reason;
    } });
    const run = h.start();
    const rejected = expect(run.result).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(h.events.some(e => e.type === "output.text.delta")).toBe(true));
    await run.interrupt("stopped");
    await rejected;
    expect(calls).toBe(1);
    expect(h.store.runs.getRun(run.id)?.status).toBe("interrupted");
    const settled = h.store.conversations.listEvents({ sessionId: h.session.id })
      .filter(e => e.type === "session.model.attempt.finished");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.payload.attemptUsage).toMatchObject({
      status: "interrupted", usageStatus: "partial", usage: { inputTokens: 6, outputTokens: 2 },
    });
    expect(h.store.runs.getRun(run.id)?.metadata.usage).toMatchObject({ inputTokens: 6, outputTokens: 2 });
    expect(h.events.filter(e => e.type === "tool.started")).toHaveLength(0);
  });
});
