import { describe, expect, it } from "vitest";

import { deriveChildAgentOptions, deriveChildCapabilityView } from "./child-agent-options.js";
import { ToolRegistry } from "@openharness/core";
import { createRunCapabilityView } from "./run-capability-view.js";

const addedTool = {
  name: "BusinessSearch",
  description: "Search business data",
  inputSchema: {},
  async execute() { return { content: [] }; },
};
const overriddenTool = {
  name: "Read",
  description: "Read an attachment resource",
  inputSchema: {},
  async execute() { return { content: [] }; },
};

describe("deriveChildAgentOptions", () => {
  it("intersects tools and MCP dependencies with the parent view without rediscovery", () => {
    const registry = new ToolRegistry();
    for (const name of ["Read", "Write", "mcp__docs__search", "mcp__other__search"]) {
      registry.register({ ...addedTool, name }, name.startsWith("mcp__") ? { kind: "mcp", id: name.includes("other") ? "other" : "docs" } : undefined);
    }
    const parent = createRunCapabilityView({ toolRegistry: registry, mcpServers: [
      { serverId: "plugin:docs", serverName: "docs", definition: { command: "docs" } },
      { serverId: "baseline:other", serverName: "other", definition: { command: "other" } },
    ] });
    const child = { description: "d", prompt: "p", agent: "review", cwd: "/other", allowedTools: ["Read", "mcp__docs__search", "mcp__other__search", "NewTool"], requiredMcpServers: ["docs"] };
    const view = deriveChildCapabilityView(parent, child)!;
    expect([...view.tools.keys()]).toEqual(["Read", "mcp__docs__search"]);
    expect([...view.mcpServers.keys()]).toEqual(["plugin:docs"]);
    expect(view.tools.get("Read")).toBe(parent.tools.get("Read"));
    expect((view.tools as any).set).toBeUndefined();
    expect(() => deriveChildCapabilityView(parent, { ...child, requiredMcpServers: ["outside"] })).toThrow(/outside/);
    const ambiguous = { ...parent, mcpServers: new Map([...parent.mcpServers, ["another:docs", { serverId: "another:docs", serverName: "docs", definition: { command: "x" } }]]) };
    expect(() => deriveChildCapabilityView(ambiguous, child)).toThrow(/ambiguous/i);
  });
  it("preserves the host boundary while applying child role overrides", () => {
    const settings = { model: "settings-model" } as any;
    const capabilityOverrides = { memory: false } as const;
    const effects = { requestPermission: async () => ({ status: "denied" as const }) };

    const options = deriveChildAgentOptions({
      configuration: {
        model: "parent-model",
        systemPrompt: "parent prompt",
        permissionMode: "plan",
        hostToolCeiling: ["Read", "Grep", "Agent"],
        roleAllowedTools: ["Agent"],
        disallowedTools: ["Write", "Shell"],
        maxTurns: 9,
        effort: "high",
        tools: [addedTool],
        toolOverrides: [overriddenTool],
        trustedToolOverrides: ["Read"],
      },
      settings,
      capabilityOverrides,
      effects,
      child: {
        description: "Inspect the project",
        prompt: "Find the relevant files",
        agent: "Explore",
        cwd: "/repo/requested",
        model: "child-model",
        systemPrompt: "child prompt",
        permissionMode: "default",
        allowedTools: ["Read", "Grep"],
        disallowedTools: ["Shell", "Edit"],
        maxTurns: 4,
        effort: "medium",
      },
      cwd: "/repo/leased",
      sessionId: "child-session",
    });

    expect(options).toMatchObject({
      settings,
      cwd: "/repo/leased",
      sessionId: "child-session",
      model: "child-model",
      systemPrompt: "child prompt",
      permissionMode: "default",
      hostToolCeiling: ["Read", "Grep", "Agent"],
      roleAllowedTools: ["Read", "Grep"],
      disallowedTools: ["Write", "Shell", "Edit"],
      maxTurns: 4,
      effort: "medium",
    });
    expect(options.capabilityOverrides).toBe(capabilityOverrides);
    expect(options.effects).toBe(effects);
    expect(options.tools).toBeDefined();
    expect(options.tools?.[0]).toBe(addedTool);
    expect(options.toolOverrides).toBeDefined();
    expect(options.toolOverrides?.[0]).toBe(overriddenTool);
    expect(options.trustedToolOverrides).toEqual(["Read"]);
  });

  it("inherits parent runtime choices and ignores unsupported child effort values", () => {
    const options = deriveChildAgentOptions({
      configuration: {
        model: "parent-model",
        systemPrompt: "parent prompt",
        permissionMode: "full_auto",
        maxTurns: 12,
        effort: "low",
      },
      settings: {} as any,
      child: {
        description: "Inspect",
        prompt: "Inspect",
        agent: "worker",
        cwd: "/repo/requested",
        effort: "ultra",
      },
      cwd: "/repo/leased",
      sessionId: "child-session",
    });

    expect(options).toMatchObject({
      model: "parent-model",
      systemPrompt: "parent prompt",
      permissionMode: "full_auto",
      maxTurns: 12,
      effort: "low",
    });
    expect(options.roleAllowedTools).toBeUndefined();
    expect(options.disallowedTools).toBeUndefined();
  });
});
