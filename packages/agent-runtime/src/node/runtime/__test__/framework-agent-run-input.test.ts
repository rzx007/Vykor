import { type AgentEvent } from "@vykor/agent-contracts";
import { expect, it } from "vitest";
import { FrameworkAgentRun } from "./framework-run.test-support.js";
import { AgentEventBus } from "../../../kernel/event-source.js";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { type UsageSnapshot } from "@vykor/agent-contracts";
import { NodeChildManager as AgentChildManager } from "../../children/node-child-manager.js";
import { createRunCapabilityView } from "../../plugins/run-capability-view.js";
import { createAgentTool } from "../../../../../tools/src/agent/agent-tools.js";

import { getBuiltinAgentDefinitions } from "@vykor/coordinator/definitions";
import { createTeamRegistry } from "@vykor/coordinator/teams";
const agentTool = createAgentTool({ definitions: getBuiltinAgentDefinitions(), teams: createTeamRegistry() });

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
        host: {
          plugins: { createRunCapabilityView: () => createRunCapabilityView({ toolRegistry: new ToolRegistry() }) },
          jobs: { send: async () => { throw new Error("Fixture child does not accept job input"); } },
        },
        submitMessage: (content: string, submit: any) => new FrameworkAgentRun({
          agentId: "child-agent", identity, ids: submit.ids, content, delivery: "queue", eventBus: bus,
          capabilityView: submit.capabilityView, runtime, effects: {} as any,
          children: { cwd: options.cwd, createController: () => ({}) } as any,
          session: { id: options.sessionId, getHistory: () => [], submitMessage: async function* (_content: string, input: any) {
            childView = input.execution.tools;
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
      const result = await createAgentTool({definitions:[...view.agents.values()].map(item=>item.definition),teams:createTeamRegistry()}).execute({ description: "review", prompt: "inspect", subagentType: "plugin:review" }, { cwd: "/repo", agent: input.execution });
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
      expect(childView.size).toBe(0);
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

it("scopes host-contributed tools to a Run without mutating the runtime registry",async()=>{
 const registry=new ToolRegistry();const seen:any[]=[];
 const definition={name:"HostOperation",description:"HostOperation",inputSchema:{},execute:async()=>({content:[]})};
 for(const contribution of [{tools:[{definition}]},undefined,{tools:[{definition}]}]){
  const run=new FrameworkAgentRun({agentId:"a",ids:{inputId:"i",runId:"r",traceId:"t"},content:"work",delivery:"queue",eventBus:new AgentEventBus(),contribution,session:{id:"s",getHistory:()=>[],submitMessage:async function*(_:any,options:any){seen.push(options.execution.contribution?.tools?.map((item:any)=>item.definition.name)??[]);yield {type:"complete",stopReason:"end_turn"};}},runtime:{queryEngine:{getTotalUsage:()=>({inputTokens:0,outputTokens:0})}},effects:{},children:{cwd:"/repo",createController:()=>({})},onSettled(){}});
  await run.result;expect(registry.has("HostOperation")).toBe(false);
 }
 expect(seen).toEqual([["HostOperation"],[],["HostOperation"]]);
});
it.each([false,true])("keeps prepared guidance model-only alongside contribution=%s",async withContribution=>{
 const events:AgentEvent[]=[];let seen:any;
 const run=new FrameworkAgentRun({agentId:"a",ids:{inputId:"i",runId:"r",traceId:"t"},content:"work",delivery:"queue",eventBus:new AgentEventBus(event=>{events.push(event);}),contribution:withContribution?{systemGuidance:"HOST OBJECTIVE"}:undefined,preparation:{async prepare(){return {run:{tools:new Map(),contribution:{systemGuidance:"PLUGIN DISCOVERY SOURCE DATA"}},release(){}};}},session:{id:"s",getHistory:()=>[],submitMessage:async function*(_:any,options:any){seen=options.execution.contribution;yield {type:"complete",stopReason:"end_turn"};}},runtime:{queryEngine:{getTotalUsage:()=>({inputTokens:0,outputTokens:0})}},effects:{},children:{cwd:"/repo",createController:()=>({})},onSettled(){}});
 await run.result;expect(seen.systemGuidance).toContain("PLUGIN DISCOVERY SOURCE DATA");if(withContribution)expect(seen.systemGuidance).toContain("HOST OBJECTIVE");expect(JSON.stringify(events)).not.toContain("PLUGIN DISCOVERY SOURCE DATA");
});
it("settles a stale preparation callback as Run failure before invoking the engine",async()=>{
 const error=new Error("stale preparation"),events:AgentEvent[]=[];let calls=0;
 const run=new FrameworkAgentRun({agentId:"a",ids:{inputId:"i",runId:"r",traceId:"t"},content:"work",delivery:"queue",eventBus:new AgentEventBus(event=>{events.push(event);}),preparation:{async prepare(){throw error;}},session:{id:"s",getHistory:()=>[],submitMessage:async function*(){calls++;}},runtime:{},effects:{},children:{cwd:"/repo",createController:()=>({})},onSettled(){}});
 await expect(run.result).rejects.toBe(error);await expect(run.started).rejects.toBe(error);expect(events.map(event=>event.type)).toEqual(["input.accepted","run.failed"]);expect(calls).toBe(0);
});

it("uses the prepared plugin scope for both model execution and child delegation", async () => {
  const preparedView = { tools: new Map(), skills: new Map(), agents: new Map(), mcpServers: new Map() };
  let delegatedView: unknown;
  let observed: any;
  let preparations = 0;
  const run = new FrameworkAgentRun({ agentId: "a", ids: { inputId: "i", runId: "r", traceId: "t" }, content: "work", delivery: "queue",
    pluginGuidance: "stale summary",
    prepareCapabilities: async signal => { signal.throwIfAborted(); preparations++; return { capabilityView: preparedView, pluginGuidance: "prepared summary" }; },
    eventBus: new AgentEventBus(() => {}),
    session: { id: "s", getHistory: () => [], submitMessage: async function* (_: string, options: any) {
      observed = options.execution;
      yield { type: "complete", stopReason: "end_turn" };
    } } as any,
    runtime: { queryEngine: { getTotalUsage: () => ({ inputTokens: 0, outputTokens: 0 }) } } as any,
    effects: {} as any, children: { cwd: "/repo", createController: (_: unknown, view: unknown) => { delegatedView = view; return {}; } } as any, onSettled: () => {},
  });
  await run.result;
  expect(preparations).toBe(1);
  expect([...observed.tools]).toEqual([...preparedView.tools]);
  expect([...(delegatedView as any)]).toEqual([...preparedView.tools]);
  expect(observed.contribution.systemGuidance).toBe("prepared summary");
});
