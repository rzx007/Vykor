import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type McpServerConfig, type RuntimeBundle } from "@openharness/core";
import { loadNativePlugin, validateNativePlugin, type LoadedNativePlugin } from "@openharness/plugins";
import { SkillRegistry } from "@openharness/skills";
import { createOpenHarnessRuntime } from "./default-runtime.js";
import { installRuntimeIntegrations } from "./runtime-integrations.js";
import { createPluginCapabilityInventory } from "./plugin-capability-inventory.js";
import { deriveChildCapabilityView } from "./child-agent-options.js";

const roots: string[] = [];
const runtimes: RuntimeBundle[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function plugin(id: string, source?: string, servers?: Record<string, McpServerConfig>) {
  const root = mkdtempSync(join(tmpdir(), "plugin-readiness-"));
  roots.push(root);
  mkdirSync(join(root, ".openharness-plugin"));
  writeFileSync(join(root, ".openharness-plugin/plugin.json"), JSON.stringify({
    schemaVersion: 1, id, name: id.split(".").at(-1), version: "1.0.0",
    components: { ...(source ? { tools: ["./tool.mjs"] } : {}), ...(servers ? { mcpServers: ["./mcp.json"] } : {}) },
  }));
  if (source) writeFileSync(join(root, "tool.mjs"), source);
  if (servers) writeFileSync(join(root, "mcp.json"), JSON.stringify({ servers }));
  const validated = await validateNativePlugin(root);
  expect(validated.status).toBe("valid");
  return loadNativePlugin(validated.plugin!);
}

async function install(plugins: LoadedNativePlugin[], hostServers: Record<string, McpServerConfig> = {}) {
  const skillRegistry = new SkillRegistry();
  const runtime = await createOpenHarnessRuntime({
    cwd: roots[0]!, skillRegistry,
    settings: { model: "test", apiFormat: "anthropic", maxTurns: 1, permission: { mode: "default" }, sandbox: { enabled: false }, mcpServers: hostServers },
    configuration: { client: { async *streamMessage() { yield { type: "complete" as const, stopReason: "end_turn" }; } } },
  });
  runtimes.push(runtime);
  const getConnections = await installRuntimeIntegrations({ cwd: roots[0]!, sessionId: "readiness", settings: runtime.settings, runtime,
    discovery: { skillRegistry, plugins, agentDefinitions: [], warnings: [],
      mcpServers: Object.assign({}, ...plugins.map(item => item.components.mcpServers?.value ?? {}), hostServers),
      pluginCapabilityInventory: createPluginCapabilityInventory(plugins.map(item => ({ plugin: item, record: {
        id: item.manifest.id, scope: "user", enabled: true, currentVersion: "1.0.0", cachePath: item.root,
        origin: "native", requestedPermissions: [], approvedPermissions: [], installedAt: "now", updatedAt: "now",
      } }))),
    },
  });
  return { runtime, getConnections };
}

const nativeSource = `export function registerTools() { return [{ name: "ReadyTool", description: "ready", inputSchema: {},
  invoke(input) { if (input.crash) process.exit(17); return { content: [{ type: "text", text: "ready" }] }; }
}]; }`;
const readyServer: McpServerConfig = { type: "stdio", command: process.execPath, args: ["-e", `
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const req = JSON.parse(line); if (req.id === undefined) return;
    if (req.method === 'tools/call' && req.params.arguments.crash) process.exit(19);
    const result = req.method === 'initialize'
      ? { protocolVersion: req.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'ready', version: '1' } }
      : req.method === 'tools/list' ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
      : req.method === 'tools/call' ? { content: [{ type: 'text', text: 'pong' }] } : { resources: [] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
  });
`] };
const brokenServer: McpServerConfig = { type: "stdio", command: process.execPath, args: ["-e", "process.exit(23)"] };

it.each([
  ["register exception", `export function registerTools() { throw new Error('registration exploded'); }`, /registration exploded/],
  ["registration conflict", nativeSource.replaceAll("ReadyTool", "Read"), /already registered/],
])("rejects a selected plugin after Native Tool %s", async (_name, source, reason) => {
  const { runtime } = await install([await plugin("dev.failed", source as string)]);
  expect(() => runtime.createRunCapabilityView!("dev.failed")).toThrow(reason as RegExp);
  expect(() => runtime.createRunCapabilityView!()).not.toThrow();
});

it("keeps failed MCP diagnostics, rejects a partially prepared plugin, and excludes disconnected host dependencies", async () => {
  const partial = await plugin("dev.partial", nativeSource, { unavailable: brokenServer });
  const working = await plugin("dev.working", undefined, { ready: readyServer });
  const { runtime, getConnections } = await install([partial, working], { hostUnavailable: brokenServer });
  expect(runtime.toolRegistry.has("ReadyTool")).toBe(true);
  expect(getConnections().find(item => item.name === "unavailable")).toMatchObject({ status: "error", error: expect.any(Error) });
  expect(() => runtime.createRunCapabilityView!("dev.partial")).toThrow(/dev.partial.*unavailable.*closed/i);
  const ordinary = runtime.createRunCapabilityView!();
  expect(ordinary.mcpServers.size).toBe(0);
  expect(() => deriveChildCapabilityView(ordinary, { description: "test", prompt: "test", agent: "worker", cwd: roots[0]!, requiredMcpServers: ["hostUnavailable"] })).toThrow(/outside parent/);
  const selected = runtime.createRunCapabilityView!("dev.working");
  expect([...selected.mcpServers.keys()]).toEqual(["plugin:dev.working:mcp:ready"]);
  expect((await selected.tools.get("mcp__ready__ping")!.invoke({}, { cwd: roots[0]! })).content).toEqual([{ type: "text", text: "pong" }]);
});

it("allows a prepared Native Tool and rejects the next Run after its host crashes", async () => {
  const { runtime } = await install([await plugin("dev.crash", nativeSource)]);
  const view = runtime.createRunCapabilityView!("dev.crash");
  const tool = view.tools.get("ReadyTool")!;
  expect((await tool.invoke({}, { cwd: roots[0]!, capabilityView: view })).content).toEqual([{ type: "text", text: "ready" }]);
  await expect(tool.invoke({ crash: true }, { cwd: roots[0]!, capabilityView: view })).rejects.toThrow(/exited/);
  expect(() => runtime.createRunCapabilityView!("dev.crash")).toThrow(/dev.crash.*exited/);
  expect(() => runtime.createRunCapabilityView!()).not.toThrow();
});

it("rejects the next plugin Run after an established MCP connection closes", async () => {
  const { runtime, getConnections } = await install([await plugin("dev.remote", undefined, { remote: readyServer })]);
  const view = runtime.createRunCapabilityView!("dev.remote");
  const result = await view.tools.get("mcp__remote__ping")!.invoke({ crash: true }, { cwd: roots[0]! });
  expect(result.isError).toBe(true);
  expect(getConnections().find(item => item.name === "remote")?.status).not.toBe("connected");
  expect(() => runtime.createRunCapabilityView!("dev.remote")).toThrow(/dev.remote.*remote.*closed/i);
  expect(runtime.createRunCapabilityView!().mcpServers.size).toBe(0);
  expect(runtime.createRunCapabilityView!().tools.has("mcp__remote__ping")).toBe(false);
});

it.each(["tools/list", "resources/list"])("retains MCP %s failures and rejects the selected plugin", async (method) => {
  const server = { ...readyServer, args: ["-e", readyServer.args![1]!.replace(
    "if (req.id === undefined) return;",
    `if (req.id === undefined) return;
     if (req.method === '${method}') {
       process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'catalog unavailable' } }) + '\\n');
       return;
     }`,
  )] };
  const { runtime, getConnections } = await install([await plugin("dev.catalog", undefined, { catalog: server })]);
  const connection = getConnections().find(item => item.name === "catalog")!;
  expect(method === "tools/list" ? connection.toolError : connection.resourceError).toMatchObject({ message: expect.stringContaining("catalog unavailable") });
  expect(() => runtime.createRunCapabilityView!("dev.catalog")).toThrow(/dev.catalog.*catalog.*catalog unavailable/);
  expect(() => runtime.createRunCapabilityView!()).not.toThrow();
});

it("accepts a resource-only MCP server that does not implement tools/list", async () => {
  const server = { ...readyServer, args: ["-e", readyServer.args![1]!
    .replace("tools: {}, resources: {}", "resources: {}")
    .replace("if (req.id === undefined) return;", `if (req.id === undefined) return;
      if (req.method === 'tools/list') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
        return;
      }`)] };
  const { runtime, getConnections } = await install([await plugin("dev.resources", undefined, { resources: server })]);
  expect(getConnections()[0]).toMatchObject({ status: "connected", tools: [] });
  expect(runtime.createRunCapabilityView!("dev.resources").mcpServers.has("plugin:dev.resources:mcp:resources")).toBe(true);
});

it("does not mark MCP connected when the process exits during catalog initialization", async () => {
  const server = { ...readyServer, args: ["-e", readyServer.args![1]!.replace(
    "if (req.id === undefined) return;", "if (req.id === undefined) return; if (req.method === 'tools/list') process.exit(29);",
  )] };
  const { runtime, getConnections } = await install([await plugin("dev.exited", undefined, { exited: server })]);
  expect(getConnections()[0]?.status).toBe("error");
  expect(() => runtime.createRunCapabilityView!("dev.exited")).toThrow(/exited.*closed/i);
});
