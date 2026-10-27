import { expect, it, vi } from "vitest";
import { ChildRunTerminationError, type AgentEvent, type AgentRunResult } from "@vykor/agent-contracts";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { FrameworkAgentRun } from "./framework-run.test-support.js";
import { AgentEventBus } from "../../../kernel/event-source.js";

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it.each(["completed", "failed", "failed_then_timeout", "max_turns", "timeout", "user_cancelled", "parent_interrupted"] as const)("freezes one %s outcome for settlement and terminal saving", async cause => {
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const cleanup = gate(), release = gate();
  let calls = 0, settledCalls = 0;
  const registry = new ToolRegistry();
  registry.register({ name: "Read", description: "limit read", inputSchema: {}, execute: async () => ({ content: [] }) });
  const engine = new QueryEngine({ async *streamMessage() {
    calls++;
    if (cause === "failed" || cause === "failed_then_timeout") throw new Error("original failure output");
    if (cause === "max_turns") {
      if (calls === 1) { yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "limit-read", name: "Read", input: {} } }; yield { type: "complete", stopReason: "tool_use" }; }
      else { yield { type: "text_delta", delta: "finalization:" + "x".repeat(12_001) }; yield { type: "complete", stopReason: "end_turn" }; }
      return;
    }
    yield { type: "text_delta", delta: "committed result" };
    yield { type: "complete", stopReason: "end_turn" };
  } }, registry, { checkTool: async () => ({ action: "allow" }) }, { register() {}, execute: async () => ({ blocked: false }) }, { trajectoryTrackerFactory: false });
  const run = new FrameworkAgentRun({ agentId: "child", identity: { childId: "child-1" }, ids: { inputId: "i", runId: "r", traceId: "t" }, content: "work", delivery: "queue",
    externalSignal: controller.signal, engine,
    ...(cause === "max_turns" ? { hardMaxTurns: 2 } : {}),
    session: { id: "s", getHistory: () => engine.getHistory(), submitMessage: engine.submitMessage.bind(engine) },
    eventBus: new AgentEventBus(event => { events.push(event); }),
    preparation: { prepare: async () => ({ run: { tools: new Map(registry.getAll().map(definition => [definition.name, { definition, invoke: definition.execute }])) }, release: async () => { cleanup.resolve(); await release.promise; } }) },
    effects: {}, children: { cwd: process.cwd(), createController: () => ({}) }, onSettled: () => { settledCalls++; },
  });
  await cleanup.promise;
  expect(run.active).toBe(true);
  expect(events.some(event => ["run.completed", "run.failed", "run.interrupted"].includes(event.type))).toBe(false);
  if (["timeout", "user_cancelled", "parent_interrupted"].includes(cause)) controller.abort(new ChildRunTerminationError(cause as "timeout" | "user_cancelled" | "parent_interrupted", `stop:${cause}`));
  if (cause === "failed_then_timeout") controller.abort(new ChildRunTerminationError("timeout", "deadline after original failure"));
  release.resolve();
  const actual = await run.settled;
  await run.result.catch(() => {});
  const terminal = events.find(event => ["run.completed", "run.failed", "run.interrupted"].includes(event.type))!;
  expect(terminal.data.output).toBe(actual.result.output);
  if (cause !== "completed") {
    expect(terminal.data).toMatchObject({ error: { message: (actual.result as any).error }, failureKind: (actual.result as any).failureKind });
    expect((terminal.data as any).partialResult).toEqual((actual.result as any).partialResult);
  }
  if (cause === "max_turns") expect(actual.result.output).toHaveLength(12_000);
  if (cause === "failed_then_timeout") expect(actual.result).toMatchObject({ status: "failed", output: "original failure output", failureKind: "unknown" });
  expect(actual.result.status).toBe(cause === "completed" ? "completed" : ["failed", "failed_then_timeout", "max_turns", "timeout"].includes(cause) ? "failed" : "interrupted");
  expect(calls).toBe(cause === "max_turns" ? 2 : 1); expect(settledCalls).toBe(1);
  await run.interrupt("late duplicate");
  expect(await run.settled).toBe(actual);
  expect(settledCalls).toBe(1);
});

it.each(["invocation", "cleanup"] as const)("does not commit completed while cancellation arrives during %s after tool timeout", async phase => {
  const entered = gate(), invocation = gate(), cleanup = gate(), released = gate();
  const controller = new AbortController();
  const registry = new ToolRegistry();
  registry.register({ name: "Read", description: "controlled read", inputSchema: {}, execute: async () => { entered.resolve(); await invocation.promise; return { content: [{ type: "text", text: "read" }] }; } });
  let calls = 0;
  const events: AgentEvent[] = [];
  const engine = new QueryEngine({ async *streamMessage() {
    if (++calls === 1) { yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "held", name: "Read", input: {} } }; yield { type: "complete", stopReason: "tool_use" }; }
    else { yield { type: "text_delta", delta: "model already ended" }; yield { type: "complete", stopReason: "end_turn" }; }
  } }, registry, { checkTool: async () => ({ action: "allow" }) }, { register() {}, execute: async () => ({ blocked: false }) }, { toolTimeoutMs: 5, trajectoryTrackerFactory: false });
  const run = new FrameworkAgentRun({ agentId: "child", identity: { childId: "c" }, ids: { inputId: "i", runId: "r", traceId: "t" }, content: "work", delivery: "queue", externalSignal: controller.signal,
    engine, runtime: { queryEngine: engine }, session: { id: "s", getHistory: () => engine.getHistory(), submitMessage: engine.submitMessage.bind(engine) },
    prepareCapabilities: async () => ({ capabilityView: { tools: new Map([...registry.getAll()].map(definition => [definition.name, { definition, invoke: definition.execute }])) } }),
    eventBus: new AgentEventBus(event => { events.push(event); }), effects: {}, children: { cwd: process.cwd(), createController: () => ({}) }, onSettled() {},
    preparation: { prepare: async () => ({ run: { tools: new Map([...registry.getAll()].map(definition => [definition.name, { definition, invoke: definition.execute }])) }, release: async () => { cleanup.resolve(); await released.promise; } }) },
  });
  await entered.promise;
  await vi.waitFor(() => expect(events.filter(event => event.type === "output.turn.completed")).toHaveLength(2));
  expect(run.active).toBe(true);
  if (phase === "cleanup") { invocation.resolve(); await cleanup.promise; }
  controller.abort(new ChildRunTerminationError("user_cancelled", "cancel before real stop"));
  invocation.resolve(); await cleanup.promise;
  expect(run.active).toBe(true);
  released.resolve();
  expect((await run.settled).result).toMatchObject({ status: "interrupted", failureKind: "user_cancelled", output: "model already ended" });
  await expect(run.result).rejects.toThrow("cancel before real stop");
  expect(events.filter(event => event.type === "run.interrupted")).toHaveLength(1);
});
