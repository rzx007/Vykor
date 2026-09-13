import { expect, it } from "vitest";
import { FrameworkAgentRun } from "./framework-agent-run.js";
import { AgentEventBus } from "./event-source.js";
import { ToolRegistry } from "@openharness/core";
import { AgentChildManager } from "./child-agent.js";
import { createRunCapabilityView } from "./run-capability-view.js";
import { agentTool } from "../../tools/src/agent/agent-tools.js";

it.each([false, true])("keeps plugin delegation in the root run and lets it finish after child failure=%s", async (fail) => {
  const events: any[] = [];
  const bus = new AgentEventBus((event) => { events.push(event); });
  const view = createRunCapabilityView({ toolRegistry: new ToolRegistry(), agents: [{ definition: {
    name: "plugin:review", description: "Review", systemPrompt: "Only the child sees these instructions", tools: [],
  } }] });
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
    if (!fail) expect(childView.tools.size).toBe(0);
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

it("scopes the assessment tool and binding to each run without mutating the runtime registry", async () => {
  const toolRegistry = new ToolRegistry();
  const observed: unknown[] = [];
  const runtime = {
    toolRegistry,
    queryEngine: { getTotalUsage: () => ({ inputTokens: 0, outputTokens: 0 }) },
  };
  for (const goal of [{ goalId: "g1", revision: 1 }, undefined, { goalId: "g2", revision: 3 }]) {
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
            registryVisible: toolRegistry.has("GoalAssessment"),
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
    expect(toolRegistry.has("GoalAssessment")).toBe(false);
  }
  expect(observed).toEqual([
    { tools: ["GoalAssessment"], registryVisible: false },
    { tools: [], registryVisible: false },
    { tools: ["GoalAssessment"], registryVisible: false },
  ]);
});
