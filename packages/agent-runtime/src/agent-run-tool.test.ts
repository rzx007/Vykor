import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEventInput, type AgentRunScope, type Settings, type ToolDefinition } from "@vykor/core";
import { installLocalNativePlugin } from "@vykor/plugins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureNativeUiLogs } from "../test-helpers/native-ui-logs.js";
import { createDefaultNodeAgent } from "./default-agent.js";
import { type VykorAgent } from "./agent.js";

const roots: string[] = [];
let logs: ReturnType<typeof captureNativeUiLogs>;
beforeEach(() => { logs = captureNativeUiLogs({ pluginId: "test.native-ui", sessionId: "session-ui",
  toolNames: ["NativeAction"], inputSummaries: ["{}", "{wait:boolean}"], diagnostics: [
    "Plugin UI installation changed since discovery.", "Plugin UI component 'panel' requires its own active Native tools.",
  ] }); });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  logs.verify();
});
const settings: Settings = {
  apiFormat: "openai", model: "never-requested", maxTurns: 1,
  permission: { mode: "full_auto" }, sandbox: { enabled: false }, memory: { enabled: false },
};
const pluginId = "test.native-ui";
async function fixture(actionTool = "NativeAction", link = false, driftOnActivation = false, askPermission = false) {
  const root = mkdtempSync(join(tmpdir(), "vykor-ui-runtime-"));
  roots.push(root);
  vi.stubEnv("VYKOR_CONFIG_DIR", join(root, "config"));
  const source = join(root, "source");
  mkdirSync(join(source, ".vykor-plugin"), { recursive: true });
  mkdirSync(join(source, "ui"));
  mkdirSync(join(source, "tools"));
  writeFileSync(join(source, ".vykor-plugin/plugin.json"), JSON.stringify({
    schemaVersion: 1, id: pluginId, name: "native-ui", version: "1.0.0",
    components: { tools: ["./tools/index.mjs"], ui: ["./ui/manifest.json"] },
  }));
  writeFileSync(join(source, "ui/manifest.json"), JSON.stringify({ schemaVersion: 1, components: [{
    id: "panel", title: "Panel", entry: "./ui/panel.html", surfaces: ["tool-result"],
    actions: [{ id: "run", label: "Run", tool: actionTool, completion: "keep-open" }],
  }] }));
  writeFileSync(join(source, "ui/panel.html"), "<p>Original</p>");
  writeFileSync(join(source, "tools/index.mjs"), `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    export function registerTools() {
      ${driftOnActivation ? 'writeFileSync(new URL("../ui/panel.html", import.meta.url), "changed during activation");' : ""}
      return [{ name: "NativeAction", description: "native fixture",
      inputSchema: { type: "object", properties: { wait: { type: "boolean" } }, additionalProperties: false },
      async invoke(input, context) {
        writeFileSync(join(context.cwd, "native-started"), "started");
        if (input.wait) await new Promise((resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
        return { content: [{ type: "text", text: JSON.stringify({ cwd: context.cwd, sessionId: context.sessionId, pid: process.pid }) }] };
      }
    }]; }
  `);
  const installed = await installLocalNativePlugin({ sourcePath: source, cwd: root, scope: "user", link,
    approvedPermissions: ["ui:render", "ui:invoke-own-tools"] });
  expect(installed.status).toBe("installed");
  if (installed.status !== "installed") throw new Error("fixture install failed");
  const modelCalls: unknown[] = [];
  const normalEvents: unknown[] = [];
  const permissionScopes: AgentRunScope[] = [];
  let nativeDefinition: ToolDefinition | undefined;
  const agent = await createDefaultNodeAgent({ cwd: root, sessionId: "session-ui",
    settings: askPermission ? { ...settings, permission: { mode: "default" } } : settings,
    capabilityOverrides: { terminal: false, memory: false },
    client: { async *streamMessage(input) { modelCalls.push(input); throw new Error("Unexpected model request"); } },
    onEvent: event => { normalEvents.push(event); },
    extensions: [{ setup: context => { nativeDefinition = context.toolRegistry.get("NativeAction"); } }],
    effects: { requestPermission: async (_request, scope) => { permissionScopes.push(scope); return { status: "denied" }; } },
  });
  return { root, agent, installed: installed.record, modelCalls, normalEvents, permissionScopes, nativeDefinition: nativeDefinition! };
}
function scope(agent: VykorAgent): AgentRunScope {
  return { agentId: agent.id, sessionId: agent.id, runId: "ui-run", inputId: "ui-run",
    traceId: "trace-ui", cwd: "forged-cwd", signal: new AbortController().signal };
}
const call = { type: "tool_use" as const, id: "ui-call", name: "NativeAction", input: {} };

describe("captured Native UI and independent Agent tools", () => {
  it.each([false, true])("captures approved UI provenance without exposing it to baseline (linked=%s)", async link => {
    const { agent, installed } = await fixture("NativeAction", link);
    try {
      const view = agent.createRunCapabilityView(pluginId);
      const ui = view.pluginUi?.get(`${pluginId}:panel`);
      expect(ui).toMatchObject({ pluginId, pluginVersion: "1.0.0", componentId: "panel", root: installed.cachePath });
      expect(ui?.pluginDigest).toMatch(/^[a-f0-9]{64}$/);
      if (!link) expect(ui?.pluginDigest).toBe(installed.behaviorDigest);
      expect(ui?.actionTools[0]?.source).toEqual({ kind: "plugin", id: pluginId });
      expect(agent.createRunCapabilityView().pluginUi?.size).toBe(0);
      expect((view.pluginUi as Map<string, unknown>).set).toBeUndefined();
      expect(() => { ui!.definition.actions[0]!.tool = "Read"; }).toThrow();
      expect(() => { ui!.actionTools[0]!.definition.description = "changed"; }).toThrow();
      writeFileSync(join(installed.cachePath, "ui/panel.html"), "<p>Changed after capture</p>");
      expect(agent.createRunCapabilityView(pluginId).pluginUi?.get(`${pluginId}:panel`)?.componentDigest).toBe(ui?.componentDigest);
    } finally { await agent.close(); }
  });

  it("disables UI after installation drift during Native activation but preserves the business tool", async () => {
    const { agent } = await fixture("NativeAction", false, true);
    try {
      const view = agent.createRunCapabilityView(pluginId);
      expect(view.tools.has("NativeAction")).toBe(true);
      expect(view.pluginUi?.size).toBe(0);
      expect(logs.records).toContain("[plugins] test.native-ui: Plugin UI installation changed since discovery.\n");
    } finally { await agent.close(); }
  });

  it("never redirects an old UI to an in-memory replacement or caller-provided invocation", async () => {
    const { agent, nativeDefinition } = await fixture();
    try {
      const captured = agent.createRunCapabilityView(pluginId);
      let redirected = false;
      const malicious = async () => { redirected = true; return { content: [] }; };
      const forged = { ...captured, tools: new Map([["NativeAction", { ...captured.tools.get("NativeAction")!, invoke: malicious }]]) };
      const result = await agent.runTool(call, { capabilityView: forged, scope: scope(agent) });
      expect(result.executionState).toBe("completed");
      expect(redirected).toBe(false);
      nativeDefinition.execute = malicious;
      expect(agent.createRunCapabilityView(pluginId).pluginUi?.size).toBe(0);
      await expect(agent.runTool(call, { capabilityView: captured, scope: scope(agent) })).rejects.toThrow(/Native|UI/i);
      expect(redirected).toBe(false);
    } finally { await agent.close(); }
  });

  it.each(["Read", "MissingNative"])("withdraws invalid UI action %s while keeping Native tools usable", async target => {
    const { agent } = await fixture(target);
    try {
      const view = agent.createRunCapabilityView(pluginId);
      expect(view.tools.has("NativeAction")).toBe(true);
      expect(view.pluginUi?.size).toBe(0);
    } finally { await agent.close(); }
  });

  it("executes a real Native child with Agent cwd/session and reliable independent events, without history or models", async () => {
    const { agent, root, modelCalls, normalEvents } = await fixture();
    const events: AgentEventInput[] = [];
    try {
      const result = await agent.runTool(call, { capabilityView: agent.createRunCapabilityView(pluginId), scope: scope(agent),
        onToolEvent: async event => { events.push(event); } });
      expect(result.executionState).toBe("completed");
      const context = JSON.parse((result.content[0] as { text: string }).text);
      expect(context).toMatchObject({ cwd: root, sessionId: agent.id });
      expect(context.pid).not.toBe(process.pid);
      expect(events.some(event => event.type === "tool.completed")).toBe(true);
      expect(events.some(event => event.type === "input.accepted")).toBe(false);
      expect(normalEvents).toEqual([]);
      expect(modelCalls).toEqual([]);
      expect(agent.getHistory()).toEqual([]);
      expect(agent.state).toBe("idle");
      expect(logs.records.filter(record => record.startsWith("[native-tool:audit]"))).toHaveLength(1);
    } finally { await agent.close(); }
  });

  it("rejects scope mismatch and fails before invocation when the reliable running sink rejects", async () => {
    const { agent, root } = await fixture();
    try {
      const capabilityView = agent.createRunCapabilityView(pluginId);
      await expect(agent.runTool(call, { capabilityView, scope: { ...scope(agent), sessionId: "other" } })).rejects.toThrow(/scope|session/i);
      const events: AgentEventInput[] = [];
      await expect(agent.runTool(call, { capabilityView, scope: scope(agent), onToolEvent: async event => {
        events.push(event);
        if (event.type === "domain.event" && (event.data.payload as { phase?: string }).phase === "running") throw new Error("durable sink failed");
      } })).rejects.toThrow("durable sink failed");
      expect(events.some(event => event.type === "domain.event"
        && (event.data.payload as { executionState?: string }).executionState === "not_started")).toBe(true);
      expect(agent.state).toBe("idle");
      expect(existsSync(join(root, "native-started"))).toBe(false);
    } finally { await agent.close(); }
  });

  it("uses actual Agent permission effects and attributes the operation to its stable Run ID", async () => {
    const { agent, root, permissionScopes } = await fixture("NativeAction", false, false, true);
    try {
      const result = await agent.runTool(call, { capabilityView: agent.createRunCapabilityView(pluginId), scope: { ...scope(agent), inputId: "forged-input" } });
      expect(result).toMatchObject({ isError: true, failureKind: "permission", executionState: "not_started" });
      expect(permissionScopes).toHaveLength(1);
      expect(permissionScopes[0]).toMatchObject({ agentId: agent.id, sessionId: agent.id, cwd: root, inputId: "ui-run", runId: "ui-run" });
      expect(existsSync(join(root, "native-started"))).toBe(false);
    } finally { await agent.close(); }
  });

  it("does not report success when durable completion fails after a real tool side effect", async () => {
    const { agent, root } = await fixture();
    try {
      await expect(agent.runTool(call, { capabilityView: agent.createRunCapabilityView(pluginId), scope: scope(agent),
        onToolEvent: async event => { if (event.type === "tool.completed") throw new Error("completion persistence failed"); },
      })).rejects.toThrow("completion persistence failed");
      expect(existsSync(join(root, "native-started"))).toBe(true);
      expect(agent.state).toBe("idle");
    } finally { await agent.close(); }
  });

  it("rejects baseline/builtin and uncaptured calls before events or side effects", async () => {
    const { agent, modelCalls } = await fixture();
    const events: AgentEventInput[] = [];
    try {
      for (const [view, name] of [[agent.createRunCapabilityView(), "Read"],
        [agent.createRunCapabilityView(pluginId), "Read"], [agent.createRunCapabilityView(pluginId), "MissingNative"]] as const) {
        await expect(agent.runTool({ ...call, name }, { capabilityView: view, scope: scope(agent),
          onToolEvent: async event => { events.push(event); } })).rejects.toThrow(/Native|UI|captured/i);
      }
      expect(events).toEqual([]);
      expect(modelCalls).toEqual([]);
    } finally { await agent.close(); }
  });

  it.each(["close", "signal"])("%s cancels Native work and preserves Agent mutual exclusion", async cancellation => {
    const { agent, root } = await fixture();
    const controller = new AbortController();
    let running!: () => void;
    const started = new Promise<void>(resolve => { running = resolve; });
    try {
      const pending = agent.runTool({ ...call, input: { wait: true } }, { capabilityView: agent.createRunCapabilityView(pluginId),
        scope: scope(agent), signal: controller.signal, onToolEvent: async event => {
          if (event.type === "domain.event" && (event.data.payload as { phase?: string }).phase === "running") running();
        } });
      await started;
      await vi.waitFor(() => expect(existsSync(join(root, "native-started"))).toBe(true));
      expect(() => agent.submitMessage("no admission")).toThrow(/maintaining|running/);
      expect(() => agent.compact()).toThrow(/maintaining|running/);
      await expect(agent.runTool(call, { capabilityView: agent.createRunCapabilityView(pluginId), scope: scope(agent) })).rejects.toThrow(/maintaining|running/);
      if (cancellation === "close") await agent.close(); else controller.abort("cancel UI action");
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.executionState).toBe("unknown");
      expect(agent.state).toBe(cancellation === "close" ? "closed" : "idle");
    } finally { await agent.close(); }
  });
});
