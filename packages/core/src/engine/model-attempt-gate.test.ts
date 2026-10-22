import { describe, expect, it } from "vitest";
import type { AgentExecutionContext, AgentRunScope, ModelAttemptGate, ModelAttemptSettlement, StreamEvent, StreamingMessageClient } from "@vykor/agent-contracts";
import { ModelRequestFailure } from "@vykor/agent-contracts";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { streamBufferedModelWithRetry } from "./buffered-model-retry.js";

const scope: AgentRunScope = { agentId: "s", sessionId: "s", runId: "r", inputId: "i", traceId: "t", cwd: "/workspace", signal: new AbortController().signal };
const retry = { baseDelayMs: 0, maxDelayMs: 0 };

it.each(["before", "started", "settle"])("does not hide a compaction %s failure behind context fallback or prompt retries", async boundary => {
  const failure = new Error("the input exceeds the available context size of the model");
  let calls = 0;
  const purposes: string[] = [];
  const engine = new QueryEngine({ async *streamMessage() { calls++; yield { type: "text_delta", delta: "summary" }; yield { type: "complete", stopReason: "end_turn" }; } },
    new ToolRegistry(), { checkTool: async () => ({ action: "allow" }) } as never, { execute: async () => ({ blocked: false }) } as never,
    { trajectoryTrackerFactory: false, maxTokens: 100, compactKeepRecent: 1 });
  engine.loadMessages([{ type: "user", content: "old question" }, { type: "assistant", content: "old answer" }, { type: "user", content: "recent" }]);
  const execution = { scope, modelAttempts: {
    beforeDispatch: async (input: { purpose: string }) => { purposes.push(input.purpose); if (boundary === "before") throw failure; },
    settle: async () => { if (boundary === "settle") throw failure; },
  }, emit: async (event: { type: string }) => { if (boundary === "started" && event.type === "model.attempt.started") throw failure; },
    takeSteeredInputs: async () => [], closeSteering() {},
  } as unknown as AgentExecutionContext;
  await expect((async () => { for await (const _ of engine.submitMessage("q", { execution })) {} })()).rejects.toBe(failure);
  expect(purposes).toEqual(["compaction"]);
  expect(calls).toBe(boundary === "settle" ? 1 : 0);
});

it("admits a forced final answer using the actual finalization purpose", async () => {
  const purposes: string[] = [];
  const engine = new QueryEngine({ async *streamMessage() { yield { type: "text_delta", delta: "final answer" }; yield { type: "complete", stopReason: "end_turn" }; } },
    new ToolRegistry(), { checkTool: async () => ({ action: "allow" }) } as never, { execute: async () => ({ blocked: false }) } as never,
    { trajectoryTrackerFactory: false });
  const execution = { scope, hardMaxTurns: 1, modelAttempts: { beforeDispatch: async (input: { purpose: string }) => { purposes.push(input.purpose); }, settle: async () => {} },
    emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {},
  } as unknown as AgentExecutionContext;
  await expect((async () => { for await (const _ of engine.submitMessage("q", { execution })) {} })()).rejects.toMatchObject({ name: "MaxTurnsExceeded" });
  expect(purposes).toEqual(["finalization"]);
});

describe.each(["main", "buffered"] as const)("%s model attempt gate", kind => {
  function fixture(input: { before?: ModelAttemptGate["beforeDispatch"]; settle?: ModelAttemptGate["settle"]; started?: () => void; client?: StreamingMessageClient; signal?: AbortSignal } = {}) {
    let calls = 0;
    const admissions: Array<{ generationId: string; attempt: number }> = [];
    const settlements: ModelAttemptSettlement[] = [];
    const gate: ModelAttemptGate = {
      beforeDispatch: async admission => { admissions.push(admission); await input.before?.(admission); },
      settle: async settlement => { settlements.push(settlement); await input.settle?.(settlement); },
    };
    const client: StreamingMessageClient = { async *streamMessage(params) {
      calls++;
      if (input.client) yield* input.client.streamMessage(params);
      else { yield { type: "text_delta", delta: "answer" }; yield { type: "complete", stopReason: "end_turn" }; }
    } };
    const execution = { scope, modelAttempts: gate, emit: async (event: { type: string }) => { if (event.type === "model.attempt.started") input.started?.(); }, takeSteeredInputs: async () => [], closeSteering() {} } as unknown as AgentExecutionContext;
    const engine = new QueryEngine(client, new ToolRegistry(), { checkTool: async () => ({ action: "allow" }) } as never,
      { execute: async () => ({ blocked: false }) } as never, { trajectoryTrackerFactory: false, modelRetry: retry });
    const run = async () => {
      const stream = kind === "main" ? engine.submitMessage("q", { execution, signal: input.signal })
        : streamBufferedModelWithRetry(client, { model: "m", messages: [], abortSignal: input.signal }, {
          scope, modelAttempts: gate, policy: retry, onAttemptStarted: input.started,
        } as Parameters<typeof streamBufferedModelWithRetry>[2]);
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);
      return events;
    };
    return { run, admissions, settlements, engine, get calls() { return calls; } };
  }

  it("awaits admission before dispatch and settles a real request without usage as unknown", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ before: () => blocked });
    const pending = f.run();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.calls).toBe(0);
    release();
    await pending;
    expect(f.calls).toBe(1);
    expect(f.settlements).toMatchObject([{ status: "completed", usageStatus: "unknown", scope }]);
  });

  it("does not dispatch or settle rejected admission", async () => {
    const rejection = new ModelRequestFailure("budget closed", { kind: "network", phase: "request", retryable: true });
    const f = fixture({ before: async () => { throw rejection; } });
    await expect(f.run()).rejects.toBe(rejection);
    expect(f.calls).toBe(0);
    expect(f.admissions).toHaveLength(1);
    expect(f.settlements).toEqual([]);
  });

  it.each(["failure", "cancel"])("settles admitted started %s as not dispatched", async boundary => {
    const controller = new AbortController();
    const failure = new Error("sink or cancellation");
    const f = fixture({ signal: controller.signal, started: () => { if (boundary === "cancel") controller.abort(failure); else throw failure; } });
    await expect(f.run()).rejects.toBe(failure);
    expect(f.calls).toBe(0);
    expect(f.settlements).toMatchObject([{ status: boundary === "cancel" ? "interrupted" : "failed", usageStatus: "complete", notDispatched: true }]);
  });

  it("does not retry the provider when durable settlement fails", async () => {
    const failure = new ModelRequestFailure("storage unavailable", { kind: "network", phase: "request", retryable: true });
    const f = fixture({ settle: async () => { throw failure; } });
    await expect(f.run()).rejects.toBe(failure);
    expect(f.calls).toBe(1);
    expect(f.settlements).toHaveLength(1);
    if (kind === "main") expect(f.engine.getHistory().filter(message => message.type === "assistant")).toEqual([]);
  });

  it("keeps one generation identity and increments every retry attempt", async () => {
    let calls = 0;
    const f = fixture({ client: { async *streamMessage() {
      if (++calls === 1) throw new ModelRequestFailure("disconnect", { kind: "network", phase: "request", retryable: true });
      yield { type: "complete", stopReason: "end_turn" };
    } } });
    await f.run();
    expect(f.admissions.map(value => value.attempt)).toEqual([1, 2]);
    expect(new Set(f.admissions.map(value => value.generationId)).size).toBe(1);
    expect(f.settlements.map(value => value.status)).toEqual(["failed", "completed"]);
  });
});
