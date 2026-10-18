import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "../types/tools.js";
import { resolveToolExecution, ToolRegistry, toolRegistryForNames, visibleToolRegistry } from "./tool-registry.js";

function testTool(execution?: ToolDefinition["execution"]): ToolDefinition {
  return {
    name: "PluginTool",
    description: "test",
    inputSchema: {},
    ...(execution ? { execution } : {}),
    async execute() {
      return { content: [] };
    },
  };
}

describe("tool execution domains", () => {
  it("defaults undeclared tools to local-only environment work", () => {
    expect(resolveToolExecution(testTool())).toEqual({
      domain: "environment",
      supportedEnvironments: ["local"],
    });
  });

  it("preserves an explicit execution contract in registry descriptors", () => {
    const registry = new ToolRegistry();
    registry.register(testTool({
      domain: "control_plane",
      supportedEnvironments: ["local", "wsl"],
      network: true,
    }));

    expect(registry.getAll()[0]?.execution).toEqual({
      domain: "control_plane",
      supportedEnvironments: ["local", "wsl"],
      network: true,
    });
  });
});

describe("authorization wildcard semantics", () => {
  function registry() {
    const tools = new ToolRegistry();
    for (const name of ["Read", "*", "Private"]) tools.register({ ...testTool(), name }, { kind: "plugin", id: name });
    return tools;
  }

  it.each([null, ["*"], ["Read", "*"]])("retains the existing full authorization for %j", allowed => {
    const tools = registry();
    expect(visibleToolRegistry(tools, allowed).getAll().map(t => t.name)).toEqual(["Read", "*", "Private"]);
  });

  it("keeps an empty grant closed and treats alwaysAllowed as actual tool names", () => {
    const tools = registry();
    expect(visibleToolRegistry(tools, []).getAll()).toEqual([]);
    expect(visibleToolRegistry(tools, ["Read"], ["*"]).getAll().map(t => t.name)).toEqual(["Read", "*"]);
  });

  it("matches a literal star across every lookup without changing its binding or source", () => {
    const tools = registry();
    const actual = toolRegistryForNames(tools, ["*"]);
    expect(actual.getAll()).toEqual([tools.get("*")]);
    expect(actual.get("*")).toBe(tools.get("*"));
    expect(actual.inspect("*")?.source).toEqual({ kind: "plugin", id: "*" });
    expect(actual.has("*")).toBe(true);
    expect(actual.get("Private")).toBeUndefined();
    expect(actual.inspect("Private")).toBeUndefined();
    expect(actual.has("Private")).toBe(false);
  });

  it("keeps empty actual names closed and cannot widen an inner authorization ceiling", () => {
    const tools = registry();
    expect(toolRegistryForNames(tools, []).getAll()).toEqual([]);
    const authorized = visibleToolRegistry(tools, ["Read"]);
    expect(toolRegistryForNames(authorized, ["*", "Read", "Private"]).getAll().map(t => t.name)).toEqual(["Read"]);
    expect(visibleToolRegistry(toolRegistryForNames(tools, ["*"]), ["*"]).getAll().map(t => t.name)).toEqual(["*"]);
  });

  it("captures exact-name membership without retaining a mutable caller set", () => {
    const tools = registry();
    const names = new Set(["*"]);
    const actual = toolRegistryForNames(tools, names);
    names.add("Private");
    expect(actual.getAll().map(t => t.name)).toEqual(["*"]);
    expect(actual.has("Private")).toBe(false);
  });
});
