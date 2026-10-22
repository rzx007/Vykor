import { type AgentChildSpawnInput, type StreamMessageParams } from "@vykor/agent-contracts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getInstalledPluginStorePath, type Settings } from "@vykor/host-config";
import {
  type AgentChildResult,
} from "@vykor/agent-contracts";

import { installLocalNativePlugin, updateInstalledPluginStore } from "@vykor/plugins";
import { createDefaultNodeAgent } from "../runtime/default-agent.js";
import type { VykorAgent, VykorAgentOptions } from "../runtime/agent.js";

const roots: string[] = [];
const agents: VykorAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const settings: Settings = {
  model: "scripted-client-only", apiFormat: "anthropic", maxTurns: 8,
  permission: { mode: "full_auto" }, sandbox: { enabled: false }, memory: { enabled: false },
};
const pluginId = "test.coordinator";
const foreignId = "test.foreign";
const mcpTool = "mcp__ready__ping";
type ScriptStep = string | { name: string; input: Record<string, unknown> };

async function fixture(options: {
  child?: Partial<AgentChildSpawnInput>;
  hostToolCeiling?: string[];
  disallowedTools?: string[];
  workerScript?: ScriptStep[];
  parentScript?: ScriptStep[];
  manyTools?: boolean;
  coordinatorSearch?: boolean;
  childIdleTtlMs?: number;
  beforeSpawn?: (root: string) => Promise<void>;
  onRunCapabilities?: VykorAgentOptions["onRunCapabilities"];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "coordinator-plugin-delegation-"));
  roots.push(root);
  vi.stubEnv("VYKOR_CONFIG_DIR", join(root, "config"));
  const marker = join(root, "native-calls.jsonl");
  const mcpMarker = join(root, "mcp-calls.jsonl");
  for (const [id, names] of [[pluginId, ["NativeWork", "HostDenied", "NativeDenied", ...(options.manyTools ? Array.from({ length: 20 }, (_, i) => `Extra${i}`) : [])]], [foreignId, ["ForeignWork"]]] as const) {
    const source = join(root, id);
    mkdirSync(join(source, ".vykor-plugin"), { recursive: true });
    writeFileSync(join(source, ".vykor-plugin/plugin.json"), JSON.stringify({
      schemaVersion: 1, id, name: id.split(".").at(-1), version: "1.0.0",
      components: { tools: ["./tools.mjs"], ...(id === pluginId ? { mcpServers: ["./mcp.json"] } : {}) },
    }));
    writeFileSync(join(source, "tools.mjs"), `
      import { appendFileSync } from 'node:fs';
      export function registerTools() { return ${JSON.stringify(names)}.map(name => ({
        name, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        invoke(_input, context) {
          appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ name, sessionId: context.sessionId }) + '\\n');
          return { content: [{ type: 'text', text: name + ':original-source' }] };
        }
      })); }
    `);
    if (id === pluginId) writeFileSync(join(source, "mcp.json"), JSON.stringify({ servers: { ready: {
      type: "stdio", command: process.execPath, args: ["-e", `
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line); if (request.id === undefined) return;
          if (request.method === 'tools/call') require('node:fs').appendFileSync(${JSON.stringify(mcpMarker)}, 'original-source\\n');
          const result = request.method === 'initialize'
            ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'ready', version: '1' } }
            : request.method === 'tools/list' ? { tools: [{ name: 'ping', description: 'original source', inputSchema: { type: 'object' } }] }
            : request.method === 'tools/call' ? { content: [{ type: 'text', text: 'original-source:pong' }] } : { resources: [] };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        });
      `],
    } } }));
    expect((await installLocalNativePlugin({ sourcePath: source, cwd: root, scope: "user",
      approvedPermissions: [],
    })).status).toBe("installed");
  }
  const requests: Array<{ worker: boolean; tools: string[]; messages: StreamMessageParams["messages"] }> = [];
  const workerScript = options.workerScript ?? ["NativeWork", mcpTool];
  const parentScript = options.parentScript ?? ["Delegate"];
  let parentTurns = 0;
  let workerTurns = 0;
  let childResult: AgentChildResult | undefined;
  let childId: string | undefined;
  let childError: unknown;
  const agentOptions: VykorAgentOptions = {
    cwd: root, sessionId: "coordinator", settings,
    systemPrompt: "COORDINATOR_TEST", roleAllowedTools: ["Delegate", ...(options.coordinatorSearch ? ["ToolSearch"] : [])],
    hostToolCeiling: options.hostToolCeiling,
    disallowedTools: options.disallowedTools,
    childIdleTtlMs: options.childIdleTtlMs,
    onRunCapabilities: options.onRunCapabilities,
    capabilityOverrides: { terminal: false, memory: false },
    client: { async *streamMessage(params) {
      const worker = params.system?.includes("WORKER_TEST") ?? false;
      requests.push({ worker, tools: params.tools?.map(tool => tool.name) ?? [], messages: structuredClone(params.messages) });
      const step = worker ? workerScript[workerTurns++ % (workerScript.length + 1)] : parentScript[parentTurns++];
      const name = typeof step === "string" ? step : step?.name;
      const input = typeof step === "string" ? {} : step?.input ?? {};
      if (name) yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `call-${requests.length}`, name, input } };
      else yield { type: "text_delta" as const, delta: "done" };
      yield { type: "complete" as const, stopReason: name ? "tool_use" as const : "end_turn" as const };
    } },
    tools: [{ name: "Delegate", description: "Run the actual framework worker", inputSchema: { type: "object" }, execute: async (_input, context) => {
      await options.beforeSpawn?.(root);
      try {
        const invocation = await context.agent!.children!.spawnChildAgent({
          description: "Use this Run's authorized tools", prompt: "worker task", agent: "worker", cwd: root,
          systemPrompt: "WORKER_TEST", ...options.child,
        });
        childId = invocation.id;
        childResult = await invocation.result;
      } catch (error) { childError = error; }
      return { content: [{ type: "text", text: childResult?.output ?? String(childError) }] };
    } }],
  };
  let agent = await createDefaultNodeAgent(agentOptions);
  agents.push(agent);
  return { root, get agent() { return agent; }, requests, marker, mcpMarker,
    async reopen() {
      await agent.close();
      agent = await createDefaultNodeAgent(agentOptions);
      agents.push(agent);
    },
    get childResult() { return childResult; }, get childError() { return childError; }, get childId() { return childId; } };
}

function nativeCalls(path: string): Array<{ name: string; sessionId: string }> {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}

describe("Coordinator delegates authorized plugin tools without widening its own role", () => {
  it("searches only the Coordinator's executable tools while a real worker discovers its own Native and MCP bindings", async () => {
    const f = await fixture({ manyTools: true, coordinatorSearch: true,
      parentScript: [{ name: "ToolSearch", input: { query: "NativeWork" } }, "Delegate"],
      workerScript: [{ name: "ToolSearch", input: { query: "NativeWork", limit: 1 } }, "NativeWork",
        { name: "ToolSearch", input: { query: mcpTool, limit: 1 } }, mcpTool],
    });
    await f.agent.runMessage("delegate with discovery", { capabilityView: f.agent.host.plugins.createRunCapabilityView(pluginId) });
    expect(f.childResult?.status).toBe("completed");
    expect(f.requests.filter(request => !request.worker).every(request => !request.tools.includes("NativeWork") && !request.tools.includes(mcpTool))).toBe(true);
    const parentResults = f.agent.getHistory().filter(message => message.type === "tool_result");
    const searchText = parentResults[0]!.content.map(block => block.type === "text" ? block.text : "").join("\n");
    expect(searchText).not.toContain('"name":"NativeWork"');
    expect(searchText).not.toContain(`"name":"${mcpTool}"`);
    expect(searchText).not.toContain("Extra0");
    const worker = f.requests.filter(request => request.worker);
    expect(worker[0]!.tools).toContain("ToolSearch");
    expect(worker[0]!.tools).not.toContain("NativeWork");
    expect(worker[1]!.tools).toContain("NativeWork");
    expect(worker[1]!.tools).not.toContain(mcpTool);
    expect(worker[3]!.tools).toContain(mcpTool);
    expect(nativeCalls(f.marker).map(call => call.name)).toEqual(["NativeWork"]);
    expect(readFileSync(f.mcpMarker, "utf8")).toBe("original-source\n");
  });

  it("rejects a Coordinator's direct calls to hidden Native and plugin MCP bindings despite their delegation grant", async () => {
    const f = await fixture({ parentScript: ["NativeWork", mcpTool] });
    const capabilityView = f.agent.host.plugins.createRunCapabilityView(pluginId);
    expect(capabilityView.delegatableTools?.has("NativeWork")).toBe(true);
    expect(capabilityView.delegatableTools?.has(mcpTool)).toBe(true);
    await f.agent.runMessage("attempt direct hidden plugin calls", { capabilityView });
    expect(f.requests.every(request => !request.worker && request.tools.length === 1 && request.tools[0] === "Delegate")).toBe(true);
    expect(f.childId).toBeUndefined();
    expect(nativeCalls(f.marker)).toEqual([]);
    expect(existsSync(f.mcpMarker)).toBe(false);
    const results = f.agent.getHistory().filter(message => message.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results.every(result => result.isError === true)).toBe(true);
  });

  // A role-filtered registry used as the delegation ceiling loses Native and MCP bindings.
  it("runs real Native and plugin MCP tools in a worker while the Coordinator never sees them", async () => {
    const f = await fixture({ child: { requiredMcpServers: ["ready"] }, workerScript: ["NativeWork", mcpTool, "ForeignWork"] });
    await f.agent.runMessage("delegate plugin work");
    expect(f.childError).toBeUndefined();
    expect(f.childResult?.status).toBe("completed");
    expect(f.requests.filter(request => !request.worker).every(request => !request.tools.includes("NativeWork") && !request.tools.includes(mcpTool))).toBe(true);
    expect(f.requests.find(request => request.worker)?.tools).toEqual(expect.arrayContaining(["NativeWork", mcpTool, "ForeignWork"]));
    expect(nativeCalls(f.marker)).toEqual([
      { name: "NativeWork", sessionId: expect.not.stringMatching(/^coordinator$/) },
      { name: "ForeignWork", sessionId: expect.not.stringMatching(/^coordinator$/) },
    ]);
    expect(readFileSync(f.mcpMarker, "utf8")).toBe("original-source\n");
    expect(JSON.stringify(f.requests.filter(request => request.worker).at(-1)?.messages)).toContain("original-source:pong");
  });

  it("keeps an explicit plugin restriction when the worker attempts another installed plugin", async () => {
    const f = await fixture({ workerScript: ["ForeignWork", "NativeWork", mcpTool] });
    await f.agent.runMessage("delegate within the explicit owner", { capabilityView: f.agent.host.plugins.createRunCapabilityView(pluginId) });
    const tools = f.requests.find(request => request.worker)?.tools;
    expect(tools).toEqual(expect.arrayContaining(["NativeWork", mcpTool]));
    expect(tools).not.toContain("ForeignWork");
    expect(nativeCalls(f.marker)).toEqual([{ name: "NativeWork", sessionId: expect.any(String) }]);
    expect(readFileSync(f.mcpMarker, "utf8")).toBe("original-source\n");
  });

  it("preserves the host ceiling and inherited deny list while exposing other authorized plugin tools", async () => {
    const f = await fixture({
      hostToolCeiling: ["Delegate", "NativeWork", "NativeDenied", mcpTool],
      disallowedTools: ["NativeDenied"], workerScript: ["HostDenied", "NativeDenied", "NativeWork", mcpTool],
    });
    await f.agent.runMessage("delegate with host restrictions");
    const tools = f.requests.find(request => request.worker)?.tools;
    expect(tools).toEqual(expect.arrayContaining(["NativeWork", mcpTool]));
    for (const denied of ["HostDenied", "NativeDenied", "ForeignWork"]) expect(tools).not.toContain(denied);
    expect(nativeCalls(f.marker).map(call => call.name)).toEqual(["NativeWork"]);
    expect(readFileSync(f.mcpMarker, "utf8")).toBe("original-source\n");
  });

  it("honors child role restrictions and an explicit empty MCP dependency list", async () => {
    const f = await fixture({
      child: { allowedTools: ["NativeWork", "ForeignWork", mcpTool], disallowedTools: ["NativeWork"], requiredMcpServers: [] },
      workerScript: ["NativeWork", mcpTool, "ForeignWork"],
    });
    await f.agent.runMessage("delegate a narrower worker");
    expect(f.requests.find(request => request.worker)?.tools).toEqual(["ForeignWork"]);
    expect(nativeCalls(f.marker).map(call => call.name)).toEqual(["ForeignWork"]);
    expect(existsSync(f.mcpMarker)).toBe(false);
  });

  it.each(["disabled", "upgraded"])("rejects the captured parent scope when a plugin is %s before worker startup", async change => {
    const f = await fixture({ beforeSpawn: async root => { await changeInstallation(root, change); } });
    await f.agent.runMessage("delegate after source changes");
    expect(f.requests.some(request => request.worker)).toBe(false);
    expect(f.childResult?.output ?? String(f.childError)).toMatch(/available|changed|owner/);
    expect(nativeCalls(f.marker)).toEqual([]);
    expect(existsSync(f.mcpMarker)).toBe(false);
  });

  it.each(["disabled", "upgraded"])("does not replace an earlier capability snapshot after reopening with its owner %s", async change => {
    const f = await fixture();
    const capabilityView = f.agent.host.plugins.createRunCapabilityView([pluginId]);
    const pluginCandidates = f.agent.host.plugins.getPluginCandidates().filter(candidate => candidate.pluginId === pluginId);
    await changeInstallation(f.root, change);
    await f.reopen();
    await expect(f.agent.runMessage("resume captured plugin work", { capabilityView, pluginCandidates })).rejects.toThrow(/available|changed|owner/);
    expect(f.requests).toEqual([]);
    expect(nativeCalls(f.marker)).toEqual([]);
    expect(existsSync(f.mcpMarker)).toBe(false);
  });

  it("resumes an actually suspended worker with the same captured Native and MCP sources", async () => {
    const f = await fixture({ childIdleTtlMs: 10 });
    const capabilityView = f.agent.host.plugins.createRunCapabilityView(pluginId);
    await f.agent.runMessage("delegate then suspend", { capabilityView });
    const child = f.agent.children.get(f.childId!)!;
    await vi.waitFor(() => expect(child.state).toBe("suspended"), { timeout: 3_000, interval: 10 });
    await child.send({ content: "resume plugin work" }, capabilityView);
    expect((await child.result).status).toBe("completed");
    expect(nativeCalls(f.marker).map(call => call.name)).toEqual(["NativeWork", "NativeWork"]);
    expect(readFileSync(f.mcpMarker, "utf8")).toBe("original-source\noriginal-source\n");
    expect(f.requests.filter(request => request.worker).every(request => request.tools.includes("NativeWork") && request.tools.includes(mcpTool))).toBe(true);
  });

  it.each(["disabled", "upgraded"])("rechecks the original plugin identity before an actually suspended worker resumes after its owner is %s", async change => {
    const f = await fixture({ childIdleTtlMs: 10 });
    const capabilityView = f.agent.host.plugins.createRunCapabilityView(pluginId);
    await f.agent.runMessage("delegate then suspend", { capabilityView });
    const child = f.agent.children.get(f.childId!)!;
    await vi.waitFor(() => expect(child.state).toBe("suspended"), { timeout: 3_000, interval: 10 });
    const previousRequests = f.requests.filter(request => request.worker).length;
    await changeInstallation(f.root, change);
    let failure: unknown;
    try { await child.send({ content: "resume plugin work" }, capabilityView); }
    catch (error) { failure = error; }
    const resumed = await child.result;
    expect(resumed.status).toBe("failed");
    expect(String(failure ?? resumed.output)).toMatch(/available|changed|owner/);
    expect(f.requests.filter(request => request.worker)).toHaveLength(previousRequests);
    expect(nativeCalls(f.marker).map(call => call.name)).toEqual(["NativeWork"]);
    expect(readFileSync(f.mcpMarker, "utf8")).toBe("original-source\n");
  });
});

async function changeInstallation(root: string, change: string) {
  if (change === "disabled") {
    await updateInstalledPluginStore(getInstalledPluginStorePath(), store => { store.plugins[`user::${pluginId}`]!.enabled = false; });
  } else {
    const manifestPath = join(root, pluginId, ".vykor-plugin/plugin.json");
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), version: "2.0.0" }));
    expect((await installLocalNativePlugin({ sourcePath: join(root, pluginId), cwd: root, scope: "user", approvedPermissions: [] })).status).toBe("installed");
  }
}
