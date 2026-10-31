import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutionContext, AgentPermissionRequest, ToolDefinition } from "@vykor/agent-contracts";
import { QueryEngine, ToolRegistry } from "@vykor/core";
import { PermissionChecker } from "@vykor/permissions";
import { SessionStore } from "@vykor/services";
import { createRunCapabilityView } from "@vykor/agent-runtime";
import { StorePermissionBroker } from "../../../packages/server/src/permissions/permission-broker.js";
import { sessionPermissionRequest } from "../../../packages/server/src/permissions/session-approval.js";
import { createBrowserTool } from "../../../packages/server/src/application/browser-tools/browser-tool.js";
import { createBrowserDeveloperTool } from "../../../packages/server/src/application/browser-tools/browser-developer-tool.js";
import type { BrowserHost } from "../../../packages/server/src/application/browser-tools/browser-host.js";
import { createPluginInstallTool } from "../../../packages/server/src/application/plugins/plugin-install-tool.js";
import { createMcpConfigureTool } from "../../../packages/server/src/application/mcp/mcp-configure-tool.js";
import { McpConfigApplicationService } from "../../../packages/server/src/application/mcp/mcp-config-application-service.js";
import type { PluginService } from "../../../packages/server/src/application/settings-api.js";
import type { Settings } from "@vykor/host-config";
import { askUserTool } from "../../../packages/tools/src/meta/ask-user.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

function fixture(mode: "ask" | "full_access", options: {
  deniedTools?: string[];
  extraTools?: ToolDefinition[];
  omittedBinding?: string;
  toolTimeoutMs?: number;
  manualReplies?: boolean;
  replyDecision?: "once" | "session";
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "vykor-full-access-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SessionStore({ path: join(directory, "session.db") });
  cleanup.push(() => store.close());
  store.sessions.create({ id: "session", cwd: directory, model: "offline", metadata: {
    runtime: { model: "offline", apiFormat: "openai", approvalMode: mode, workMode: "execute" },
  } });
  const prompt = store.conversationTransactions.admitPrompt({ id: "input", sessionId: "session", content: "Complete the fixture operations." });
  store.runs.createRun({ id: "run", sessionId: "session", inputId: prompt.id });
  store.runs.updateRun("run", { status: "running" });
  const broker = new StorePermissionBroker({ permissions: store.permissions,
    getSession: id => store.sessions.get(id), latestEventSeq: () => store.conversations.latestEventSeq() });
  const registry = new ToolRegistry();
  const browserOperations: string[] = [];
  const host: BrowserHost = {
    async execute({ action, approve }) {
      if (!await approve("Allow this site and action?")) throw new Error("Site permission denied");
      browserOperations.push(action.action);
      return { url: "https://example.test", title: "Fixture", pageText: "Ready" };
    },
    async executeDeveloper({ action, approveOrigin, approveDeveloper }) {
      if (!await approveOrigin("Allow this origin?")) throw new Error("Origin denied");
      if (!await approveDeveloper("Allow this inspection?")) throw new Error("Inspection denied");
      browserOperations.push(action.action);
      return { action: action.action, url: "https://example.test", data: { observed: true }, truncated: false };
    },
  };
  registry.register(createBrowserTool(host, async () => "unused.png", async () => ({})), { kind: "builtin" });
  registry.register(createBrowserDeveloperTool(host), { kind: "builtin" });
  registry.register(askUserTool, { kind: "builtin" });
  for (const tool of options.extraTools ?? []) registry.register(tool, { kind: "builtin" });
  const bindings = new Map(createRunCapabilityView({ toolRegistry: registry }).tools);
  if (options.omittedBinding) bindings.delete(options.omittedBinding);
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  const requests: AgentPermissionRequest[] = [];
  const questions: string[] = [];
  const execution: AgentExecutionContext = {
    scope: { agentId: "session", sessionId: "session", runId: "run", inputId: "input", cwd: directory,
      traceId: "trace", signal: controller.signal },
    tools: bindings,
    effects: { askUserPrompt: async question => { questions.push(question); return "Chosen answer"; },
      requestPermission: async (request, scope) => {
      requests.push(request);
      const waiting = broker.ask(sessionPermissionRequest({ store, request, context: scope }));
      // A responsive human surrogate prevents the broken implementation from
      // hanging. The test still fails if any ordinary request reaches this host.
      if (options.manualReplies !== false) queueMicrotask(() => {
        for (const pending of store.permissions.list({ status: "pending" })) {
          broker.reply({ requestId: pending.id, status: "approved", decision: options.replyDecision ?? "once" });
        }
      });
      return waiting;
    } },
    children: { hasChildAgent: () => false, spawnChildAgent: async () => { throw new Error("unexpected child"); },
      sendChildInput: async () => { throw new Error("unexpected child"); }, interruptChildAgent: async () => {},
      awaitChildAgent: async () => { throw new Error("unexpected child"); } },
    emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {}, observeInvocation() {},
  };
  const checker = new PermissionChecker({ mode, deniedTools: options.deniedTools,
    // The site/developer confirmation remains required even if the tool itself
    // has an ordinary allowance in the non-full-access mode.
    autoApproveTools: ["Browser", "BrowserDeveloper", ...(options.extraTools ?? []).map(tool => tool.name)],
    cwd: directory });
  const engine = new QueryEngine({ async *streamMessage() { throw new Error("unexpected model request"); } }, registry,
    checker, { register() {}, execute: async () => ({ blocked: false }) }, {
      cwd: directory, sessionId: "session", toolTimeoutMs: options.toolTimeoutMs,
    });
  let counter = 0;
  const execute = (name: string, input: Record<string, unknown>) => engine.executeTool({
    type: "tool_use", id: `call-${++counter}`, name, input,
  }, { execution });
  return { execute, store, broker, requests, questions, browserOperations, controller, checker };
}

describe("full access uses one authorization policy for tool and operation approvals", () => {
  it("continues across browser sites and repeated developer inspections without persisted approvals", async () => {
    const f = fixture("full_access");
    for (const url of ["https://one.test", "https://two.test"]) {
      expect(await f.execute("Browser", { action: "navigate", url })).toMatchObject({ executionState: "completed" });
      expect(await f.execute("BrowserDeveloper", { action: "inspect_dom" })).toMatchObject({ executionState: "completed" });
    }
    expect(f.browserOperations).toEqual(["navigate", "inspect_dom", "navigate", "inspect_dom"]);
    expect(f.requests).toEqual([]);
    expect(f.store.permissions.list()).toEqual([]);
  });

  it("keeps concrete browser confirmations in ordinary approval mode", async () => {
    const f = fixture("ask");
    const browser = await f.execute("Browser", { action: "navigate", url: "https://example.test" });
    expect(browser.isError, JSON.stringify(browser)).not.toBe(true);
    const developer = await f.execute("BrowserDeveloper", { action: "inspect_dom" });
    expect(developer.isError, JSON.stringify(developer)).not.toBe(true);
    expect(f.requests.map(request => request.toolName)).toEqual(["Browser", "Browser", "BrowserDeveloper"]);
    expect(f.requests.every(request => request.toolSource === "builtin")).toBe(true);
    expect(f.browserOperations).toEqual(["navigate", "inspect_dom"]);
  });

  it("keeps concrete confirmations separate from reusable tool-wide grants through the real session host", async () => {
    const f = fixture("ask", { replyDecision: "session" });
    const generic = f.broker.ask({ sessionId: "session", toolName: "Browser" });
    const pending = f.store.permissions.list({ status: "pending" })[0]!;
    f.broker.reply({ requestId: pending.id, status: "approved", decision: "session" });
    await generic;
    for (const url of ["https://one.test", "https://two.test"]) {
      const result = await f.execute("Browser", { action: "navigate", url });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    }
    const operations = f.store.permissions.list().filter(request => request.payload.confirmation === "once");
    expect(operations).toHaveLength(2);
    expect(operations.every(request => request.decision === "once" && !request.payload.reusedApprovalRequestId)).toBe(true);
    expect(f.requests).toHaveLength(2);
    expect(f.browserOperations).toEqual(["navigate", "navigate"]);
  });

  it.each([
    ["denied", "context"], ["denied", "agent_effect"],
    ["not_in_run", "context"], ["not_in_run", "agent_effect"],
    ["unknown", "context"], ["unknown", "agent_effect"],
  ] as const)("does not let a %s target bypass policy through %s", async (restriction, route) => {
    const proxy: ToolDefinition = { name: "Proxy", description: "Request an operation", inputSchema: { type: "object" },
      execute: async (_input, context) => {
        const request = { toolName: restriction === "unknown" ? "Unknown" : "Browser", toolSource: "builtin", input: { action: "inspect" } };
        const decision = route === "context" ? await context.requestPermission!(request)
          : await context.agent!.effects.requestPermission(request, context.agent!.scope);
        return { content: [{ type: "text", text: decision.status }], isError: decision.status !== "approved" };
      } };
    const f = fixture("full_access", { extraTools: [proxy],
      ...(restriction === "denied" ? { deniedTools: ["Browser"] } : { omittedBinding: "Browser" }) });
    expect(await f.execute("Proxy", {})).toMatchObject({ isError: true, content: [{ type: "text", text: "denied" }] });
    expect(f.requests).toEqual([]);
    expect(f.browserOperations).toEqual([]);
  });

  it("continues through exact plugin and MCP configuration operations using the same policy", async () => {
    const installed: Array<{ digest: string; permissions: string[] }> = [];
    const plugins: PluginService = {
      list: async () => ({ plugins: [], warnings: [] }), setEnabled: async () => ({ message: "unused" }),
      previewArchive: async () => ({ archiveDigest: "exact-preview-digest",
        identity: { id: "fixture.plugin", name: "fixture", version: "1.0.0" },
        requestedPermissions: ["filesystem:workspace:read"], approvalRequired: true, inventory: {}, diagnostics: [] }),
      installArchive: async input => {
        installed.push({ digest: input.expectedArchiveDigest, permissions: input.approvedPermissions });
        return { message: "Installed exact fixture" };
      },
    };
    let settings = { model: "offline", permission: { mode: "ask" }, mcpServers: {} } as Settings;
    const service = new McpConfigApplicationService({ loadSettings: async () => settings,
      updateSettings: async change => (settings = await change(settings)), snapshot: async () => ({ servers: [] }) });
    const f = fixture("full_access", { extraTools: [
      createPluginInstallTool(plugins, async () => {}), createMcpConfigureTool(service, "session"),
    ] });
    const plugin = await f.execute("PluginInstall", { source: "archive", path: "fixture.zip" });
    expect(plugin.isError).not.toBe(true);
    const config = { type: "http", url: "https://mcp.example.test" };
    expect((await f.execute("McpConfigure", { action: "add", name: "fixture", config })).isError).not.toBe(true);
    expect((await f.execute("Browser", { action: "inspect" })).isError).not.toBe(true);
    expect(installed).toEqual([{ digest: "exact-preview-digest", permissions: ["filesystem:workspace:read"] }]);
    expect(settings.mcpServers?.fixture).toEqual(config);
    expect(f.requests).toEqual([]);
    expect(f.questions).toEqual([]);
    expect(f.store.permissions.list()).toEqual([]);
  });

  it("does not manufacture an answer to a real user question in full access", async () => {
    const f = fixture("full_access");
    expect(await f.execute("AskUser", { question: "Which account should I use?" })).toMatchObject({
      content: [{ type: "text", text: "Chosen answer" }],
    });
    expect(f.questions).toEqual(["Which account should I use?"]);
    expect(f.requests).toEqual([]);
  });

  it.each(["context", "agent_effect"] as const)("cancels an internal %s approval when the actual tool invocation times out", async route => {
    const sideEffects: string[] = [];
    const proxy: ToolDefinition = { name: "Proxy", description: "A bounded operation", inputSchema: { type: "object" },
      execute: async (_input, context) => {
        const request = { toolName: "Browser", input: { action: "inspect" } };
        const approval = route === "context" ? await context.requestPermission!(request)
          : await context.agent!.effects.requestPermission(request, context.agent!.scope);
        if (approval.status === "approved") sideEffects.push("acted");
        return { content: [] };
      } };
    const f = fixture("ask", { extraTools: [proxy], toolTimeoutMs: 100, manualReplies: false });
    const result = await f.execute("Proxy", {});
    expect(result, JSON.stringify(result)).toMatchObject({ isError: true, failureKind: "timeout" });
    expect(f.store.permissions.list()).toMatchObject([{ toolName: "Browser", status: "expired" }]);
    const request = f.store.permissions.list()[0]!;
    expect(() => f.broker.reply({ requestId: request.id, status: "approved", decision: "once" })).toThrow(/already resolved/);
    expect(sideEffects).toEqual([]);
  });
});
