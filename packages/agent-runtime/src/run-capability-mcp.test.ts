import { expect, it, vi } from "vitest";
import { QueryEngine, ToolRegistry, type AgentExecutionContext, type IHookExecutor, type McpServerConfig, type ToolDefinition } from "@vykor/core";
import { McpClientManager } from "@vykor/mcp";
import { mcpToolCallTool, listMcpResourcesTool, readMcpResourceTool, mcpAuthTool } from "../../tools/src/mcp/mcp-tools.js";
import { createRunCapabilityView } from "./run-capability-view.js";

// A real stdio JSON-RPC endpoint: new processes return a different version.
const serverCode = `
  const { createInterface } = require('node:readline');
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const version = process.argv[1];
    const responses = {
      initialize: { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'binding-test', version: '1' } },
      'tools/list': { tools: [{ name: 'version', description: 'connection version', inputSchema: { type: 'object' } }] },
      'tools/call': { content: [{ type: 'text', text: version }] },
      'resources/list': { resources: [{ name: version, uri: 'test://secret' }] },
      'resources/read': { contents: [{ uri: 'test://secret', text: version }] },
    };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: responses[request.method] ?? {} }) + '\\n');
  });
`;
const config = (version: string): McpServerConfig => ({ type: "stdio", command: process.execPath, args: ["-e", serverCode, version] });

it("never redirects a captured MCP Tool to a reconnected client", async () => {
  const manager = new McpClientManager();
  try {
    expect((await manager.connect("private", config("old-client"))).status).toBe("connected");
    const oldDefinition = manager.getAsToolDefinitions()[0]!;
    const registry = new ToolRegistry();
    registry.register(oldDefinition, { kind: "mcp", id: "private" });
    const sources = { toolRegistry: registry, pluginIds: new Set(["private-plugin"]), mcpServers: [{
      ownerPluginId: "private-plugin", serverId: "plugin:private-plugin:mcp:private", serverName: "private", definition: config("old-client"),
    }] };
    const active = createRunCapabilityView(sources, "private-plugin");
    const oldBinding = active.tools.get("mcp__private__version")!;
    expect(oldBinding.serverId).toBe("plugin:private-plugin:mcp:private");
    expect((await oldBinding.invoke({}, { cwd: process.cwd() })).content).toEqual([{ type: "text", text: "old-client" }]);
    await manager.reconnect("private", config("new-client"));
    registry.override(manager.getAsToolDefinitions()[0]!, { kind: "mcp", id: "private" });
    const stale = await oldBinding.invoke({}, { cwd: process.cwd() }).catch((error: Error) => ({ isError: true, content: [{ type: "text", text: error.message }] }));
    expect(stale.isError).toBe(true);
    expect(stale.content).not.toEqual([{ type: "text", text: "new-client" }]);
    const fresh = createRunCapabilityView(sources, "private-plugin").tools.get("mcp__private__version")!;
    expect((await fresh.invoke({}, { cwd: process.cwd() })).content).toEqual([{ type: "text", text: "new-client" }]);
  } finally { await manager.disconnectAll(); }
});

it("keeps a captured MCP Tool Definition while a new view sees the replacement", async () => {
  const manager = new McpClientManager();
  try {
    expect((await manager.connect("private", config("old-client"))).status).toBe("connected");
    const registry = new ToolRegistry();
    registry.register(manager.getAsToolDefinitions()[0]!, { kind: "mcp", id: "private" });
    const sources = { toolRegistry: registry, pluginIds: new Set(["private-plugin"]), mcpServers: [{
      ownerPluginId: "private-plugin", serverId: "plugin:private-plugin:mcp:private", serverName: "private", definition: config("old-client"),
    }] };
    const captured = createRunCapabilityView(sources, "private-plugin").tools.get("mcp__private__version")!;
    const replacement: ToolDefinition = {
      name: "mcp__private__version",
      description: "replacement",
      inputSchema: {},
      execute: async () => ({ content: [{ type: "text", text: "replacement" }] }),
    };
    registry.replaceBySource({ kind: "mcp", id: "private" }, [replacement]);

    expect((await captured.invoke({}, { cwd: process.cwd() })).content).toEqual([{ type: "text", text: "old-client" }]);
    const fresh = createRunCapabilityView(sources, "private-plugin").tools.get("mcp__private__version")!;
    expect((await fresh.invoke({}, { cwd: process.cwd() })).content).toEqual([{ type: "text", text: "replacement" }]);
  } finally { await manager.disconnectAll(); }
});

it("keeps an active Run on its old MCP client across an atomic reconnect", async () => {
  const manager = new McpClientManager();
  let releaseRun: (() => void) | undefined;
  try {
    expect((await manager.connect("private", config("old-client"))).status).toBe("connected");
    const registry = new ToolRegistry();
    registry.register(manager.getAsToolDefinitions()[0]!, { kind: "mcp", id: "private" });
    const sources = { toolRegistry: registry, pluginIds: new Set(["private-plugin"]), mcpServers: [{
      ownerPluginId: "private-plugin", serverId: "plugin:private-plugin:mcp:private", serverName: "private", definition: config("old-client"),
    }] };
    const oldBinding = createRunCapabilityView(sources, "private-plugin").tools.get("mcp__private__version")!;
    releaseRun = manager.retainCurrentConnections();
    const prepared = await manager.prepareConnection("private", config("new-client"));
    const activation = manager.activatePreparedConnection(prepared, (tools) => {
      registry.replaceBySource({ kind: "mcp", id: "private" }, tools);
    });
    if (!activation.committed) throw activation.error;
    await activation.closePrevious();

    expect((await oldBinding.invoke({}, { cwd: process.cwd() })).content).toEqual([{ type: "text", text: "old-client" }]);
    const fresh = createRunCapabilityView(sources, "private-plugin").tools.get("mcp__private__version")!;
    expect((await fresh.invoke({}, { cwd: process.cwd() })).content).toEqual([{ type: "text", text: "new-client" }]);

    releaseRun();
    releaseRun = undefined;
    await vi.waitFor(async () => {
      expect((await oldBinding.invoke({}, { cwd: process.cwd() })).isError).toBe(true);
    });
  } finally {
    releaseRun?.();
    await manager.disconnectAll();
  }
});

it.each([undefined, "another-plugin"])("blocks global MCP meta capabilities for a Run owned by %s", async (pluginId) => {
  const manager = new McpClientManager();
  let savedAuth = false;
  try {
    expect((await manager.connect("private", config("plugin-secret"))).status).toBe("connected");
    const registry = new ToolRegistry();
    for (const definition of [mcpToolCallTool, listMcpResourcesTool, readMcpResourceTool, mcpAuthTool]) registry.register(definition);
    const calls = [
      { name: "McpToolCall", input: { serverName: "private", toolName: "version", args: {} } },
      { name: "ListMcpResources", input: {} },
      { name: "ReadMcpResource", input: { serverName: "private", uri: "test://secret" } },
      { name: "McpAuth", input: { serverName: "private", mode: "env", value: "secret" } },
    ];
    let turn = 0;
    const engine = new QueryEngine({ streamMessage: async function* () {
      if (turn++ === 0) {
        for (const [i, call] of calls.entries()) yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `call-${i}`, ...call } };
        yield { type: "complete" as const, stopReason: "tool_use" };
      } else yield { type: "complete" as const, stopReason: "end_turn" };
    } }, registry, { checkTool: async () => ({ action: "allow" }) }, { execute: async () => ({ blocked: false }) } as IHookExecutor);
    engine.setMcpManager(manager);
    engine.setMcpAuth({ configure: async () => { savedAuth = true; return { message: "saved" }; } });
    const capabilityView = createRunCapabilityView({ toolRegistry: registry, pluginIds: new Set(["another-plugin"]), mcpServers: [{
      ownerPluginId: "private-plugin", serverId: "plugin:private-plugin:mcp:private", serverName: "private", definition: config("plugin-secret"),
    }] }, pluginId);
    const execution = { capabilityView, emit: async () => {}, takeSteeredInputs: async () => [], closeSteering: () => {} } as unknown as AgentExecutionContext;
    const results = [];
    for await (const event of engine.submitMessage("go", { execution })) if (event.type === "tool_use_end") results.push(event.result);
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.isError)).toBe(true);
    expect(JSON.stringify(results)).not.toContain("plugin-secret");
    expect(savedAuth).toBe(false);
  } finally { await manager.disconnectAll(); }
});
