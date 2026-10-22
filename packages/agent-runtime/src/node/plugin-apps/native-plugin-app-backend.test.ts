import { type AgentExecutionContext, type ToolResult } from "@vykor/agent-contracts";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegisteredHookExecutor as IHookExecutor } from "@vykor/host-config";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { McpClientManager } from "@vykor/mcp";
import { loadNativePlugin, validateNativePlugin } from "@vykor/plugins";
import { PLUGIN_APP_DEFAULT_LIMITS } from "./policy.js";
import { writeNativeAppFixture } from "../../../../plugins/src/test-helpers/native-app.js";
import { activateNativePluginTools } from "../plugins/native-tools/activate.js";
import { captureNativePluginAppBackend, nativeToolResultToAppResult } from "./native-plugin-app-backend.js";
import { createVisibilityToolRegistry, getAppToolRegistry, getTrustedToolCatalogue } from "../runtime/default-runtime-tools.js";
import { createRunCapabilityView } from "../plugins/run-capability-view.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("Native app result adaptation", () => {
  it("copies only text/isError/appData without mutating execution facts or guessing JSON text", () => {
    const original: ToolResult = { content: [{ type: "text", text: '{"not":"appData"}' }], isError: false, executionState: "completed",
      metadata: { appData: { saved: true }, secret: "host private", executionState: "not_started" } };
    const snapshot = structuredClone(original);
    expect(nativeToolResultToAppResult(original)).toEqual({ result: { content: original.content, isError: false, structuredContent: { saved: true } } });
    expect(original).toEqual(snapshot);
    expect(nativeToolResultToAppResult({ content: original.content }).result.structuredContent).toBeUndefined();
  });

  it.each([null, [], "json", { nested: Infinity }, { toJSON: () => ({}) }])("keeps successful text when appData is invalid: %s", appData => {
    const original: ToolResult = { content: [{ type: "text", text: "Saved" }], executionState: "completed", metadata: { appData } };
    expect(nativeToolResultToAppResult(original)).toEqual({ result: { content: original.content }, dataError: "plugin_app_invalid_data" });
    expect(original.executionState).toBe("completed");
  });

  it("bounds structured bytes and refuses metadata getters without running them", () => {
    expect(nativeToolResultToAppResult({ content: [], metadata: { appData: { text: "字".repeat(PLUGIN_APP_DEFAULT_LIMITS.appDataBytes / 2) } } }).dataError).toBe("plugin_app_data_too_large");
    const getter = vi.fn(() => ({}));
    expect(nativeToolResultToAppResult({ content: [], metadata: Object.defineProperty({}, "appData", { enumerable: true, get: getter }) }).dataError).toBe("plugin_app_invalid_data");
    expect(getter).not.toHaveBeenCalled();
  });

  it("reports non-text page capability errors while preserving the executed original", () => {
    const original: ToolResult = { content: [{ type: "image", source: { type: "file", mediaType: "image/png", path: "/not-read.png" } }], executionState: "completed" };
    expect(nativeToolResultToAppResult(original)).toEqual({ result: { content: [] }, dataError: "plugin_app_unsupported_content" });
    expect(original.executionState).toBe("completed");
    expect(original.content).toHaveLength(1);
  });
});

describe("Native app original bindings", () => {
  async function fixture(mappedName = "SaveDocument") {
    const root = await mkdtemp(join(tmpdir(), "vykor-native-app-")); roots.push(root);
    const plugin = await writeNativeAppFixture(root);
    plugin.manifest.permissions = { network: ["example.test"] };
    plugin.manifest.components.tools = [{ entry: "./tools/index.mjs", permissions: ["network:example.test"] }];
    await writeFile(plugin.manifestPath, JSON.stringify(plugin.manifest));
    if (mappedName !== "SaveDocument") {
      const appFile = join(root, "ui/apps.json");
      await writeFile(appFile, (await readFile(appFile, "utf8")).replaceAll("SaveDocument", mappedName));
    }
    await writeFile(join(root, "tools/index.mjs"), `
      let calls = 0;
      export function registerTools() { return [
        { name: "SaveDocument", description: "save", inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } }, additionalProperties: false },
          invoke(input, context) { calls++; return { content: [{ type: "text", text: "Saved" }], metadata: { appData: { calls, value: input.value, cwd: context.cwd, sessionId: context.sessionId, dataDir: context.plugin.dataDir, hasSignal: context.signal instanceof AbortSignal, deadline: context.deadline } } }; } },
        { name: "UnmappedTool", description: "model only mapping", inputSchema: {}, invoke() { return { content: [] }; } }
      ]; }
    `);
    const validation = await validateNativePlugin(root);
    expect(validation.status).toBe("valid");
    return loadNativePlugin(validation.plugin!);
  }

  it("executes the original guarded host exactly once, with no new listener, MCP client or proxy registration", async () => {
    const plugin = await fixture();
    const registry = new ToolRegistry();
    const listen = vi.spyOn(Server.prototype, "listen");
    const mcp = vi.spyOn(McpClientManager.prototype, "prepareConnection");
    const cleanups: Array<() => Promise<void> | void> = [];
    const audits: unknown[] = [];
    const activated = await activateNativePluginTools(plugin, { cwd: plugin.root, dataRoot: plugin.root, toolRegistry: registry,
      addCleanup: cleanup => cleanups.push(cleanup), onAudit: event => audits.push(event) });
    try {
      expect(activated.state).toBe("active");
      const restricted = createVisibilityToolRegistry(registry, { kind: "all" }, new Set());
      const metadata = plugin.components.apps!.value![0]!;
      const originalCalls = vi.spyOn(activated.host!, "call");
      for (const [ceiling, deny, environment] of [
        [{ kind: "none" }, new Set<string>(), undefined], // host ceiling
        [{ kind: "only", names: new Set(["UnmappedTool"]) }, new Set<string>(), undefined], // role allowedTools
        [{ kind: "all" }, new Set(["SaveDocument"]), undefined],
        [{ kind: "all" }, new Set<string>(), { info: { kind: "wsl", networkMode: "host" } }],
        [{ kind: "all" }, new Set<string>(), { info: { kind: "local", networkMode: "none" } }],
      ] as const) {
        const blocked = createVisibilityToolRegistry(registry, ceiling, deny,
          environment as Parameters<typeof createVisibilityToolRegistry>[3]);
        const denied = captureNativePluginAppBackend({ pluginId: plugin.manifest.id, pluginVersion: "1.0.0", pluginDigest: "digest",
          metadata, definition: metadata.definition.backends[0]!, root: plugin.root, host: activated.host!, toolRegistry: getTrustedToolCatalogue(blocked) });
        expect(denied.tools.size).toBe(0);
        expect(denied.isCurrentTool("SaveDocument")).toBe(false);
      }
      expect(originalCalls).not.toHaveBeenCalled();
      const backend = captureNativePluginAppBackend({ pluginId: plugin.manifest.id, pluginVersion: "1.0.0", pluginDigest: "digest",
        metadata, definition: metadata.definition.backends[0]!, root: plugin.root, host: activated.host!, toolRegistry: getTrustedToolCatalogue(restricted) });
      expect([...backend.tools.keys()]).toEqual(["SaveDocument"]);
      expect(backend.port).not.toHaveProperty("invoke");
      expect(backend.port).not.toHaveProperty("tools");
      await backend.port.readResource("ui://fixture/panel.html");
      expect(await backend.port.listResourceTemplates()).toEqual({ resourceTemplates: [] });
      expect(backend.port.supportsSubscriptions).toBe(false);
      await expect(backend.port.readResource("ui://fixture/other.html")).rejects.toThrow("not_declared");
      const view = createRunCapabilityView({ toolRegistry: restricted, appToolRegistry: getAppToolRegistry(restricted), pluginIds: new Set([plugin.manifest.id]) }, plugin.manifest.id);
      expect(view.tools.has("SaveDocument")).toBe(false);
      expect(view.tools.has("UnmappedTool")).toBe(true);
      expect(view.appTools?.has("UnmappedTool")).toBe(false);
      const captured = backend.tools.get("SaveDocument")!;
      const execution = {
        scope: { agentId: "a", sessionId: "s", inputId: "i", runId: "r", traceId: "t", cwd: plugin.root, signal: new AbortController().signal },
        tools:new Map([[captured.definition.name,captured]]),
        effects: { requestPermission: async () => ({ status: "denied" }) },
        emit: async () => {}, takeSteeredInputs: async () => [], closeSteering: () => {},
      } as AgentExecutionContext;
      const engine = new QueryEngine({ streamMessage: async function* () { throw new Error("no model for app calls"); } }, restricted,
        { checkTool: async () => ({ action: "allow" }) }, { execute: async () => ({ blocked: false }) } as IHookExecutor, { cwd: plugin.root, sessionId: "s" });
      const original = await engine.executeTool({ type: "tool_use", id: "save", name: captured.definition.name, input: { value: "hello" } }, { execution });
      expect(original.executionState).toBe("completed");
      const derived = nativeToolResultToAppResult(original);
      expect(derived.result.structuredContent).toMatchObject({ calls: 1, value: "hello", cwd: plugin.root, sessionId: "s", hasSignal: true });
      expect(derived.result.structuredContent?.dataDir).toEqual(expect.any(String));
      expect(audits).toHaveLength(1);
      expect(originalCalls).toHaveBeenCalledTimes(1);
      expect(registry.getAll().map(tool => tool.name)).toEqual(["SaveDocument", "UnmappedTool"]);
      expect(listen).not.toHaveBeenCalled(); expect(mcp).not.toHaveBeenCalled();
      activated.host!.generation = "replacement";
      expect(backend.isCurrentTool("SaveDocument")).toBe(false);
      await expect(backend.port.listResources()).rejects.toThrow("backend_changed");
    } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
  });

  it("rejects mappings to builtin/foreign/nonexistent tool names before registration", async () => {
    const plugin = await fixture("ForeignTool");
    const registry = new ToolRegistry();
    registry.register({ name: "ForeignTool", description: "foreign", inputSchema: {}, execute: async () => ({ content: [] }) }, { kind: "plugin", id: "other" });
    const cleanups: Array<() => Promise<void> | void> = [];
    const activation = await activateNativePluginTools(plugin, { cwd: plugin.root, toolRegistry: registry, addCleanup: cleanup => cleanups.push(cleanup) });
    try { expect(activation.state).toBe("error"); expect(registry.getAll().map(tool => tool.name)).toEqual(["ForeignTool"]); }
    finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
  });
});
