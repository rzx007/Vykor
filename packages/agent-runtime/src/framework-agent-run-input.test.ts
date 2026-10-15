import { expect, it } from "vitest";
import { FrameworkAgentRun } from "./framework-agent-run.js";
import { AgentEventBus } from "./event-source.js";
import { QueryEngine, ToolRegistry, type UsageSnapshot, type AgentEvent } from "@vykor/core";
import { AgentChildManager } from "./child-agent.js";
import { createRunCapabilityView } from "./run-capability-view.js";
import { agentTool } from "../../tools/src/agent/agent-tools.js";

it.each(["unknown_delta", "partial_delta", "complete_tool"] as const)("settles an invoked model when cancellation closes QueryEngine (%s)", async mode => {
  const hasUsage = mode !== "unknown_delta";
  const completeTool = mode === "complete_tool";
  const events: AgentEvent[] = [];
  const cancelled = new AbortController();
  const stop = new Error("stop run");
  let calls = 0;
  let providerClosed = false;
  const usage: UsageSnapshot = { inputTokens: 7, outputTokens: 2,
    metering: { knownInputTokens: 7, knownOutputTokens: 2, completeness: completeTool ? "complete" : "partial", inputIncludesCache: true, raw: {} },
  };
  const engine = new QueryEngine({ async *streamMessage() {
    calls++;
    try {
      if (hasUsage) yield { type: "usage" as const, usage };
      if (completeTool) {
        yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: "unexecuted", name: "Read", input: {} } };
        yield { type: "complete" as const, stopReason: "tool_use" };
        cancelled.abort(stop);
        return;
      }
      cancelled.abort(stop);
      yield { type: "text_delta" as const, delta: "after cancellation" };
      yield { type: "complete" as const, stopReason: "end_turn" };
    } finally { providerClosed = true; }
  } }, new ToolRegistry(), { checkTool: async () => ({ action: "allow" }) }, { register() {}, execute: async () => ({ blocked: false }) });
  const run = new FrameworkAgentRun({ agentId: "a", ids: { inputId: "i", runId: "r", traceId: "t" }, content: "q", delivery: "queue",
    externalSignal: cancelled.signal, eventBus: new AgentEventBus(event => { events.push(event); }),
    session: { id: "s", submitMessage: engine.submitMessage.bind(engine), getHistory: () => engine.getHistory() } as any,
    runtime: { queryEngine: engine } as any, effects: {} as any,
    children: { cwd: "/repo", createController: () => ({}) } as any, onSettled: () => {},
  });
  await expect(run.result).rejects.toBe(stop);
  expect(calls).toBe(1);
  expect(providerClosed).toBe(true);
  const settlements = events.filter(event => event.type === "model.attempt.finished");
  expect(settlements).toHaveLength(1);
  expect(settlements[0]).toMatchObject({ data: { status: completeTool ? "completed" : "interrupted", usageStatus: completeTool ? "complete" : hasUsage ? "partial" : "unknown" } });
  expect(events.filter(event => event.type === "model.attempt.started")).toHaveLength(1);
  expect(events.some(event => event.type === "run.interrupted")).toBe(true);
  expect(engine.getTotalUsage()).toMatchObject({ inputTokens: hasUsage ? 7 : 0, outputTokens: hasUsage ? 2 : 0 });
  if (!completeTool) expect(engine.getTotalUsage().usageIncomplete).toBe(true);
});

it.each([false, true])("keeps plugin delegation in the root run and lets it finish after child failure=%s", async (fail) => {
  const events: any[] = [];
  const bus = new AgentEventBus((event) => { events.push(event); });
  const view = createRunCapabilityView({ toolRegistry: new ToolRegistry(), pluginIds: new Set(["plugin"]), agents: [{ ownerPluginId: "plugin", definition: {
    name: "plugin:review", description: "Review", systemPrompt: "Only the child sees these instructions", tools: [],
  } }] }, "plugin");
  const runtime = { queryEngine: { getTotalUsage: () => ({ inputTokens: 0, outputTokens: 0 }) } } as any;
  let childPrompt: string | undefined;
  let childView: any;
  const children = new AgentChildManager({
    cwd: "/repo", settings: {} as any, configuration: {}, eventBus: bus,
    environment: { acquire: async () => ({ cwd: "/different", release: async () => {} }) },
    createAgent: async (options, identity) => {
      childPrompt = options.systemPrompt;
      if (fail) throw new Error("child startup failed");
      return {
        submitMessage: (content: string, submit: any) => new FrameworkAgentRun({
          agentId: "child-agent", identity, ids: submit.ids, content, delivery: "queue", eventBus: bus,
          capabilityView: submit.capabilityView, runtime, effects: {} as any,
          children: { cwd: options.cwd, createController: () => ({}) } as any,
          session: { id: options.sessionId, getHistory: () => [], submitMessage: async function* (_content: string, input: any) {
            childView = input.execution.capabilityView;
            yield { type: "text_delta", delta: "child findings" };
            yield { type: "complete", stopReason: "end_turn" };
          } } as any,
          onSettled: () => {},
        }),
        getHistory: () => [], close: async () => {},
      } as any;
    },
  });
  const run = new FrameworkAgentRun({
    agentId: "root", ids: { inputId: "root-input", runId: "root-run", traceId: "trace" },
    content: "Review this", inputItems: [{ type: "capability", kind: "plugin_agent", pluginId: "plugin", agentId: "plugin:review", displayName: "Review" }],
    delivery: "queue", eventBus: bus, capabilityView: view, runtime, effects: {} as any, children,
    session: { id: "root-session", getHistory: () => [], submitMessage: async function* (_content: string, input: any) {
      const result = await agentTool.execute({ description: "review", prompt: "inspect", subagentType: "plugin:review" }, { cwd: "/repo", agent: input.execution });
      if (result.isError) {
        yield { type: "text_delta", delta: `root handled: ${(result.content[0] as any).text}` };
      } else {
        const jobId = JSON.parse((result.content[0] as any).text).jobId;
        const child = await input.execution.children.awaitChildAgent(jobId);
        yield { type: "text_delta", delta: `root final: ${child.output}` };
      }
      yield { type: "complete", stopReason: "end_turn" };
    } } as any,
    onSettled: () => {},
  });
  try {
    expect((await run.result).output).toBe(fail ? "root handled: child startup failed" : "root final: child findings");
    expect(childPrompt).toBe("Only the child sees these instructions");
    if (!fail) {
      expect(childView.tools.size).toBe(0);
      expect(childView.pluginId).toBe("plugin");
    }
    expect(events.find((event) => event.type === "input.accepted" && event.context.sessionId === "root-session").data.inputItems[0].kind).toBe("plugin_agent");
    expect(events.filter((event) => event.type === "run.completed" && event.context.sessionId === "root-session")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.failed" && event.context.sessionId === "root-session")).toHaveLength(0);
  } finally { await children.closeAll(); }
});

it("preserves original structured items in root and steer acceptance events", async () => {
  const observed: unknown[] = [];
  const items = [{ type: "skill", name: "review", path: "/review/SKILL.md" }];
  const run = new FrameworkAgentRun({
    agentId: "a",
    ids: { inputId: "root", runId: "run", traceId: "trace" },
    content: "root instruction",
    inputItems: items,
    delivery: "queue",
    eventBus: new AgentEventBus((event) => {
      if (event.type === "input.accepted") observed.push(event.data);
    }),
    session: {
      id: "s",
      getHistory: () => [],
      submitMessage: async function* (_content: string, options: any) {
        await options.execution.takeSteeredInputs();
        yield { type: "complete", stopReason: "end_turn" };
      },
    } as any,
    runtime: {
      queryEngine: {
        getTotalUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
      },
    } as any,
    effects: {} as any,
    children: { cwd: "/repo", createController: () => ({}) } as any,
    onSettled: () => {},
  } as any);
  const receipt = run.steer({
    id: "steer",
    content: "steer instruction",
    inputItems: items,
  } as any);
  await run.result;
  await receipt;
  expect(observed).toEqual([
    { content: "root instruction", inputItems: items, delivery: "queue" },
    { content: "steer instruction", inputItems: items, delivery: "steer" },
  ]);
});

it("passes the trusted hardMaxTurns to the execution context of its own run only", async () => {
  const seen: Array<number | undefined> = [];
  let runIndex = 0;
  const makeRun = (hardMaxTurns?: number) => new FrameworkAgentRun({
    agentId: "a",
    ids: { inputId: `i-${runIndex}`, runId: `r-${runIndex++}`, traceId: "t" },
    content: "work",
    delivery: "queue",
    eventBus: new AgentEventBus(() => {}),
    session: {
      id: "s",
      getHistory: () => [],
      submitMessage: async function* (_content: string, options: any) {
        seen.push(options.execution.hardMaxTurns);
        yield { type: "complete", stopReason: "end_turn" };
      },
    } as any,
    runtime: { queryEngine: { getTotalUsage: () => ({ inputTokens: 0, outputTokens: 0 }) } } as any,
    effects: {} as any,
    children: { cwd: "/repo", createController: () => ({}) } as any,
    ...(hardMaxTurns !== undefined ? { hardMaxTurns } : {}),
    onSettled: () => {},
  });

  await makeRun(7).result;
  await makeRun().result;

  expect(seen).toEqual([7, undefined]);
});

it("scopes the goal tools and binding to each run without mutating the runtime registry", async () => {
  const toolRegistry = new ToolRegistry();
  const observed: unknown[] = [];
  const runtime = {
    toolRegistry,
    queryEngine: { getTotalUsage: () => ({ inputTokens: 0, outputTokens: 0 }) },
  };
  for (const binding of [{ goalId: "g1", objectiveVersion: 1 }, undefined, { goalId: "g2", objectiveVersion: 3 }]) {
    const goal = binding ? { ...binding,
      readSnapshot: async () => ({ ...binding, status: "active" as const, objective: "work",
        autoTurnsUsed: 0, maxAutoTurns: 0, knownTokens: 0, usageIncomplete: false }),
      submitUpdate: async () => ({ recorded: true as const }),
    } : undefined;
    const run = new FrameworkAgentRun({
      agentId: "a",
      goal,
      ids: {
        inputId: `i-${observed.length}`,
        runId: `r-${observed.length}`,
        traceId: "t",
      },
      content: "work",
      delivery: "queue",
      eventBus: new AgentEventBus(() => {}),
      session: {
        id: "s",
        getHistory: () => [],
        submitMessage: async function* (_: string, options: any) {
          observed.push({
            tools: options.execution.contribution?.tools?.map((item: any) => item.definition.name) ?? [],
            registryVisible: toolRegistry.has("GoalUpdate"),
          });
          yield { type: "complete", stopReason: "end_turn" };
        },
      } as any,
      runtime: runtime as any,
      effects: {} as any,
      children: { cwd: "/repo", createController: () => ({}) } as any,
      onSettled: () => {},
    });
    await run.result;
    expect(toolRegistry.has("GoalUpdate")).toBe(false);
  }
  expect(observed).toEqual([
    { tools: ["GoalUpdate", "GoalRead"], registryVisible: false },
    { tools: [], registryVisible: false },
    { tools: ["GoalUpdate", "GoalRead"], registryVisible: false },
  ]);
});

it("settles a stale snapshot callback as run failure before invoking the engine", async () => {
  const error = new Error("goal_run_stale");
  const events: AgentEvent[] = [];
  let calls = 0;
  const run = new FrameworkAgentRun({ agentId: "a", ids: { inputId: "i", runId: "r", traceId: "t" },
    content: "work", delivery: "queue", goal: { goalId: "g", objectiveVersion: 1,
      readSnapshot: async () => { throw error; }, submitUpdate: async () => ({ recorded: true }) },
    eventBus: new AgentEventBus(event => { events.push(event); }),
    session: { id: "s", getHistory: () => [], submitMessage: async function* () { calls++; } } as any,
    runtime: {} as any, effects: {} as any, children: { cwd: "/repo", createController: () => ({}) } as any,
    onSettled: () => {},
  });
  await expect(run.result).rejects.toBe(error);
  await expect(run.started).rejects.toBe(error);
  expect(events.map(event => event.type)).toEqual(["input.accepted", "run.failed"]);
  expect(calls).toBe(0);
});
