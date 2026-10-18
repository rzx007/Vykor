import { describe, expect, it } from "vitest";
import { QueryEngine, ToolRegistry, type AgentExecutionContext, type IHookExecutor, type StreamMessageParams, type ToolDefinition } from "@vykor/core";
import { createVisibilityToolRegistry } from "./default-runtime-tools.js";
import { createRunCapabilityView } from "./run-capability-view.js";
import { createAgentTool } from "../../tools/src/agent/agent-tools.js";
import { deriveChildCapabilityView } from "./child-agent-options.js";

const tool = (name: string, text = name): ToolDefinition => ({
  name, description: text, inputSchema: { type: "object" },
  execute: async () => ({ content: [{ type: "text", text }] }),
});

function createExecutionContext(
  capabilityView: AgentExecutionContext["capabilityView"],
  children: Partial<AgentExecutionContext["children"]> = {},
): AgentExecutionContext {
  return {
    scope: {
      agentId: "agent-test", sessionId: "session-test", inputId: "input-test",
      runId: "run-test", traceId: "trace-test", cwd: "/repo",
      signal: new AbortController().signal,
    },
    capabilityView,
    effects: { requestPermission: async () => ({ status: "denied" }) },
    children: {
      hasChildAgent: () => false,
      spawnChildAgent: async () => { throw new Error("not implemented in this test"); },
      sendChildInput: async () => { throw new Error("not implemented in this test"); },
      interruptChildAgent: async () => {},
      awaitChildAgent: async () => { throw new Error("not implemented in this test"); },
      ...children,
    },
    emit: async () => {}, takeSteeredInputs: async () => [], closeSteering: () => {},
  };
}

describe("run capability execution boundary", () => {
  it("captures authorized plugin tools for delegation without exposing them to the Coordinator", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("Agent"));
    registry.register(tool("OfficeCLI", "captured office"), { kind: "plugin", id: "office" });
    registry.register(tool("Foreign"), { kind: "plugin", id: "foreign" });
    registry.register(tool("mcp__office__render"), { kind: "mcp", id: "office-server" });
    registry.register(tool("mcp__host__read"), { kind: "mcp", id: "host" });
    const sources = {
      toolRegistry: createVisibilityToolRegistry(registry, { kind: "only" as const, names: new Set(["Agent"]) }, new Set()),
      delegatableToolRegistry: registry,
      pluginIds: new Set(["office", "foreign"]),
      mcpServers: [
        { ownerPluginId: "office", serverId: "office:mcp", serverName: "office-server", definition: { type: "stdio" as const, command: "node" } },
        { serverId: "host:mcp", serverName: "host", definition: { type: "stdio" as const, command: "node" } },
      ],
    };
    const view = createRunCapabilityView(sources, ["office"]);
    expect([...view.tools.keys()]).toEqual(["Agent"]);
    expect([...view.delegatableTools!.keys()]).toEqual(["OfficeCLI", "mcp__office__render"]);
    expect(view.delegatableTools!.get("OfficeCLI")!.ownerPluginId).toBe("office");
    expect(view.delegatableTools!.get("mcp__office__render")!.serverId).toBe("office:mcp");
    expect([...createRunCapabilityView(sources, []).delegatableTools!.keys()]).toEqual([]);
    expect((view.delegatableTools as Map<string, unknown>).set).toBeUndefined();
    registry.override(tool("OfficeCLI", "replacement"), { kind: "plugin", id: "office" });
    expect(await view.delegatableTools!.get("OfficeCLI")!.invoke({}, { cwd: "." }))
      .toEqual({ content: [{ type: "text", text: "captured office" }] });
  });

  it("applies a child's tool and MCP limits to every further delegation", () => {
    const registry = new ToolRegistry();
    registry.register(tool("OfficeCLI"), { kind: "plugin", id: "office" });
    registry.register(tool("mcp__office__render"), { kind: "mcp", id: "office-server" });
    const sources = { toolRegistry: registry, delegatableToolRegistry: registry, pluginIds: new Set(["office"]),
      mcpServers: [{ ownerPluginId: "office", serverId: "office:mcp", serverName: "office-server", definition: { type: "stdio" as const, command: "node" } }] };
    const parent = createRunCapabilityView(sources, ["office"]);
    for (const limits of [
      { allowedTools: ["OfficeCLI"], disallowedTools: ["OfficeCLI"] },
      { allowedTools: ["mcp__office__render"], requiredMcpServers: [] },
    ]) {
      const child = deriveChildCapabilityView(parent, { description: "restricted worker", prompt: "work", agent: "worker", cwd: ".", ...limits })!;
      expect([...child.tools.keys()]).toEqual([]);
      expect([...child.delegatableTools!.keys()]).toEqual([]);
    }
  });

  it("distinguishes an automatic singleton scope from an explicit single-plugin restriction", () => {
    const registry = new ToolRegistry();
    registry.register(tool("Alpha"), { kind: "plugin", id: "alpha" });
    const sources = { toolRegistry: registry, pluginIds: new Set(["alpha"]) };
    const automatic = createRunCapabilityView(sources, ["alpha"]);
    const explicit = createRunCapabilityView(sources, "alpha");
    expect(automatic.pluginId).toBeUndefined();
    expect(explicit.pluginId).toBe("alpha");
    expect([...automatic.pluginIds!]).toEqual(["alpha"]);
    expect([...automatic.tools.keys()]).toEqual([...explicit.tools.keys()]);
    expect(automatic.tools.get("Alpha")!.ownerPluginId).toBe("alpha");
  });
  it("captures multiple exact plugin owners while excluding unavailable and foreign bindings", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("Read"));
    for (const owner of ["alpha", "beta", "foreign", "unavailable"]) registry.register(tool(owner), { kind: "plugin", id: owner });
    const sources = {
      toolRegistry: registry, pluginIds: new Set(["alpha", "beta", "foreign", "unavailable"]),
      pluginPreparationErrors: new Map([["unavailable", ["host stopped"]]]),
      skills: [skill("Common"), skill("AlphaSkill", "alpha"), skill("BetaSkill", "beta"), skill("ForeignSkill", "foreign")],
      agents: [{ ownerPluginId: "beta", definition: { name: "BetaAgent", description: "beta", source: "plugin" as const } }],
      mcpServers: [{ ownerPluginId: "beta", serverId: "beta:mcp", serverName: "beta-server", definition: { type: "stdio" as const, command: "node" } }],
    };
    const view = createRunCapabilityView(sources, ["alpha", "beta", "unavailable"]);
    expect(view.pluginId).toBeUndefined();
    expect([...view.pluginIds!]).toEqual(["alpha", "beta"]);
    expect((view.pluginIds as Set<string>).add).toBeUndefined();
    expect([...view.tools.keys()]).toEqual(["Read", "alpha", "beta"]);
    expect([...view.skills.keys()]).toEqual(["Common", "AlphaSkill", "BetaSkill"]);
    expect([...view.agents.keys()]).toEqual(["BetaAgent"]);
    expect([...view.mcpServers.keys()]).toEqual(["beta:mcp"]);
    expect([...createRunCapabilityView(sources, []).tools.keys()]).toEqual(["Read"]);
    expect(() => createRunCapabilityView(sources, "unavailable")).toThrow(/host stopped/);
    expect(() => createRunCapabilityView(sources, ["missing"])).toThrow(/not available/);
  });
  it("withdraws UI after Native definition replacement without rebinding an old component", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("Alpha", "original"), { kind: "plugin", id: "alpha" });
    const sources = { toolRegistry: registry, pluginIds: new Set(["alpha", "beta"]) };
    const original = createRunCapabilityView(sources, "alpha").tools.get("Alpha")!;
    const ui = { pluginId: "alpha", pluginVersion: "1", pluginDigest: "digest", componentId: "panel",
      componentDigest: "component", htmlSha256: "html", root: "/plugin", entryPath: "/plugin/ui.html",
      definition: { id: "panel", title: "Panel", entry: "./ui.html", surfaces: ["tool-result" as const],
        actions: [{ id: "go", label: "Go", tool: "Alpha", completion: "keep-open" as const }] }, actionTools: [original] };
    const captured = createRunCapabilityView({ ...sources, pluginUi: [ui] }, "alpha");
    expect(captured.pluginUi?.size).toBe(1);
    expect(createRunCapabilityView({ ...sources, pluginUi: [ui] }, ["alpha", "beta"]).pluginUi?.size).toBe(1);
    registry.override(tool("Alpha", "replacement"), { kind: "plugin", id: "alpha" });
    expect(createRunCapabilityView({ ...sources, pluginUi: [ui] }, "alpha").pluginUi?.size).toBe(0);
    ui.definition.title = "mutated";
    expect(captured.pluginUi?.get("alpha:panel")?.definition.title).toBe("Panel");
    expect(await captured.tools.get("Alpha")!.invoke({}, { cwd: "." })).toEqual({ content: [{ type: "text", text: "original" }] });
  });

  it.each([undefined, { kind: "builtin" as const }, { kind: "mcp" as const, id: "server" }, { kind: "plugin" as const, id: "other" }])(
    "does not admit a UI action with invalid provenance %j", source => {
      const registry = new ToolRegistry();
      registry.register(tool("Action"), source);
      const sources = { toolRegistry: registry, pluginIds: new Set(["alpha", "other"]),
        mcpServers: [{ serverId: "server", serverName: "server", definition: { type: "stdio" as const, command: "node" } }] };
      const candidate = createRunCapabilityView(sources, source?.kind === "plugin" ? "other" : "alpha").tools.get("Action")!;
      const ui = { pluginId: "alpha", pluginVersion: "1", pluginDigest: "digest", componentId: "panel",
        componentDigest: "component", htmlSha256: "html", root: "/plugin", entryPath: "/plugin/ui.html",
        definition: { id: "panel", title: "Panel", entry: "./ui.html", surfaces: ["tool-result" as const],
          actions: [{ id: "go", label: "Go", tool: "Action", completion: "keep-open" as const }] }, actionTools: [candidate] };
      expect(createRunCapabilityView({ ...sources, pluginUi: [ui] }, "alpha").pluginUi?.size).toBe(0);
      expect(createRunCapabilityView({ ...sources, pluginUi: [ui] }, ["alpha", "other"]).pluginUi?.size).toBe(0);
    });
  it.each([false, true])("enforces normalized Bash restrictions during View invocation: denied=%s", async (denied) => {
    let invocations = 0;
    const registry = new ToolRegistry();
    registry.register({ ...tool("Shell"), execute: async () => { invocations++; return { content: [] }; } });
    const view = deriveChildCapabilityView(createRunCapabilityView({ toolRegistry: registry }), {
      description: "d", prompt: "p", agent: "worker", cwd: "/repo",
      allowedTools: denied ? ["*"] : ["Bash"], disallowedTools: denied ? ["Bash"] : undefined,
    })!;
    const results = await executeCapturedTool(registry, view, "Shell", {});
    expect(invocations).toBe(denied ? 0 : 1);
    expect(Boolean(results[0]?.isError)).toBe(denied);
  });
  it("rejects an ambiguous server name before creating any Run binding", () => {
    const definition = { type: "stdio" as const, command: "node" };
    expect(() => createRunCapabilityView({ toolRegistry: new ToolRegistry(), mcpServers: [
      { serverId: "plugin:first:mcp:shared", serverName: "shared", ownerPluginId: "first", definition },
      { serverId: "plugin:second:mcp:shared", serverName: "shared", ownerPluginId: "second", definition },
    ] })).toThrow(/ambiguous.*shared/i);
  });
  it("invokes with the original Tool receiver after metadata copying", async () => {
    const registry = new ToolRegistry();
    const values = new WeakMap<object, string>();
    const original: ToolDefinition = {
      ...tool("Identity"),
      async execute() { return { content: [{ type: "text", text: values.get(this) ?? "lost receiver" }] }; },
    };
    values.set(original, "original receiver");
    registry.register(original);
    const view = createRunCapabilityView({ toolRegistry: registry });
    original.execute = tool("replacement").execute;
    const events = await executeCapturedTool(registry, view, "Identity", {});
    expect(events[0]?.content).toEqual([{ type: "text", text: "original receiver" }]);
  });

  it("keeps the real Agent Tool on its runtime definitions instead of the global fallback", async () => {
    const registry = new ToolRegistry();
    registry.register(createAgentTool({ agentDefinitions: [{
      name: "runtime-reviewer", description: "review", model: "runtime-model", systemPrompt: "captured role",
    }] }));
    const spawned: unknown[] = [];
    const view = createRunCapabilityView({ toolRegistry: registry, agents: [{ definition: {
      name: "runtime-reviewer", description: "review", model: "runtime-model", systemPrompt: "captured role",
    } }] });
    const events = await executeCapturedTool(registry, view, "Agent",
      { description: "review", prompt: "review", subagentType: "runtime-reviewer" }, {
        spawnChildAgent: async (input: unknown) => {
          spawned.push(input);
          return { id: "child", sessionId: "child-session", result: Promise.resolve({ status: "completed", output: "ok" }) };
        },
      });
    expect(events[0]?.isError).not.toBe(true);
    expect(spawned).toEqual([expect.objectContaining({ model: "runtime-model", systemPrompt: "captured role" })]);
  });
  it("includes loaded baseline agents in the default runtime view", async () => {
    const { createDefaultNodeAgent } = await import("./default-agent.js");
    const agent = await createDefaultNodeAgent({
      cwd: process.cwd(),
      pluginsEnabled: false,
      systemPrompt: "test",
      client: { streamMessage: async function* () { yield { type: "complete" as const, stopReason: "end_turn" }; } },
      settings: { apiFormat: "anthropic", model: "test", maxTurns: 2, permission: { mode: "default" }, sandbox: { enabled: false } },
      capabilityOverrides: { terminal: false, memory: false },
    });
    try {
      const view = agent.createRunCapabilityView();
      expect(view.agents.has("Explore")).toBe(true);
      expect(view.agents.get("Explore")?.ownerPluginId).toBeUndefined();
    } finally { await agent.close(); }
  });
  it("selects the filtered baseline plus one owner without leaking into later or concurrent views", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("Read"));
    registry.register(tool("Denied"));
    registry.register(tool("OutsideCeiling"));
    registry.register({ ...tool("LocalOnly"), execution: { domain: "environment", supportedEnvironments: ["wsl"] } });
    registry.register(tool("Alpha"), { kind: "plugin", id: "alpha" });
    registry.register(tool("Beta"), { kind: "plugin", id: "beta" });
    const inputs = {
      pluginIds: new Set(["alpha", "beta"]),
      toolRegistry: createVisibilityToolRegistry(registry,
        { kind: "only", names: new Set(["Read", "Denied", "Alpha", "Beta", "LocalOnly"]) }, new Set(["Denied"])),
      skills: [skill("Common"), skill("AlphaSkill", "alpha"), skill("BetaSkill", "beta")],
      agents: [{ definition: { name: "General", description: "general" } },
        { ownerPluginId: "alpha", definition: { name: "AlphaAgent", description: "alpha" } }],
    };
    inputs.skills.push({ ...skill("UnownedPluginSkill"), definition: { ...skill("UnownedPluginSkill").definition, source: "plugin" } } as any);
    inputs.agents.push({ definition: { name: "UnownedPluginAgent", description: "unowned", source: "plugin" } } as any);
    const ordinary = createRunCapabilityView(inputs);
    const [alpha, beta] = await Promise.all([
      Promise.resolve(createRunCapabilityView(inputs, "alpha")),
      Promise.resolve(createRunCapabilityView(inputs, "beta")),
    ]);
    const later = createRunCapabilityView(inputs);
    expect([...ordinary.tools.keys()]).toEqual(["Read"]);
    expect([...alpha.tools.keys()]).toEqual(["Read", "Alpha"]);
    expect([...beta.tools.keys()]).toEqual(["Read", "Beta"]);
    expect([...later.tools.keys()]).toEqual(["Read"]);
    expect([...alpha.skills.keys()]).toEqual(["Common", "AlphaSkill"]);
    expect([...later.skills.keys()]).toEqual(["Common"]);
    expect([...alpha.agents.keys()]).toEqual(["General", "AlphaAgent"]);
    expect([...later.agents.keys()]).toEqual(["General"]);
    expect(alpha.tools.get("Read")?.ownerPluginId).toBeUndefined();
    expect(alpha.tools.get("Alpha")?.ownerPluginId).toBe("alpha");
    expect(registry.has("Alpha")).toBe(true);
    expect(() => createRunCapabilityView(inputs, "missing")).toThrow(/plugin/i);
  });

  it("freezes copied definitions and map mutations, retaining old loaded content until a new view", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("Alpha", "old"), { kind: "plugin", id: "alpha" });
    const loadedSkill = skill("AlphaSkill", "alpha");
    const agent = { ownerPluginId: "alpha", definition: { name: "AlphaAgent", description: "old", tools: ["Read"] } };
    const inputs = { pluginIds: new Set(["alpha"]), toolRegistry: registry, skills: [loadedSkill], agents: [agent] };
    const active = createRunCapabilityView(inputs, "alpha");
    registry.override(tool("Alpha", "new"), { kind: "plugin", id: "alpha" });
    loadedSkill.definition.content = "changed file contents";
    agent.definition.tools.push("Write");
    expect(await active.tools.get("Alpha")!.invoke({}, { cwd: "." })).toEqual({ content: [{ type: "text", text: "old" }] });
    expect(active.skills.get("AlphaSkill")!.definition.content).toBe("loaded contents");
    expect(active.agents.get("AlphaAgent")!.definition.tools).toEqual(["Read"]);
    expect((active.tools as Map<string, unknown>).set).toBeUndefined();
    expect(() => { active.tools.get("Alpha")!.definition.description = "tampered"; }).toThrow();
    active.tools.forEach((_value, _key, map) => expect((map as Map<string, unknown>).clear).toBeUndefined());
    const next = createRunCapabilityView(inputs, "alpha");
    expect(await next.tools.get("Alpha")!.invoke({}, { cwd: "." })).toEqual({ content: [{ type: "text", text: "new" }] });
    expect(next.skills.get("AlphaSkill")!.definition.content).toBe("changed file contents");
  });

  it("lists and invokes only captured bindings even after the registry is replaced", async () => {
    const registry = new ToolRegistry();
    const original = tool("Selected", "captured target");
    registry.register(tool("Selected", "replacement target"));
    registry.register(tool("OtherPlugin"), { kind: "plugin", id: "other" });
    const names: string[][] = [];
    const execution = createExecutionContext({
      pluginId: "selected",
      tools: new Map([["Selected", { definition: original, invoke: original.execute, ownerPluginId: "selected" }]]),
      skills: new Map(), mcpServers: new Map(), agents: new Map(),
    });
    let turn = 0;
    const engine = new QueryEngine({
      streamMessage: async function* (input: StreamMessageParams) {
        names.push(input.tools?.map((item) => item.name) ?? []);
        if (turn++ === 0) {
          yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: "call", name: "Selected", input: {} } };
          yield { type: "complete" as const, stopReason: "tool_use" };
        } else yield { type: "complete" as const, stopReason: "end_turn" };
      },
    }, registry, { checkTool: async () => ({ action: "allow" }) },
    { execute: async () => ({ blocked: false }) } as IHookExecutor);
    const results = [];
    for await (const event of engine.submitMessage("go", { execution })) {
      if (event.type === "tool_use_end") results.push(event.result.content);
    }
    expect(names).toEqual([["Selected"], ["Selected"]]);
    expect(results).toEqual([[{ type: "text", text: "captured target" }]]);
  });
});

function skill(name: string, ownerPluginId?: string) {
  return { ownerPluginId, path: `/skills/${name}/SKILL.md`, definition: {
    name, description: name, path: `/skills/${name}/SKILL.md`, content: "loaded contents",
    userInvocable: true, disableModelInvocation: false,
  } };
}

async function executeCapturedTool(registry: ToolRegistry, capabilityView: ReturnType<typeof createRunCapabilityView>, name: string, input: Record<string, unknown>, children?: Partial<AgentExecutionContext["children"]>) {
  let turn = 0;
  const engine = new QueryEngine({ streamMessage: async function* () {
    if (turn++ === 0) {
      yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: "call", name, input } };
      yield { type: "complete" as const, stopReason: "tool_use" };
    } else yield { type: "complete" as const, stopReason: "end_turn" };
  } }, registry, { checkTool: async () => ({ action: "allow" }) }, { execute: async () => ({ blocked: false }) } as IHookExecutor);
  const execution = createExecutionContext(capabilityView, children);
  const results = [];
  for await (const event of engine.submitMessage("go", { execution })) if (event.type === "tool_use_end") results.push(event.result);
  return results;
}
