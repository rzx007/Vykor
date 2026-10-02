import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { externalToolMetadata } from "./tool-result-feedback.js";
import type { AgentEventInput, AgentExecutionContext, StreamEvent, ToolDefinition } from "../index.js";
import { AgentEventBus } from "../../../agent-runtime/src/event-source.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function call(id: string, value: unknown = id, name = "Mutate"): StreamEvent {
  return { type: "tool_use_start", toolUse: { type: "tool_use", id, name, input: { value } } };
}

async function fixture(options: {
  calls?: StreamEvent[];
  batches?: StreamEvent[][];
  execute?: ToolDefinition["execute"];
  permission?: (input: Record<string, unknown>) => "allow" | "deny" | "ask";
  blockHook?: boolean;
  signal?: AbortSignal;
  script?: () => AsyncIterable<StreamEvent>;
  onLifecycle?: (event: AgentEventInput) => void;
  onObserver?: (event: AgentEventInput) => void;
  requestPermission?: AgentExecutionContext["effects"]["requestPermission"];
  hook?: (name: string) => void;
  onEvent?: (event: StreamEvent) => Promise<void>;
  toolTimeoutMs?: number;
} = {}) {
  const executed: unknown[] = [], checked: unknown[] = [], approved: unknown[] = [];
  const lifecycle: AgentEventInput[] = [], events: StreamEvent[] = [];
  const registry = new ToolRegistry();
  const execute: ToolDefinition["execute"] = async (input, context) => {
    executed.push(input.value);
    return options.execute?.(input, context) ?? { content: [{ type: "text", text: String(input.value) }] };
  };
  registry.register({ name: "Mutate", description: "fixture", serialGroup: "mutation", inputSchema: {
    type: "object", properties: { value: { type: "string" } }, required: ["value"],
  }, execute } as ToolDefinition);
  registry.register({ name: "Other", description: "fixture", inputSchema: { type: "object" }, execute });
  let request = 0;
  const engine = new QueryEngine({ streamMessage: async function* () {
    const batch = options.batches?.[request];
    if (batch) yield* batch;
    if (request++ === 0 && !options.batches) {
      if (options.script) yield* options.script();
      else yield* options.calls ?? [call("first"), call("second")];
    }
    yield { type: "complete", stopReason: request === 1 ? "tool_use" : "end_turn" } as const;
  } }, registry, { checkTool: async (_, input) => {
    checked.push(input.value);
    return { action: options.permission?.(input) ?? "allow" };
  } }, { register() {}, execute: async (name) => { options.hook?.(name); return { blocked: name === "pre_tool_use" && options.blockHook === true }; } },
  { trajectoryTrackerFactory: false, toolTimeoutMs: options.toolTimeoutMs });
  const deliveryErrors: unknown[] = [];
  const bus = new AgentEventBus(event => { lifecycle.push(event); options.onLifecycle?.(event); });
  if (options.onObserver) bus.subscribe(options.onObserver);
  const execution = { emit: async (event: AgentEventInput) => {
    try { await bus.emit(event, { agentId: "a", sessionId: "s" }); }
    catch (error) { deliveryErrors.push(error); throw error; }
  }, scope: { signal: options.signal ?? new AbortController().signal },
    effects: { requestPermission: options.requestPermission ?? (async (input: { input?: Record<string, unknown> }) => {
      approved.push(input.input?.value); return { status: "denied" };
    }) }, takeSteeredInputs: async () => [] } as unknown as AgentExecutionContext;
  let error: unknown;
  try { for await (const event of engine.submitMessage("work", { signal: options.signal, execution })) { events.push(event); await options.onEvent?.(event); } }
  catch (caught) { error = caught; }
  return { executed, checked, approved, events, lifecycle, error, deliveryErrors, history: engine.getHistory() };
}

function results(events: StreamEvent[]) { return events.filter(e => e.type === "tool_use_end").map(e => e.result); }

describe("tool workflow", () => {
  it.each([undefined, false])("normalizes explicit unknown with isError=%s as uncertain feedback", async (isError) => {
    const result = await fixture({ calls: [call("first")], execute: async () => ({
      content: [{ type: "text", text: "uncertain output" }], executionState: "unknown", isError,
    }) });
    expect(results(result.events)[0]).toMatchObject({ isError: true, executionState: "unknown", failureKind: "unknown_outcome" });
    expect(results(result.events)[0]!.content).toContainEqual({ type: "text", text: "uncertain output" });
    expect(JSON.stringify(result.history.filter(message => message.type === "tool_result"))).toContain("execution=unknown");
  });

  it("does not unlock a failed mutation using unknown evidence", async () => {
    const result = await fixture({ batches: [
      [call("failed", "same")], [call("uncertain", "uncertain", "Other")], [call("retry", "same")],
    ], execute: async input => input.value === "same"
      ? { content: [], isError: true, executionState: "completed", failureKind: "command" }
      : { content: [], executionState: "unknown" },
    });
    expect(result.executed).toEqual(["same", "uncertain"]);
    expect(results(result.events)[2]).toMatchObject({ executionState: "not_started", metadata: { recoveryGuard: "repeated_failed_call" } });
  });

  it.each(["prepare", "deny", "hook", "execute", "unknown"])("stops a serial group after %s failure without authorizing its successor", async (failure) => {
    const result = await fixture({
      calls: [call("first", failure === "prepare" ? 1 : "first"), call("second"), call("other", "other", "Other")],
      permission: input => failure === "deny" && input.value === "first" ? "ask" : "allow",
      blockHook: failure === "hook",
      execute: async input => input.value === "first" && ["execute", "unknown"].includes(failure)
        ? { content: [], isError: failure === "execute", executionState: failure === "unknown" ? "unknown" : "completed" }
        : { content: [] },
    });
    expect(result.checked).not.toContain("second");
    expect(result.executed).not.toContain("second");
    expect(result.approved).not.toContain("second");
    expect(results(result.events)[1]).toMatchObject({ isError: true, executionState: "not_started", metadata: { recoveryGuard: expect.any(String) } });
    if (failure !== "hook") expect(result.executed).toContain("other");
  });

  it("serializes same-group execution while other tools can release the first call", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const result = await fixture({ calls: [call("first"), call("second"), call("other", "other", "Other")], execute: async input => {
      order.push(`start:${input.value}`);
      if (input.value === "first") await gate;
      if (input.value === "other") release();
      order.push(`end:${input.value}`);
      return { content: [] };
    } });
    expect(result.error).toBeUndefined();
    expect(order.indexOf("start:second")).toBeGreaterThan(order.indexOf("end:first"));
    expect(order.indexOf("start:other")).toBeLessThan(order.indexOf("end:first"));
  });

  it("does not record a blocked successor as a real failed input after its predecessor is corrected", async () => {
    const result = await fixture({ batches: [
      [call("failed", "first"), call("blocked", "second")],
      [call("corrected", "fixed"), call("retried", "second")],
    ], execute: async input => input.value === "first"
      ? { content: [], isError: true, executionState: "not_started", failureKind: "invalid_input" }
      : { content: [] },
    });
    expect(result.executed).toEqual(["first", "fixed", "second"]);
    expect(results(result.events)[3]).toMatchObject({ executionState: "completed" });
  });

  it("emits completed facts as soon as a fast parallel call returns", async () => {
    let release!: () => void;
    const slow = new Promise<void>(resolve => { release = resolve; });
    const result = await fixture({ calls: [call("slow"), call("fast", "fast", "Other")], execute: async input => {
      if (input.value === "slow") await slow;
      return { content: [{ type: "text", text: `${input.value} output` }] };
    }, onLifecycle: event => {
      if (event.type === "domain.event" && event.data.name === "tool.lifecycle" && event.data.payload?.toolUseId === "fast" && event.data.payload.phase === "completed") release();
    } });
    expect(result.error).toBeUndefined();
    expect(results(result.events).map(r => r.content)).toEqual([
      [{ type: "text", text: "slow output" }], [{ type: "text", text: "fast output" }],
    ]);
  });

  it("keeps returned output and settles interrupted calls before throwing cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel fixture");
    const result = await fixture({ calls: [call("first"), call("second"), call("third")], signal: controller.signal,
      execute: async input => {
        if (input.value === "second") { controller.abort(reason); throw reason; }
        return { content: [{ type: "text", text: "already completed" }] };
      },
    });
    expect(result.error).toBe(reason);
    expect(result.executed).toEqual(["first", "second"]);
    expect(results(result.events)).toMatchObject([
      { content: [{ type: "text", text: "already completed" }], executionState: "completed" },
      { failureKind: "interrupted", executionState: "unknown" },
      { failureKind: "interrupted", executionState: "not_started" },
    ]);
  });

  it("preserves returned output when a display observer throws during cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel during display");
    const result = await fixture({ signal: controller.signal, onObserver: event => {
      if (event.type === "domain.event" && event.data.name === "tool.lifecycle" && event.data.payload?.phase === "completed") {
        controller.abort(reason);
        throw new Error("display sink closed");
      }
    } });
    expect(result.error).toBe(reason);
    expect(result.deliveryErrors).toEqual([]);
    expect(results(result.events)).toMatchObject([
      { content: [{ type: "text", text: "first" }], executionState: "completed" },
      { failureKind: "interrupted", executionState: "not_started" },
    ]);
  });

  it("settles started tools, cancels pending approval and blocks successors after a reliable terminal failure", async () => {
    const controller = new AbortController();
    let releaseSlow!: () => void, markSlowStarted!: () => void, markPermissionWaiting!: () => void, markSinkFailed!: () => void;
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    const slowStarted = new Promise<void>(resolve => { markSlowStarted = resolve; });
    const permissionWaiting = new Promise<void>(resolve => { markPermissionWaiting = resolve; });
    const sinkFailed = new Promise<void>(resolve => { markSinkFailed = resolve; });
    let waitingSignal!: AbortSignal, startedSignal!: AbortSignal, settled = false;
    const storageError = new Error("terminal storage unavailable");
    const pending = fixture({ signal: controller.signal,
      calls: [call("fast"), call("successor"), call("slow", "slow", "Other"), call("approval", "approval", "Other")],
      permission: input => input.value === "approval" ? "ask" : "allow",
      requestPermission: async (_, scope) => {
        waitingSignal = scope.signal;
        markPermissionWaiting();
        return new Promise((_, reject) => {
          if (scope.signal.aborted) reject(scope.signal.reason);
          else scope.signal.addEventListener("abort", () => reject(scope.signal.reason), { once: true });
        });
      },
      execute: async (input, context) => {
        if (input.value === "slow") { startedSignal = context.runAbortSignal!; markSlowStarted(); await slow; }
        if (input.value === "fast") await Promise.all([slowStarted, permissionWaiting]);
        return { content: [{ type: "text", text: `${input.value} output` }] };
      },
      onLifecycle: event => {
        if (event.type === "domain.event" && event.data.payload?.toolUseId === "fast" && event.data.payload.phase === "completed") {
          markSinkFailed(); throw storageError;
        }
      },
    }).then(result => { settled = true; return result; });
    await sinkFailed;
    await new Promise<void>(resolve => setImmediate(resolve));
    const settledWhileSlowStillWaiting = settled;
    const approvalCancelled = waitingSignal.aborted;
    const startedToolCancelled = startedSignal.aborted;
    releaseSlow();
    // Also clean up the old broken implementation's outstanding approval.
    if (!approvalCancelled) controller.abort(new Error("test cleanup"));
    const result = await pending;
    expect(settledWhileSlowStillWaiting).toBe(false);
    expect(approvalCancelled).toBe(true);
    expect(startedToolCancelled).toBe(false);
    expect(result.executed).toEqual(expect.arrayContaining(["fast", "slow"]));
    expect(result.executed).not.toContain("successor");
    expect(result.checked).not.toContain("successor");
    expect(result.executed).not.toContain("approval");
    expect(result.error).toBe(result.deliveryErrors[0]);
    expect(result.error).toMatchObject({ cause: storageError });
    expect(results(result.events)).toMatchObject([
      { executionState: "completed" }, { executionState: "not_started" },
      { executionState: "completed", content: [{ type: "text", text: "slow output" }] }, { executionState: "not_started" },
    ]);
    expect(result.history.filter(message => message.type === "tool_result")).toHaveLength(4);
    expect(result.events.some(event => event.type === "model_retry")).toBe(false);
  });

  it.each(["queued", "waiting_permission", "permission.requested", "permission.resolved", "running", "completed"])(
    "propagates the original reliable %s delivery failure after retaining every result", async stage => {
      const storageError = new Error(`storage failed at ${stage}`);
      const result = await fixture({ permission: () => stage.includes("permission") ? "ask" : "allow",
        onLifecycle: event => {
          if (event.type === stage || (event.type === "domain.event" && event.data.payload?.phase === stage)) throw storageError;
        },
      });
      expect(result.error).toBe(result.deliveryErrors[0]);
      expect(result.error).toMatchObject({ cause: storageError });
      expect(result.history.filter(message => message.type === "tool_result")).toHaveLength(2);
      expect(result.executed).toEqual(stage === "completed" ? ["first"] : []);
      expect(result.events.some(event => event.type === "model_retry")).toBe(false);
    },
  );

  it("does not swallow reliable storage failure when user cancellation happens concurrently", async () => {
    const controller = new AbortController();
    const storageError = new Error("actual reliable storage failure");
    const result = await fixture({ signal: controller.signal, onLifecycle: event => {
      if (event.type === "domain.event" && event.data.payload?.phase === "completed") {
        controller.abort(new Error("user cancelled"));
        throw storageError;
      }
    } });
    expect(result.error).toBe(result.deliveryErrors[0]);
    expect(result.error).toMatchObject({ cause: storageError });
    expect(results(result.events)[0]).toMatchObject({ executionState: "completed", content: [{ type: "text", text: "first" }] });
  });

  it("preserves completed results and reports a post hook failure without retrying tools", async () => {
    const hookError = new Error("post hook failed");
    const result = await fixture({ hook: name => { if (name === "post_tool_use") throw hookError; } });
    expect(result.error).toBe(hookError);
    expect(result.executed).toEqual(["first", "second"]);
    expect(results(result.events)).toMatchObject([{ executionState: "completed" }, { executionState: "completed" }]);
    expect(result.history.filter(message => message.type === "tool_result")).toHaveLength(2);
  });

  it("keeps a post hook error fatal when that hook also cancels the run", async () => {
    const controller = new AbortController();
    const hookError = new Error("post hook failed during cancellation");
    const result = await fixture({ signal: controller.signal, hook: name => {
      if (name === "post_tool_use") { controller.abort(new Error("cancel run")); throw hookError; }
    } });
    expect(result.error).toBe(hookError);
    expect(result.history.filter(message => message.type === "tool_result")).toHaveLength(2);
    expect(results(result.events).every(result => result.executionState === "completed")).toBe(true);
  });

  it("settles pending approval as not started on ordinary user cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel approval");
    let approvalSignal!: AbortSignal;
    const result = await fixture({ signal: controller.signal, permission: () => "ask", requestPermission: async (_, scope) => {
      approvalSignal = scope.signal;
      controller.abort(reason);
      scope.signal.throwIfAborted();
      return { status: "approved" };
    } });
    expect(approvalSignal.aborted).toBe(true);
    expect(result.error).toBe(reason);
    expect(result.executed).toEqual([]);
    expect(result.deliveryErrors).toEqual([]);
    expect(results(result.events)).toMatchObject([
      { executionState: "not_started", failureKind: "interrupted" }, { executionState: "not_started", failureKind: "interrupted" },
    ]);
  });

  it("keeps pre hook failures fail-open", async () => {
    const result = await fixture({ hook: name => { if (name === "pre_tool_use") throw new Error("pre hook unavailable"); } });
    expect(result.error).toBeUndefined();
    expect(result.executed).toEqual(["first", "second"]);
  });

  it("keeps the first delivery error while an already started tool settles through its normal timeout", async () => {
    vi.useFakeTimers();
    const firstError = new Error("first reliable failure");
    const laterError = new Error("later reliable failure");
    let markSlowStarted!: () => void, markSinkFailed!: () => void;
    const slowStarted = new Promise<void>(resolve => { markSlowStarted = resolve; });
    const sinkFailed = new Promise<void>(resolve => { markSinkFailed = resolve; });
    const resultPromise = fixture({ calls: [call("fast"), call("slow", "slow", "Other")], toolTimeoutMs: 20,
      execute: async input => {
        if (input.value === "slow") { markSlowStarted(); return new Promise(() => {}); }
        await slowStarted;
        return { content: [{ type: "text", text: "fast output" }] };
      },
      onLifecycle: event => {
        if (event.type !== "domain.event") return;
        if (event.data.payload?.phase === "completed") { markSinkFailed(); throw firstError; }
        if (event.data.payload?.phase === "unknown") throw laterError;
      },
    });
    await sinkFailed;
    await vi.advanceTimersByTimeAsync(20);
    const result = await resultPromise;
    expect(result.error).toBe(result.deliveryErrors[0]);
    expect(result.error).toMatchObject({ cause: firstError });
    expect(result.deliveryErrors).toHaveLength(2);
    expect(results(result.events)).toMatchObject([
      { executionState: "completed", content: [{ type: "text", text: "fast output" }] },
      { executionState: "unknown", failureKind: "timeout" },
    ]);
  });

  it("retains the whole batch before a consumer's first result delivery closes the generator", async () => {
    const storageError = new Error("tool result storage failure");
    const consumer = new AgentEventBus(() => { throw storageError; });
    let deliveryError: unknown;
    const result = await fixture({ onEvent: async event => {
      if (event.type !== "tool_use_end") return;
      try { await consumer.emit({ type: "tool.completed", data: { toolUseId: event.toolUseId, result: event.result } }, { agentId: "a", sessionId: "s" }); }
      catch (error) { deliveryError = error; throw error; }
    } });
    expect(result.error).toBe(deliveryError);
    expect(result.error).toMatchObject({ cause: storageError });
    expect(results(result.events)).toHaveLength(1);
    expect(result.history.filter(message => message.type === "tool_result")).toHaveLength(2);
  });

  it("does not block a successor after a successful no-op with an explicit not_started fact", async () => {
    const result = await fixture({ execute: async input => ({ content: [], executionState: input.value === "first" ? "not_started" : "completed" }) });
    expect(result.executed).toEqual(["first", "second"]);
  });

  it("emits actual per-call lifecycle with attempt identity", async () => {
    const result = await fixture({ permission: () => "ask" });
    const phases = result.lifecycle.filter(e => e.type === "domain.event" && e.data.name === "tool.lifecycle").map(e => e.data.payload);
    expect(phases).toContainEqual(expect.objectContaining({ toolUseId: "first", toolAttemptId: "tool_attempt_first_1", phase: "waiting_permission", executionState: "not_started" }));
    expect(phases).toContainEqual(expect.objectContaining({ toolUseId: "second", phase: "failed", executionState: "not_started" }));
    expect(phases.some(p => p?.phase === "running")).toBe(false);
  });

  it("adds generation identity, throttles counts and flushes the final count before committing calls", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const result = await fixture({ script: async function* () {
      for (const receivedChars of [0, 5, 12]) yield { type: "tool_generation_progress", toolKey: "0", toolUseId: "first", toolName: "Mutate", receivedChars } as StreamEvent;
      yield call("first");
    } });
    const progress = result.events.filter(e => e.type === "tool_generation_progress");
    expect(progress).toMatchObject([
      { generationId: expect.any(String), attempt: 1, receivedChars: 0 },
      { generationId: expect.any(String), attempt: 1, receivedChars: 12 },
    ]);
    expect(result.events.indexOf(progress.at(-1)!)).toBeLessThan(result.events.findIndex(e => e.type === "tool_use_start"));
  });

  it("strips external attempts to forge host progress", () => {
    expect(externalToolMetadata({ toolProgress: { phase: "completed" }, trace: "ok" })).toEqual({ trace: "ok" });
  });
});
