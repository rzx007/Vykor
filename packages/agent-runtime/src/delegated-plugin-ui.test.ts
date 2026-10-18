import { describe, expect, it } from "vitest";
import { ToolRegistry, type RunPluginUiBinding } from "@vykor/core";
import { createVisibilityToolRegistry, constrainRunCapabilityTools } from "./default-runtime-tools.js";
import { createRunCapabilityView, restrictRunCapabilityView } from "./run-capability-view.js";
import { deriveChildCapabilityView } from "./child-agent-options.js";

function fixture() {
  const registry = new ToolRegistry();
  registry.register({ name: "Agent", description: "delegate", inputSchema: {}, execute: async () => ({ content: [] }) });
  registry.register({ name: "NativeAction", description: "own action", inputSchema: {},
    execute: async () => ({ content: [{ type: "text", text: "original" }] }) }, { kind: "plugin", id: "office" });
  const action = createRunCapabilityView({ toolRegistry: registry, pluginIds: new Set(["office"]) }, "office").tools.get("NativeAction")!;
  const binding: RunPluginUiBinding = { pluginId: "office", pluginVersion: "1", pluginDigest: "digest", componentId: "panel",
    componentDigest: "component", htmlSha256: "html", root: "/plugin", entryPath: "/plugin/ui.html",
    definition: { id: "panel", title: "Panel", entry: "./ui.html", surface: "tool-result",
      actions: [{ id: "run", label: "Run", tool: "NativeAction", completion: "keep-open" }] }, actionTools: [action] };
  const sources = { toolRegistry: createVisibilityToolRegistry(registry, { kind: "only" as const, names: new Set(["Agent"]) }, new Set()),
    delegatableToolRegistry: registry, pluginIds: new Set(["office"]), pluginUi: [binding] };
  return { registry, binding, sources };
}

describe("delegated plugin UI bindings", () => {
  it("keeps role limits distinct from host limits while narrowing tools and UI together", async () => {
    const { registry, sources } = fixture();
    const parent = createRunCapabilityView({ ...sources, toolRegistry: registry }, ["office"]);
    const original = parent.delegatableTools!.get("NativeAction")!;
    const coordinator = restrictRunCapabilityView(parent, name => name === "Agent", () => true);
    expect([...coordinator.tools.keys()]).toEqual(["Agent"]);
    expect(coordinator.pluginUi?.size).toBe(0);
    expect([...coordinator.delegatableTools!.keys()]).toEqual(["NativeAction"]);
    expect([...coordinator.delegatablePluginUi!.keys()]).toEqual(["office:panel"]);
    expect(coordinator.delegatableTools!.get("NativeAction")).toBe(original);
    expect(await coordinator.delegatableTools!.get("NativeAction")!.invoke({}, { cwd: "/repo" }))
      .toEqual({ content: [{ type: "text", text: "original" }] });

    const denied = restrictRunCapabilityView(coordinator, name => name !== "NativeAction");
    expect([...denied.tools.keys()]).toEqual(["Agent"]);
    expect(denied.pluginUi?.size).toBe(0);
    expect(denied.delegatableTools?.size).toBe(0);
    expect(denied.delegatablePluginUi?.size).toBe(0);
    expect(parent.tools.has("NativeAction")).toBe(true);
    expect(parent.pluginUi?.size).toBe(1);
  });

  it("removes an excluded MCP server's bindings from both tool scopes without losing unrelated UI", () => {
    const { registry, sources } = fixture();
    registry.register({ name: "mcp__office__render", description: "render", inputSchema: {}, execute: async () => ({ content: [] }) },
      { kind: "mcp", id: "office-server" });
    const parent = createRunCapabilityView({ ...sources, toolRegistry: registry,
      mcpServers: [{ ownerPluginId: "office", serverId: "office:mcp", serverName: "office-server",
        definition: { type: "stdio", command: "node" } }] }, ["office"]);
    const restricted = restrictRunCapabilityView({ ...parent, mcpServers: new Map() }, () => true);
    expect([...restricted.tools.keys()]).toEqual(["Agent", "NativeAction"]);
    expect([...restricted.delegatableTools!.keys()]).toEqual(["NativeAction"]);
    expect(restricted.pluginUi?.size).toBe(1);
    expect(restricted.delegatablePluginUi?.size).toBe(1);
    expect(parent.tools.has("mcp__office__render")).toBe(true);
  });

  it("keeps further child restrictions after receiving runtime filtering", () => {
    const { registry, sources } = fixture();
    const parent = createRunCapabilityView({ ...sources, toolRegistry: registry }, ["office"]);
    const child = deriveChildCapabilityView(parent, { description: "worker", prompt: "work", agent: "worker", cwd: "/repo",
      allowedTools: ["NativeAction"] })!;
    const receiver = createVisibilityToolRegistry(registry, { kind: "all" }, new Set(), undefined, { kind: "all" });
    const received = constrainRunCapabilityTools(receiver, child);
    expect([...received.tools.keys()]).toEqual(["NativeAction"]);
    expect(received.tools.get("NativeAction")).toBe(parent.tools.get("NativeAction"));
    expect(received.pluginUi?.size).toBe(1);
    const descendant = deriveChildCapabilityView(received, { description: "worker", prompt: "work", agent: "worker", cwd: "/other",
      disallowedTools: ["NativeAction"] })!;
    const resumed = constrainRunCapabilityTools(receiver, descendant);
    expect(resumed.tools.size).toBe(0);
    expect(resumed.delegatableTools?.size).toBe(0);
    expect(resumed.pluginUi?.size).toBe(0);
    expect(resumed.delegatablePluginUi?.size).toBe(0);
  });

  it("keeps a Coordinator's own UI empty while capturing immutable authorized UI for its workers", () => {
    const { sources, binding } = fixture();
    const view = createRunCapabilityView(sources, ["office"]);
    expect(view.pluginUi?.size).toBe(0);
    expect(view.delegatablePluginUi?.size).toBe(1);
    const captured = view.delegatablePluginUi!.get("office:panel")!;
    expect(captured.pluginDigest).toBe("digest");
    expect(captured.actionTools[0]!.definition.execute).toBe(view.delegatableTools!.get("NativeAction")!.definition.execute);
    expect((view.delegatablePluginUi as Map<string, unknown>).set).toBeUndefined();
    binding.definition.title = "changed after capture";
    expect(captured.definition.title).toBe("Panel");
    expect(createRunCapabilityView(sources, []).delegatablePluginUi?.size).toBe(0);
  });

  it("drops UI from further delegation when a child excludes its action tool", () => {
    const { sources } = fixture();
    const parent = createRunCapabilityView(sources, ["office"]);
    for (const restriction of [{ allowedTools: ["Read"] }, { disallowedTools: ["NativeAction"] }]) {
      const child = deriveChildCapabilityView(parent, { description: "worker", prompt: "work", agent: "worker", cwd: "/repo", ...restriction })!;
      expect(child.pluginUi?.size).toBe(0);
      expect(child.delegatablePluginUi?.size).toBe(0);
    }
  });

  it("drops inherited executable and delegated UI under the receiving runtime's host deny list", () => {
    const { registry, sources } = fixture();
    const parent = createRunCapabilityView({ ...sources, toolRegistry: registry }, ["office"]);
    const receiver = createVisibilityToolRegistry(registry, { kind: "all" }, new Set(["NativeAction"]), undefined, { kind: "all" });
    const constrained = constrainRunCapabilityTools(receiver, parent);
    expect(constrained.tools.has("NativeAction")).toBe(false);
    expect(constrained.pluginUi?.size).toBe(0);
    expect(constrained.delegatablePluginUi?.size).toBe(0);
  });

  it.each(["owner", "source", "function"])("rejects a UI component with a mismatched delegated action %s", change => {
    const { sources, binding } = fixture();
    const original = binding.actionTools[0]!;
    const corrupted = { ...binding, actionTools: [{ ...original,
      ...(change === "owner" ? { ownerPluginId: "foreign" } : {}),
      ...(change === "source" ? { source: { kind: "plugin" as const, id: "foreign" } } : {}),
      ...(change === "function" ? { definition: { ...original.definition, execute: async () => ({ content: [] }) } } : {}),
    }] };
    expect(createRunCapabilityView({ ...sources, pluginUi: [corrupted] }, ["office"]).delegatablePluginUi?.size).toBe(0);
  });
});
