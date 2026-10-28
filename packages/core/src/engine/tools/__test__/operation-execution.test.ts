import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentExecutionContext,
  AgentToolSafety,
  RequiredPolicyGate,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolOperationIntent,
  ToolOperationTicket,
  ToolUseBlock,
} from "@vykor/agent-contracts";
import { executeCheckedTools } from "../checked-tool-execution.js";
import { ToolRegistry } from "../tool-registry.js";
import { QueryEngine } from "../../query-engine.js";

afterEach(() => vi.useRealTimers());
const call = (id = "one"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "Write",
  input: { text: "hello" },
});
function fixture(
  options: {
    policy?: RequiredPolicyGate["check"];
    invoke?: ToolDefinition["execute"];
    serial?: boolean;
    hooks?: boolean;
  } = {},
) {
  let effects = 0;
  const controller = new AbortController();
  const saved: { result: ToolExecutionResult; late?: boolean }[] = [];
  const intents: ToolOperationIntent[] = [];
  const phases: string[] = [];
  const contexts: ToolContext[] = [];
  const tickets = new Map<string, ToolOperationTicket>();
  const definition: ToolDefinition = {
    name: "Write",
    description: "Write fixture",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    ...(options.serial ? { serialGroup: "write" } : {}),
    execute: async (input, context) => {
      effects++;
      contexts.push(context);
      return (
        options.invoke?.(input, context) ?? {
          content: [{ type: "text", text: String(input.text) }],
        }
      );
    },
  };
  const registry = new ToolRegistry();
  registry.register(definition);
  const safety: AgentToolSafety = {
    policyTimeoutMs: 10,
    requiredPolicy: {
      check: async (input) => {
        phases.push(input.phase);
        return (
          options.policy?.(input) ?? { allowed: true, policyVersion: "v1" }
        );
      },
    },
    operations: {
      prepare: async (intent) => {
        intents.push(intent);
        const ticket = tickets.get(intent.toolUse.id) ?? {
          operationId: `op-${intent.toolUse.id}`,
          revision: 1,
          intentRevision: 1,
          intentDigest: "digest",
          kind: "non_replayable" as const,
          state: "prepared" as const,
        };
        tickets.set(intent.toolUse.id, ticket);
        return ticket;
      },
      authorize: async ({ operation }) => ({
        ...operation,
        state: "authorized",
        revision: operation.revision + 1,
      }),
      dispatch: async ({ operation }) => ({
        operationId: operation.operationId,
        toolAttemptId: `real-attempt-${operation.operationId}`,
        revision: 3,
        ownerId: "owner",
      }),
      settle: async ({ result, late }) => {
        saved.push({ result: structuredClone(result), late });
      },
      reject: async ({ result }) => {
        saved.push({ result: structuredClone(result) });
      },
    },
  };
  const events: unknown[] = [];
  const execution: AgentExecutionContext = {
    toolSafety: safety,
    profile: { executableHooks: options.hooks ?? false },
    scope: {
      agentId: "a",
      sessionId: "s",
      runId: "r",
      inputId: "i",
      cwd: "/",
      traceId: "t",
      signal: controller.signal,
    },
    effects: { requestPermission: async () => ({ status: "approved" }) },
    children: {} as AgentExecutionContext["children"],
    emit: async (event) => {
      events.push(event);
    },
    takeSteeredInputs: async () => [],
    closeSteering() {},
  };
  const run = (toolUses: ToolUseBlock[] = [call()], extra = {}) =>
    executeCheckedTools({
      toolUses,
      toolRegistry: registry,
      execution,
      permissionChecker: { checkTool: async () => ({ action: "allow" }) },
      hookExecutor: {
        register() {},
        execute: async () => ({ blocked: false }),
      },
      signal: controller.signal,
      timeoutMs: 10,
      internalTools: new Set(["Write"]),
      createToolContext: () => ({ cwd: "/", agent: execution }),
      isTrustedSummary: () => false,
      ...extra,
    });
  return {
    run,
    safety,
    execution,
    controller,
    saved,
    intents,
    phases,
    contexts,
    tickets,
    events,
    registry,
    definition,
    get effects() {
      return effects;
    },
  };
}

describe("durable checked tool operations", () => {
  it("keeps host invocation tracking failure fatal even after dispatch was recorded", async () => {
    const failure = new Error("invocation tracking unavailable");
    const f = fixture();
    f.execution.observeInvocation = () => { throw failure; };
    const outcome = await f.run();
    expect(outcome.fatalFailure?.error).toBe(failure);
    expect(f.effects).toBe(0);
  });

  it.each(["prepare", "receipt", "lifecycle"] as const)("propagates nested %s failure even when the proxy catches it", async phase => {
    const failure = new Error(`nested ${phase} failed`);
    let followUp: Awaited<ReturnType<ToolDefinition["execute"]>> | undefined;
    const f = fixture({ invoke: async (input, context) => {
      if (input.text === "hello") {
        try { return await context.invokeTool!("Write", { text: "child" }); }
        catch {
          followUp = await context.invokeTool!("Write", { text: "must not start" });
          return { content: [{ type: "text", text: "proxy caught error" }] };
        }
      }
      return { content: [{ type: "text", text: "child wrote" }] };
    } });
    const settle = f.safety.operations.settle;
    f.safety.operations.settle = async input => {
      if (phase === "receipt" && input.receipt.operationId !== "op-one") throw failure;
      await settle(input);
    };
    const prepare = f.safety.operations.prepare;
    f.safety.operations.prepare = async intent => {
      if (phase === "prepare" && intent.parentOperationId) throw failure;
      return prepare(intent);
    };
    const emit = f.execution.emit;
    f.execution.emit = async event => {
      if (phase === "lifecycle" && event.type === "domain.event" && event.data.name === "tool.lifecycle"
        && event.data.payload?.parentOperationId) throw failure;
      await emit(event);
    };
    const execution = { ...f.execution, tools: new Map([["Write", {
      definition: f.definition, invoke: f.definition.execute, source: { kind: "builtin" as const },
    }]]) };
    const engine = new QueryEngine({ async *streamMessage() { throw new Error("unexpected model call"); } }, f.registry,
      { checkTool: async () => ({ action: "allow" }) }, { register() {}, execute: async () => ({ blocked: false }) });
    await expect(engine.executeTool(call(), { execution })).rejects.toBe(failure);
    expect(followUp).toMatchObject({ isError: true, executionState: "not_started" });
    expect(f.effects).toBe(phase === "receipt" ? 2 : 1);
    expect(f.saved.find(entry => entry.result.toolUseId === "one")?.result.content)
      .toEqual([{ type: "text", text: "proxy caught error" }]);
  });

  it("rejects trusted validation before dispatch rights and preserves a definite no-start result", async () => {
    const f = fixture();
    const execution = { ...f.execution, contribution: { tools: [{ definition: f.definition, permission: "host-internal" as const, beforeDispatch: async () => "Evidence is missing" }] } };
    const outcome = await f.run([call()], { execution });
    expect(f.effects).toBe(0);
    expect(outcome.results[0]).toMatchObject({ isError: true, executionState: "not_started", failureKind: "invalid_input" });
    expect(outcome.results[0]?.toolAttemptId).toBeUndefined();
    expect(f.saved[0]?.result.executionState).toBe("not_started");
  });
  it("does not finalize beside sibling effects when the trusted contribution requires its own batch", async () => {
    const f = fixture();
    const execution = { ...f.execution, contribution: { tools: [{ definition: f.definition, permission: "host-internal" as const, requiresSoloBatch: true as const }] } };
    const outcome = await f.run([call("a"), call("b")], { execution });
    expect(f.effects).toBe(0);
    expect(outcome.results.every(result => result.executionState === "not_started")).toBe(true);
    expect(f.intents).toHaveLength(0);
  });
  it.each(["deny", "throw", "timeout", "missing-policy", "missing-operations"])(
    "prevents all effects for required policy %s, including internal tools with hooks disabled",
    async (mode) => {
      vi.useFakeTimers();
      const f = fixture({
        policy: async () => {
          if (mode === "throw") throw new Error("policy unavailable");
          if (mode === "timeout") return new Promise(() => {});
          return { allowed: mode !== "deny", policyVersion: "v1" };
        },
      });
      if (mode === "missing-policy")
        (f.safety as unknown as Record<string, unknown>).requiredPolicy =
          undefined;
      if (mode === "missing-operations")
        (f.safety as unknown as Record<string, unknown>).operations = undefined;
      const pending = f.run();
      await vi.advanceTimersByTimeAsync(11);
      const outcome = await pending;
      expect(f.effects).toBe(0);
      expect(outcome.results[0]).toMatchObject({
        isError: true,
        executionState: "not_started",
      });
      if (mode !== "missing-policy" && mode !== "missing-operations") {
        expect(f.saved[0]?.result.isError).toBe(true);
        expect(f.saved[0]?.result.toolAttemptId).toBeUndefined();
      }
    },
  );
  it.each(["prepare", "dispatch"] as const)(
    "does not invoke after %s persistence fails",
    async (phase) => {
      const f = fixture();
      f.safety.operations[phase] = async () => {
        throw new Error("disk unavailable");
      };
      const outcome = await f.run();
      expect(f.effects).toBe(0);
      expect(outcome.fatalFailure).toBeDefined();
    },
  );
  it("uses normalized immutable input, performs both required checks and persists before completed events", async () => {
    const f = fixture();
    const emit = f.execution.emit;
    f.execution.emit = async event => {
      if (event.type === "domain.event" && event.data.payload?.phase === "completed") {
        expect(f.saved).toHaveLength(1);
        expect(f.saved[0]?.result.executionState).toBe("completed");
      }
      await emit(event);
    };
    const input = call();
    input.input = { arguments: { text: "normalized" } };
    const outcome = await f.run([input]);
    expect(f.phases).toEqual(["authorization", "dispatch"]);
    expect(f.intents[0]?.toolUse.input).toEqual({ text: "normalized" });
    expect(Object.isFrozen(f.intents[0]?.toolUse.input)).toBe(true);
    expect(f.contexts[0]).toMatchObject({
      operationId: "op-one",
      toolAttemptId: "real-attempt-op-one",
    });
    expect(outcome.results[0]).toMatchObject({
      operationId: "op-one",
      toolAttemptId: "real-attempt-op-one",
      executionState: "completed",
    });
    expect(f.saved[0]?.result).toEqual(outcome.results[0]);
  });
  it("reuses a confirmed complete result without invoking or checking permission", async () => {
    const f = fixture();
    const result: ToolExecutionResult = {
      toolUseId: "one",
      toolName: "Write",
      operationId: "op-one",
      toolAttemptId: "saved-attempt",
      content: [{ type: "text", text: "already saved" }],
      executionState: "completed",
      metadata: { appData: { v: 3 } },
    };
    f.tickets.set("one", {
      operationId: "op-one",
      revision: 4,
      intentRevision: 1,
      intentDigest: "digest",
      kind: "non_replayable",
      state: "confirmed",
      result,
    });
    expect((await f.run()).results[0]).toEqual(result);
    expect(f.effects).toBe(0);
    expect(f.phases).toEqual([]);
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "domain.event",
        data: expect.objectContaining({
          name: "tool.lifecycle",
          payload: expect.objectContaining({
            operationId: "op-one",
            toolAttemptId: "saved-attempt",
          }),
        }),
      }),
    );
  });
  it("never redispatches unknown, blocks its serial successors and leaves independent calls available", async () => {
    const f = fixture({ serial: true });
    f.registry.register({ name: "Inspect", description: "independent diagnostic", inputSchema: {},
      execute: async () => ({ content: [{ type: "text", text: "independent observation" }] }),
    });
    f.tickets.set("one", {
      operationId: "op-one",
      revision: 4,
      intentRevision: 1,
      intentDigest: "digest",
      kind: "non_replayable",
      state: "unknown",
    });
    const outcome = await f.run([call(), call("two"), { type: "tool_use", id: "inspect", name: "Inspect", input: {} }]);
    expect(f.effects).toBe(0);
    expect(outcome.fatalFailure).toBeUndefined();
    expect(outcome.results[0]).toMatchObject({ isError: true, failureKind: "policy", executionState: "unknown" });
    expect(outcome.results[1]).toMatchObject({ isError: true, executionState: "not_started" });
    expect(outcome.results[2]).toMatchObject({ executionState: "completed", content: [{ type: "text", text: "independent observation" }] });
  });
  it("stops later calls and future dangerous batches when a receipt cannot be saved", async () => {
    const f = fixture({ serial: true });
    f.safety.operations.settle = async () => {
      throw new Error("receipt save failed");
    };
    const first = await f.run([call(), call("two")]);
    expect(f.effects).toBe(1);
    expect(first.fatalFailure).toBeDefined();
    expect(first.results[0]?.isError).toBe(true);
    await f.run([call("three")]);
    expect(f.effects).toBe(1);
  });
  it("settles each already running concurrent outcome even after one settlement fails", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({
      invoke: async () => {
        await waiting;
        return { content: [{ type: "text", text: "actual" }] };
      },
    });
    const settled: string[] = [];
    f.safety.operations.settle = async ({ result }) => {
      settled.push(result.toolUseId);
      if (result.toolUseId === "one") throw new Error("disk failed");
    };
    const pending = f.run([call(), call("two")]);
    await vi.waitFor(() => expect(f.effects).toBe(2));
    release();
    expect((await pending).fatalFailure).toBeDefined();
    expect(settled.sort()).toEqual(["one", "two"]);
  });
  it("saves a late actual result after timeout without delivering it again", async () => {
    vi.useFakeTimers();
    let release!: (
      result: Awaited<ReturnType<ToolDefinition["execute"]>>,
    ) => void;
    const f = fixture({
      invoke: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const pending = f.run();
    await vi.advanceTimersByTimeAsync(11);
    const outcome = await pending;
    expect(outcome.results[0]).toMatchObject({ executionState: "unknown" });
    expect(f.saved[0]?.result.executionState).toBe("unknown");
    release({ content: [{ type: "text", text: "late actual" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.saved[1]).toMatchObject({
      late: true,
      result: {
        executionState: "completed",
        content: [{ type: "text", text: "late actual" }],
      },
    });
    expect(outcome.results[0]?.executionState).toBe("unknown");
  });
});

it("rechecks mandatory policy after approval and refuses a revoked dispatch", async () => {
  const f = fixture({
    policy: async ({ phase }) => ({
      allowed: phase === "authorization",
      policyVersion: "v2",
    }),
  });
  let approvals = 0;
  f.execution.effects.requestPermission = async () => {
    approvals++;
    return { status: "approved" };
  };
  const outcome = await f.run([call()], {
    internalTools: new Set(),
    permissionChecker: { checkTool: async () => ({ action: "ask" as const }) },
  });
  expect(approvals).toBe(1);
  expect(f.effects).toBe(0);
  expect(outcome.results[0]).toMatchObject({
    isError: true,
    executionState: "not_started",
    failureKind: "policy",
  });
});
it("checks authorization before requesting existing user approval", async () => {
  const f = fixture({
    policy: async () => ({ allowed: false, policyVersion: "v1" }),
  });
  let approvals = 0;
  f.execution.effects.requestPermission = async () => {
    approvals++;
    return { status: "approved" };
  };
  await f.run([call()], {
    internalTools: new Set(),
    permissionChecker: { checkTool: async () => ({ action: "ask" as const }) },
  });
  expect(approvals).toBe(0);
  expect(f.effects).toBe(0);
});
it("cancels waiting mandatory policy without waiting for its timeout or invoking the tool", async () => {
  const f = fixture({
    policy: async () => {
      f.controller.abort(new Error("cancel"));
      return new Promise(() => {});
    },
  });
  const outcome = await f.run();
  expect(f.effects).toBe(0);
  expect(outcome.results[0]).toMatchObject({
    executionState: "not_started",
    failureKind: "interrupted",
  });
});
it("uses a finite default even when policy timeout is configured as infinity", async () => {
  vi.useFakeTimers();
  const f = fixture({ policy: async () => new Promise(() => {}) });
  f.safety.policyTimeoutMs = Infinity;
  const pending = f.run();
  await vi.advanceTimersByTimeAsync(5_001);
  const outcome = await pending;
  expect(f.effects).toBe(0);
  expect(outcome.results[0]).toMatchObject({
    failureKind: "policy",
    executionState: "not_started",
  });
});
it("keeps hook mutation from changing the exact input approved and dispatched", async () => {
  const f = fixture({ hooks: true });
  await f.run([call()], {
    hookExecutor: {
      register() {},
      execute: async (_phase: string, payload: Record<string, unknown>) => {
        (payload.input as Record<string, unknown>).text =
          "changed after approval";
        return { blocked: false };
      },
    },
  });
  expect(f.effects).toBe(1);
  expect(f.saved[0]?.result.content).toEqual([{ type: "text", text: "hello" }]);
});
it("records a tool's claimed not_started after invocation as unknown", async () => {
  const f = fixture({
    invoke: async () => ({
      content: [{ type: "text", text: "already had effects" }],
      isError: true,
      executionState: "not_started",
    }),
  });
  const outcome = await f.run();
  expect(f.effects).toBe(1);
  expect(f.saved[0]?.result.executionState).toBe("unknown");
  expect(outcome.fatalFailure).toBeUndefined();
});
it("reports late receipt persistence failure through host diagnostic without another model result", async () => {
  vi.useFakeTimers();
  let release!: (value: Awaited<ReturnType<ToolDefinition["execute"]>>) => void;
  const f = fixture({
    invoke: async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const settle = f.safety.operations.settle;
  f.safety.operations.settle = async (input) => {
    if (input.late) throw new Error("late save failed");
    await settle(input);
  };
  const pending = f.run();
  await vi.advanceTimersByTimeAsync(11);
  const result = await pending;
  release({ content: [{ type: "text", text: "late actual" }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.events).toContainEqual(
    expect.objectContaining({
      type: "domain.event",
      data: expect.objectContaining({ name: "tool.operation.audit_failed" }),
    }),
  );
  expect(f.saved).toHaveLength(1);
  expect(result.results[0]?.executionState).toBe("unknown");
});

it.each([true, false])(
  "gives actual nested invocation its own operation and mandatory check (allow=%s)",
  async (allow) => {
    let externalEffects = 0;
    const f = fixture({
      policy: async ({ intent }) => ({
        allowed: intent.toolUse.input.text !== "child" || allow,
        policyVersion: "v1",
      }),
      invoke: async (input, context) => {
        if (input.text === "hello")
          return context.invokeTool!("Write", { text: "child" });
        externalEffects++;
        return { content: [{ type: "text", text: "child saved" }] };
      },
    });
    const execution = {
      ...f.execution,
      tools: new Map([
        [
          "Write",
          {
            definition: f.definition,
            invoke: f.definition.execute,
            source: { kind: "builtin" as const },
          },
        ],
      ]),
    };
    const engine = new QueryEngine(
      {
        async *streamMessage() {
          throw new Error("model must not be called");
        },
      },
      f.registry,
      { checkTool: async () => ({ action: "allow" }) },
      { register() {}, execute: async () => ({ blocked: false }) },
    );
    const pending = engine.executeTool(call(), { execution });
    if (allow) await expect(pending).resolves.toMatchObject({ executionState: "completed" });
    else await expect(pending).resolves.toMatchObject({ isError: true, failureKind: "policy", executionState: "unknown" });
    expect(externalEffects).toBe(allow ? 1 : 0);
    expect(f.intents).toHaveLength(2);
    expect(f.intents[1]?.parentOperationId).toBe("op-one");
    expect(f.intents[1]?.toolUse.id).not.toBe("one");
    if (allow) {
      expect(f.contexts[1]?.operationId).not.toBe(f.contexts[0]?.operationId);
      expect(f.contexts[1]?.parentOperationId).toBe("op-one");
      expect(
        new Set(f.saved.map((saved) => saved.result.toolAttemptId)).size,
      ).toBe(2);
    }
  },
);

it.each(["non_replayable", "idempotent_write", "read_only"] as const)(
  "does not infer a safe write outcome from tool-reported completed errors: %s",
  async (kind) => {
    const f = fixture({
      invoke: async () => ({
        content: [
          { type: "text", text: "failed after possible partial change" },
        ],
        isError: true,
        executionState: "completed",
      }),
    });
    f.tickets.set("one", {
      operationId: "op-one",
      revision: 1,
      intentRevision: 1,
      intentDigest: "digest",
      kind,
      state: "prepared",
    });
    const outcome = await f.run();
    expect(f.saved[0]?.result.executionState).toBe(
      kind === "read_only" ? "completed" : "unknown",
    );
    expect(outcome.fatalFailure).toBeUndefined();
  },
);
