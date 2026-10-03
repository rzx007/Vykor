import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureNativeUiLogs } from "../../../../../agent-runtime/test-helpers/native-ui-logs.js";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import { installLocalNativePlugin } from "@vykor/plugins";
import { readPluginUiInstance } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { SessionPluginUiService, type PluginUiCurrentState } from "../session-plugin-ui-service.js";
import { SessionRunEngine } from "../session-run-engine.js";
import { SessionOperationRunner } from "../session-operation-runner.js";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";
import { buildAgentTranscript } from "../../agent/agent-transcript.js";
import { writeSessionExport } from "../../../session/export-session.js";
import { SessionMaintenanceService } from "../session-maintenance-service.js";

const cleanups: (() => void | Promise<void>)[] = [];
let logs: ReturnType<typeof captureNativeUiLogs>;
beforeEach(() => { logs = captureNativeUiLogs({ pluginId: "test.ui-actions", sessionId: "session-ui",
  toolNames: ["NativeAction"], inputSummaries: ["{}", "{wait:boolean}", "{value:string(3)}", "{value:string(8)}"] }); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); logs.verify(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const pluginId = "test.ui-actions";
async function harness(denyPermission = false, resultMode: "valid" | "malformed" | "foreign" | "error" = "valid") {
  const root = mkdtempSync(join(tmpdir(), "vykor-ui-actions-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv("VYKOR_CONFIG_DIR", join(root, "config"));
  const source = join(root, "source");
  mkdirSync(join(source, ".vykor-plugin"), { recursive: true });
  mkdirSync(join(source, "ui")); mkdirSync(join(source, "tools"));
  writeFileSync(join(source, ".vykor-plugin/plugin.json"), JSON.stringify({ schemaVersion: 1, id: pluginId,
    name: "ui-actions", version: "1.0.0", components: { tools: ["./tools/index.mjs"], ui: ["./ui/manifest.json"] } }));
  writeFileSync(join(source, "ui/manifest.json"), JSON.stringify({ schemaVersion: 1, components: [{
    id: "panel", title: "Panel", entry: "./ui/panel.html", surfaces: ["tool-result"], actions: [
      { id: "run", label: "Apply", tool: "NativeAction", completion: "keep-open" },
      { id: "resolve", label: "Finish", tool: "NativeAction", completion: "resolve" },
    ],
  }] }));
  writeFileSync(join(source, "ui/panel.html"), "<p>Panel</p>");
  writeFileSync(join(source, "tools/index.mjs"), `
    import { readFileSync, writeFileSync, existsSync } from "node:fs";
    import { join } from "node:path";
    export function registerTools() { return [{ name: "NativeAction", description: "native action",
      inputSchema: { type: "object", properties: { wait: { type: "boolean" }, value: { type: "string" } }, additionalProperties: false },
      async invoke(input, context) {
        const file = join(context.cwd, "effects");
        writeFileSync(file, String((existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1));
        writeFileSync(join(context.cwd, "args"), JSON.stringify(input));
        if (input.wait) await new Promise((resolve, reject) => context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
        return { content: [{ type: "text", text: "Applied " + (input.value ?? "once") }],
          ${resultMode === "error" ? 'isError: true,' : ""}
          metadata: { ui: { schemaVersion: 1, componentId: ${JSON.stringify(resultMode === "foreign" ? "other-panel" : "panel")},
            data: ${resultMode === "malformed" ? "[]" : "{ count: 0 }"} } } };
      }
    }]; }
  `);
  const installed = await installLocalNativePlugin({ sourcePath: source, cwd: root, scope: "user",
    approvedPermissions: ["ui:render", "ui:invoke-own-tools"] });
  expect(installed.status).toBe("installed");
  const agent = await createDefaultNodeAgent({ cwd: root, sessionId: "session-ui", settings: {
    apiFormat: "openai", model: "never", maxTurns: 1, permission: { mode: denyPermission ? "default" : "full_auto" },
    sandbox: { enabled: false }, memory: { enabled: false },
  }, capabilityOverrides: { terminal: false, memory: false },
    client: { async *streamMessage() { throw new Error("UI actions must never request a model"); } },
    effects: { requestPermission: async () => ({ status: "denied" }) } });
  cleanups.push(() => agent.close());
  const path = join(root, "session.db");
  let store = new SessionStore({ path }); cleanups.push(() => store.close());
  const session = store.sessions.create({ id: agent.id, cwd: root, model: "never" });
  store.runs.createRun({ id: "source-run", sessionId: session.id, metadata: { pluginId } });
  store.runs.updateRun("source-run", { status: "completed" });
  const message = store.conversations.createMessage({ sessionId: session.id, role: "assistant", runId: "source-run" });
  const output = { content: [{ type: "text", text: "One issue" }], executionState: "completed",
    metadata: { ui: { schemaVersion: 1, componentId: "panel", data: { count: 1 } } } };
  const part = store.conversations.upsertMessagePart({ id: "source-call", sessionId: session.id, messageId: message.id,
    type: "tool", status: "completed", toolName: "NativeAction", toolUseId: "source-call", input: {}, output,
    metadata: { executionState: "completed" } });
  const view = agent.createRunCapabilityView(pluginId);
  let current: PluginUiCurrentState = { enabled: true, uiEnabled: true, permissionsApproved: true, snapshot: "valid",
    binding: view.pluginUi!.get(`${pluginId}:panel`)!, runtimeAvailable: true };
  const gate = new DaemonOperationGate();
  const events = { checkpoint: () => 0, publishSince: () => {} };
  let goalsSettled = 0;
  const diagnostics: unknown[] = [];
  const engine = new SessionRunEngine({ events, runExecutor: { execute: async () => { throw new Error("Unexpected model executor"); } },
    execution: { prepareRunExecution: () => true, recoverRejectedSteer: () => "unexpected" }, settleGoalRun: async () => { goalsSettled++; } });
  const operations = new SessionOperationRunner({ sessions: store.sessions, operationGate: gate, events });
  let executor: { execute(runId: string, context: any): Promise<void> } | undefined;
  let acquire: (() => Promise<void>) | undefined;
  const service = new SessionPluginUiService({ store, resolveCurrent: async () => current, diagnose: diagnostic => { diagnostics.push(diagnostic); },
    actions: { operations, engine, acquireSession: async () => { await acquire?.(); return agent; }, execute: (id, context) => executor!.execute(id, context) } });
  service.registerRunView("source-run", view);
  const instance = service.createInstance({ sessionId: session.id, runId: "source-run", partId: part.id,
    toolUseId: part.toolUseId!, toolName: part.toolName!, result: output as any })!;
  store.conversations.upsertMessagePart({ ...part, metadata: { ...part.metadata, pluginUi: instance } });
  return { root, session, service, store, engine, gate, agent, events, instance, output, diagnostics,
    setCurrent: (patch: Partial<PluginUiCurrentState>) => { current = { ...current, ...patch }; },
    setExecutor: (value: typeof executor) => { executor = value; },
    onAcquire: (value: typeof acquire) => { acquire = value; },
    source: () => store.conversations.listMessageParts(session.id).find(p => p.id === part.id)!,
    effects: () => existsSync(join(root, "effects")) ? readFileSync(join(root, "effects"), "utf8") : "0",
    goalsSettled: () => goalsSettled,
    reopen: () => { store.close(); store = new SessionStore({ path }); return store; },
  };
}

describe("durable plugin UI actions", () => {
  it("atomically admits one deterministic Run and rejects changed retries before availability checks", async () => {
    const h = await harness();
    let release!: () => void;
    h.setExecutor({ execute: () => new Promise(resolve => { release = resolve; }) });
    const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: { value: "one" } };
    const first = await h.service.invokeAction(h.session.id, h.instance.instanceId, input);
    const expectedId = "ui_run_" + createHash("sha256").update(JSON.stringify([h.session.id, h.instance.instanceId, input.requestId])).digest("hex");
    expect(first.runId).toBe(expectedId);
    h.setCurrent({ enabled: false });
    expect((await h.service.invokeAction(h.session.id, h.instance.instanceId, input)).runId).toBe(first.runId);
    await expect(h.service.invokeAction(h.session.id, h.instance.instanceId, { ...input, args: { value: "two" } })).rejects.toMatchObject({ code: "plugin_ui_request_conflict" });
    expect(h.store.runs.getRun(first.runId)?.inputId).toBeUndefined();
    expect(h.store.runs.listRunAttempts(first.runId)).toEqual([]);
    expect(h.store.conversations.listInputs(h.session.id)).toEqual([]);
    expect(readPluginUiInstance(h.source().metadata)).toMatchObject({ revision: 2, activeActionRunId: first.runId });
    release(); await h.engine.runtimeBridge.waitForRun(first.runId);
    expect(h.goalsSettled()).toBe(0);
  });

  it("executes the real Native tool once, commits results together, and excludes action history after reopen/fork", async () => {
    const h = await harness();
    const { SessionPluginUiActionExecutor } = await import("../session-plugin-ui-action-executor.js");
    h.setExecutor(new SessionPluginUiActionExecutor({ store: h.store, service: h.service, operationGate: h.gate, events: h.events }));
    const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "resolve", args: { value: "one" } };
    const receipt = await h.service.invokeAction(h.session.id, h.instance.instanceId, input);
    await h.engine.runtimeBridge.waitForRun(receipt.runId);
    expect(h.effects()).toBe("1");
    expect(h.store.runs.getRun(receipt.runId)).toMatchObject({ status: "completed", metadata: { uiAction: { executionState: "completed" } } });
    expect(h.store.conversations.listMessageParts(h.session.id).find(part => part.id !== "source-call" && part.type === "tool")?.metadata)
      .toMatchObject({ toolProgress: null, outcome: "completed", executionState: "completed" });
    expect(readPluginUiInstance(h.source().metadata)).toMatchObject({ status: "resolved", revision: 3, data: { count: 0 }, lastActionRunId: receipt.runId });
    expect(readPluginUiInstance(h.source().metadata)?.activeActionRunId).toBeUndefined();
    expect(h.source().output).toEqual(h.output);
    expect(h.agent.getHistory()).toEqual([]);
    expect(h.goalsSettled()).toBe(0);
    const exported = await writeSessionExport({ session: h.session, inputs: [], runs: h.store.runs.listRuns(h.session.id),
      messages: h.store.conversations.listMessages(h.session.id), parts: h.store.conversations.listMessageParts(h.session.id),
      format: "json", filename: join(h.root, "completed-export.json") });
    const exportedMessages = JSON.parse(readFileSync(exported.filepath, "utf8")).messages;
    expect(exportedMessages.find((message: any) => message.content?.includes("用户在插件中执行操作"))?.metadata)
      .toEqual({ presentation: { kind: "plugin_ui_action" } });
    h.setCurrent({ enabled: false, snapshot: "changed" });
    expect((await h.service.invokeAction(h.session.id, h.instance.instanceId, input)).status).toBe("completed");
    expect(h.effects()).toBe("1");
    const store = h.reopen();
    const service = new SessionPluginUiService({ store, resolveCurrent: async () => { throw new Error("offline"); } });
    expect(service.getAction(h.session.id, h.instance.instanceId, input.requestId).status).toBe("completed");
    const transcript = buildAgentTranscript(store.conversations.listMessages(h.session.id), store.conversations.listMessageParts(h.session.id));
    expect(JSON.stringify(transcript)).not.toContain("Applied one");
    const fork = store.conversationTransactions.forkSessionWithHistory({ sourceSessionId: h.session.id, session: { cwd: h.root, model: "never" } });
    expect(JSON.stringify(buildAgentTranscript(store.conversations.listMessages(fork.id), store.conversations.listMessageParts(fork.id)))).not.toContain("Applied one");
  });

  it("persists before invocation, retains the execution gate lease, and makes active cancellation unknown without replay", async () => {
    const h = await harness();
    const { SessionPluginUiActionExecutor } = await import("../session-plugin-ui-action-executor.js");
    h.setExecutor(new SessionPluginUiActionExecutor({ store: h.store, service: h.service, operationGate: h.gate, events: h.events }));
    const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: { wait: true } };
    const receipt = await h.service.invokeAction(h.session.id, h.instance.instanceId, input);
    await vi.waitFor(() => expect(h.effects()).toBe("1"));
    expect(h.store.runs.getRun(receipt.runId)?.metadata.uiAction).toMatchObject({ executionState: "unknown" });
    expect(h.store.conversations.listMessageParts(h.session.id).find(part => part.id !== "source-call" && part.type === "tool")?.metadata)
      .toMatchObject({ toolProgress: { phase: "running" } });
    expect(h.gate.tryEnterBarrier({ kind: "global" }, () => true)).toBeUndefined();
    expect(h.engine.runtimeBridge.steer(h.session.id, { content: "hello", inputId: "other" } as any)).toEqual({ merged: false });
    await expect(h.service.dismiss(h.session.id, h.instance.instanceId, { requestId: randomUUID(), expectedRevision: 2 })).rejects.toMatchObject({ code: "plugin_ui_session_busy" });
    h.engine.runtimeBridge.interruptRun(h.session.id, receipt.runId, "cancel");
    await h.engine.runtimeBridge.waitForRun(receipt.runId);
    expect(h.store.runs.getRun(receipt.runId)).toMatchObject({ status: "interrupted", metadata: { uiAction: { executionState: "unknown" } } });
    expect((await h.service.invokeAction(h.session.id, h.instance.instanceId, input)).status).toBe("interrupted");
    await expect(h.service.invokeAction(h.session.id, h.instance.instanceId, { ...input, requestId: randomUUID(), expectedRevision: 3 })).rejects.toMatchObject({ code: "plugin_ui_action_unknown" });
    expect(h.effects()).toBe("1");
    expect(await h.service.dismiss(h.session.id, h.instance.instanceId, { requestId: randomUUID(), expectedRevision: 3 })).toMatchObject({ status: "dismissed" });
    const lease = h.gate.tryEnterBarrier({ kind: "global" }, () => true); expect(lease).toBeDefined(); lease!.release();
  });

  it("dismisses idempotently without tools, allowing unknown but rejecting changed revisions", async () => {
    const h = await harness();
    const input = { requestId: randomUUID(), expectedRevision: 1 };
    const dismissed = await h.service.dismiss(h.session.id, h.instance.instanceId, input);
    expect(dismissed).toMatchObject({ status: "dismissed", revision: 2, data: { count: 1 } });
    expect(await h.service.dismiss(h.session.id, h.instance.instanceId, input)).toEqual(dismissed);
    await expect(h.service.dismiss(h.session.id, h.instance.instanceId, { ...input, expectedRevision: 2 })).rejects.toMatchObject({ code: "plugin_ui_request_conflict" });
    expect(h.effects()).toBe("0");
  });

  it.each(["pending", "running-before-tool", "running-after-tool"])("recovers %s from reopened SQLite without inventing an invocation", async phase => {
    const h = await harness(); h.setExecutor({ execute: async () => {} });
    const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: {} };
    const receipt = await h.service.invokeAction(h.session.id, h.instance.instanceId, input);
    await h.engine.runtimeBridge.waitForRun(receipt.runId);
    const saved = h.store.runs.getRun(receipt.runId)!;
    if (phase !== "pending") h.store.runs.updateRun(receipt.runId, { status: "running", metadata: {
      uiAction: { ...(saved.metadata.uiAction as object), executionState: phase === "running-after-tool" ? "unknown" : "not_started" },
    } });
    const store = h.reopen();
    const service = new SessionPluginUiService({ store, resolveCurrent: async () => { throw new Error("no runtime during recovery"); } });
    service.recover();
    expect(store.runs.getRun(receipt.runId)).toMatchObject({ status: "interrupted", metadata: { uiAction: {
      executionState: phase === "running-after-tool" ? "unknown" : "not_started",
    } } });
    const instance = readPluginUiInstance(store.conversations.listMessageParts(h.session.id).find(p => p.id === "source-call")!.metadata)!;
    expect(instance.activeActionRunId).toBeUndefined();
    expect(instance.lastActionRunId).toBe(receipt.runId);
    expect(h.effects()).toBe("0");
  });

  it("derives bounded external-data summaries from durable actions since the previous model Run", async () => {
    const h = await harness(); h.setExecutor({ execute: async () => {} });
    const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: {} };
    const admitted = await h.service.invokeAction(h.session.id, h.instance.instanceId, input);
    await h.engine.runtimeBridge.waitForRun(admitted.runId);
    h.service.settleAction(admitted.runId, "failed");
    const template = h.store.runs.getRun(admitted.runId)!;
    // Ordering is deliberately explicit so same-millisecond timestamps cannot hide actions.
    for (let index = 0; index < 10; index++) {
      const id = `summary-${index}`;
      const toolUseId = `summary-tool-${index}`;
      h.store.runs.createRun({ id, sessionId: h.session.id, metadata: { uiAction: { ...(template.metadata.uiAction as object),
        requestId: randomUUID(), toolUseId, label: `Action ${index}`, executionState: index === 9 ? "unknown" : "completed" } } });
      const message = h.store.conversations.createMessage({ sessionId: h.session.id, runId: id, role: "assistant", metadata: { presentation: { kind: "plugin_ui_action" } } });
      h.store.conversations.upsertMessagePart({ id: toolUseId, sessionId: h.session.id, messageId: message.id, type: "tool", status: "completed",
        toolUseId, toolName: "NativeAction", output: { content: [{ type: "text", text: `result-${index} ` + "😀".repeat(2200) }] } });
      h.store.runs.updateRun(id, { status: index === 9 ? "interrupted" : "completed" });
    }
    const current = h.store.runs.createRun({ id: "next-model", sessionId: h.session.id });
    const summary = h.service.summarizeForInput(h.session.id, current.id);
    expect(Array.from(summary).length).toBeLessThanOrEqual(8000);
    expect(summary).toContain("外部工具数据");
    expect(summary).toContain("summary-9");
    expect(summary).toContain("unknown");
    expect(summary).not.toContain("summary-1\"");
    expect((summary.match(/"runId"/g) ?? []).length).toBe(8);
    expect(summary).not.toContain("�");
    h.store.runs.updateRun(current.id, { status: "completed" });
    h.store.runs.createRun({ id: "later-model", sessionId: h.session.id });
    expect(h.service.summarizeForInput(h.session.id, "later-model")).toBe("");
  });

  it("keeps same-millisecond summary boundaries and last-eight admission order after SQLite reopen", async () => {
    const h = await harness(); h.setExecutor({ execute: async () => {} });
    const admitted = await h.service.invokeAction(h.session.id, h.instance.instanceId, {
      requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: {},
    });
    await h.engine.runtimeBridge.waitForRun(admitted.runId);
    h.service.settleAction(admitted.runId, "failed");
    const template = h.store.runs.getRun(admitted.runId)!.metadata.uiAction as object;
    vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    const addAction = (id: string) => {
      h.store.runs.createRun({ id, sessionId: h.session.id, metadata: { uiAction: {
        ...template, requestId: randomUUID(), toolUseId: `tool-${id}`, executionState: "completed",
      } } });
      h.store.runs.updateRun(id, { status: "completed" });
    };
    addAction("z-old-action");
    h.store.runs.createRun({ id: "m-model-boundary", sessionId: h.session.id });
    h.store.runs.updateRun("m-model-boundary", { status: "completed" });
    const ids = ["z-new-0", "a-new-1", "y-new-2", "b-new-3", "x-new-4", "c-new-5", "w-new-6", "d-new-7", "v-new-8", "e-new-9"];
    for (const id of ids) addAction(id);
    h.store.runs.createRun({ id: "n-current-model", sessionId: h.session.id });
    const reopened = h.reopen();
    expect(reopened.runs.listRuns(h.session.id).filter(run => run.createdAt === 2_000_000_000_000)).toHaveLength(13);
    const service = new SessionPluginUiService({ store: reopened, resolveCurrent: async () => { throw new Error("offline"); } });
    const summary = service.summarizeForInput(h.session.id, "n-current-model");
    expect(summary).not.toContain("z-old-action");
    expect(summary.split("\n").slice(1).map(line => JSON.parse(line).runId))
      .toEqual(["y-new-2", "b-new-3", "x-new-4", "c-new-5", "w-new-6", "d-new-7", "v-new-8", "e-new-9"]);
  });

  it.each(["valid", "malformed", "foreign", "error"] as const)("preserves the real Native %s result while guarding UI data updates", async mode => {
    const h = await harness(false, mode);
    const { SessionPluginUiActionExecutor } = await import("../session-plugin-ui-action-executor.js");
    h.setExecutor(new SessionPluginUiActionExecutor({ store: h.store, service: h.service, operationGate: h.gate, events: h.events }));
    const receipt = await h.service.invokeAction(h.session.id, h.instance.instanceId, {
      requestId: randomUUID(), expectedRevision: 1, actionId: mode === "error" ? "resolve" : "run", args: {},
    });
    await h.engine.runtimeBridge.waitForRun(receipt.runId);
    expect(h.effects()).toBe("1");
    expect(h.store.runs.getRun(receipt.runId)).toMatchObject({ status: mode === "error" ? "failed" : "completed",
      metadata: { uiAction: { executionState: mode === "error" ? "unknown" : "completed" } } });
    expect(readPluginUiInstance(h.source().metadata)).toMatchObject({ status: "open", revision: 3,
      data: { count: mode === "valid" ? 0 : 1 }, lastActionRunId: receipt.runId });
    expect(readPluginUiInstance(h.source().metadata)?.activeActionRunId).toBeUndefined();
    expect(h.service.readAction(h.session.id, h.instance.instanceId, receipt.requestId).result)
      .toMatchObject({ content: [{ type: "text", text: "Applied once" }],
        ...(mode === "error" ? { isError: true } : {}), metadata: { ui: {
          schemaVersion: 1, componentId: mode === "foreign" ? "other-panel" : "panel",
          data: mode === "malformed" ? [] : { count: 0 },
        } } });
    expect(h.diagnostics).toEqual(mode === "malformed" || mode === "foreign"
      ? [{ code: "plugin_ui_invalid_result", sessionId: h.session.id, runId: receipt.runId,
        partId: (h.store.runs.getRun(receipt.runId)!.metadata.uiAction as { toolUseId: string }).toolUseId }]
      : []);
  });

  it("exports durable action state with raw results and redacts sensitive action args", async () => {
    const h = await harness(); h.setExecutor({ execute: async () => {} });
    const receipt = await h.service.invokeAction(h.session.id, h.instance.instanceId,
      { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: { value: "SECRET_ACTION_VALUE" } });
    await h.engine.runtimeBridge.waitForRun(receipt.runId);
    h.service.settleAction(receipt.runId, "failed");
    const exportInput = { session: h.session, inputs: [], messages: h.store.conversations.listMessages(h.session.id),
      parts: h.store.conversations.listMessageParts(h.session.id), runs: h.store.runs.listRuns(h.session.id), format: "json" as const, filename: join(h.root, "export.json") };
    const maintenance = new SessionMaintenanceService({ data: h.store } as any);
    const result = await maintenance.exportSession(h.session.id, { format: "json", filename: exportInput.filename });
    const data = JSON.parse(readFileSync(result.filepath, "utf8"));
    expect(data.ui_actions).toEqual([expect.objectContaining({ runId: receipt.runId, status: "failed", uiAction: expect.objectContaining({ executionState: "not_started", args: { value: "SECRET_ACTION_VALUE" } }) })]);
    expect(data.messages[0].parts[0].output).toEqual(h.output);
    expect(readFileSync(result.filepath, "utf8")).not.toContain("entryPath");
    const markdown = await maintenance.exportSession(h.session.id, { format: "md", filename: join(h.root, "export.md") });
    expect(readFileSync(markdown.filepath, "utf8")).toContain("not_started");
    const sensitive = h.store.conversationTransactions.admitPrompt({ sessionId: h.session.id, content: "private", metadata: { sensitiveInput: true } });
    await writeSessionExport({ ...exportInput, inputs: [sensitive] });
    expect(readFileSync(result.filepath, "utf8")).not.toContain("SECRET_ACTION_VALUE");
  });

  it.each(["transaction", "queue"])("converges admission %s failure without a Native side effect", async failure => {
    const h = await harness();
    const transaction = h.store.transaction.bind(h.store);
    if (failure === "transaction") vi.spyOn(h.store, "transaction").mockImplementationOnce(work => transaction(() => { work(); throw new Error("injected transaction failure"); }));
    else vi.spyOn(h.engine, "enqueueHostWork").mockImplementationOnce(() => { throw new Error("injected queue failure"); });
    const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: {} };
    await expect(h.service.invokeAction(h.session.id, h.instance.instanceId, input)).rejects.toThrow("injected");
    const instance = readPluginUiInstance(h.source().metadata)!;
    expect(instance.activeActionRunId).toBeUndefined();
    expect(h.effects()).toBe("0");
    const store = h.reopen();
    const run = store.runs.listRuns(h.session.id).find(r => r.id !== "source-run");
    if (failure === "transaction") { expect(run).toBeUndefined(); expect(instance.revision).toBe(1); }
    else expect(run).toMatchObject({ status: "failed", metadata: { uiAction: { executionState: "not_started" } } });
  });

  it("retains unknown and old data when final result saving fails after the real side effect", async () => {
    const h = await harness();
    const { SessionPluginUiActionExecutor } = await import("../session-plugin-ui-action-executor.js");
    h.setExecutor(new SessionPluginUiActionExecutor({ store: h.store, service: h.service, operationGate: h.gate, events: h.events }));
    const upsert = h.store.conversations.upsertMessagePart.bind(h.store.conversations);
    let fail = true;
    vi.spyOn(h.store.conversations, "upsertMessagePart").mockImplementation(input => {
      if (fail && input.id !== "source-call" && input.output) { fail = false; throw new Error("result save failure"); }
      return upsert(input);
    });
    const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "resolve", args: {} };
    const receipt = await h.service.invokeAction(h.session.id, h.instance.instanceId, input);
    await h.engine.runtimeBridge.waitForRun(receipt.runId);
    expect(h.effects()).toBe("1");
    expect(h.store.runs.getRun(receipt.runId)).toMatchObject({ status: "failed", error: "plugin_ui_result_save_failed", metadata: { uiAction: { executionState: "unknown" } } });
    expect(readPluginUiInstance(h.source().metadata)).toMatchObject({ status: "open", data: { count: 1 } });
    expect((await h.service.invokeAction(h.session.id, h.instance.instanceId, input)).status).toBe("failed");
    expect(h.effects()).toBe("1");
  });

  it.each(["revision", "busy", "resolved", "dismissed", "archived", "permission", "digest", "disabled", "missing", "runtime"])("rejects new %s actions without executing a tool", async state => {
    const h = await harness();
    if (state === "busy") h.store.runs.createRun({ id: "model-work", sessionId: h.session.id });
    if (state === "resolved" || state === "dismissed") h.store.conversations.upsertMessagePart({ ...h.source(), metadata: { pluginUi: { ...h.instance, status: state } } });
    if (state === "archived") h.store.sessions.archive(h.session.id);
    if (state === "permission") h.setCurrent({ permissionsApproved: false });
    if (state === "digest") h.setCurrent({ binding: { ...h.agent.createRunCapabilityView(pluginId).pluginUi!.get(`${pluginId}:panel`)!, componentDigest: "f".repeat(64) } });
    if (state === "disabled") h.setCurrent({ enabled: false });
    if (state === "missing") h.setCurrent({ snapshot: "missing" });
    if (state === "runtime") h.setCurrent({ runtimeAvailable: false });
    await expect(h.service.invokeAction(h.session.id, h.instance.instanceId, { requestId: randomUUID(),
      expectedRevision: state === "revision" ? 0 : 1, actionId: "run", args: {} })).rejects.toBeInstanceOf(Error);
    expect(h.store.runs.listRuns(h.session.id).filter(run => run.metadata.uiAction)).toEqual([]);
    expect(h.effects()).toBe("0");
  });

  it("owns admitted args across awaits and rejects another client's stale revision", async () => {
    const h = await harness();
    const { SessionPluginUiActionExecutor } = await import("../session-plugin-ui-action-executor.js");
    h.setExecutor(new SessionPluginUiActionExecutor({ store: h.store, service: h.service, operationGate: h.gate, events: h.events }));
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    h.onAcquire(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); });
    const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: { value: "approved" } };
    const promise = h.service.invokeAction(h.session.id, h.instance.instanceId, input);
    await waiting;
    input.args.value = "mutated"; h.onAcquire(undefined); release();
    const receipt = await promise;
    await h.engine.runtimeBridge.waitForRun(receipt.runId);
    expect(JSON.parse(readFileSync(join(h.root, "args"), "utf8"))).toEqual({ value: "approved" });
    expect(h.store.runs.getRun(receipt.runId)?.metadata.uiAction).toMatchObject({ args: { value: "approved" } });
    expect((await h.service.invokeAction(h.session.id, h.instance.instanceId, { ...input, args: { value: "approved" } })).runId).toBe(receipt.runId);
    await expect(h.service.invokeAction(h.session.id, h.instance.instanceId, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: "plugin_ui_revision_conflict" });
    await expect(h.service.invokeAction(h.session.id, h.instance.instanceId, { ...input, expectedRevision: 3 })).rejects.toMatchObject({ code: "plugin_ui_request_conflict" });
    expect(h.effects()).toBe("1");
  });

  it.each(["cancel", "drift"])("handles %s during execution preparation before invocation", async mode => {
    const h = await harness();
    const { SessionPluginUiActionExecutor } = await import("../session-plugin-ui-action-executor.js");
    h.setExecutor(new SessionPluginUiActionExecutor({ store: h.store, service: h.service, operationGate: h.gate, events: h.events }));
    let count = 0; let release!: () => void;
    h.onAcquire(async () => { if (++count === 2) await new Promise<void>(resolve => { release = resolve; }); });
    const receipt = await h.service.invokeAction(h.session.id, h.instance.instanceId,
      { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: {} });
    await vi.waitFor(() => expect(release).toBeDefined());
    if (mode === "cancel") h.engine.runtimeBridge.interruptRun(h.session.id, receipt.runId);
    else h.setCurrent({ snapshot: "changed" });
    release(); await h.engine.runtimeBridge.waitForRun(receipt.runId);
    expect(h.store.runs.getRun(receipt.runId)).toMatchObject({ status: mode === "cancel" ? "interrupted" : "failed",
      metadata: { uiAction: { executionState: "not_started" } } });
    expect(h.effects()).toBe("0");
  });

  it("rechecks session busy state after Agent preparation before admission commits", async () => {
    const h = await harness();
    h.onAcquire(async () => { h.store.runs.createRun({ id: "model-work", sessionId: h.session.id }); });
    await expect(h.service.invokeAction(h.session.id, h.instance.instanceId,
      { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: {} })).rejects.toMatchObject({ code: "plugin_ui_session_busy" });
    expect(h.store.runs.listRuns(h.session.id).filter(run => run.metadata.uiAction)).toEqual([]);
    expect(h.effects()).toBe("0");
  });

  it("does not invoke after the durable before-invoke transaction fails", async () => {
    const h = await harness();
    const { SessionPluginUiActionExecutor } = await import("../session-plugin-ui-action-executor.js");
    h.setExecutor(new SessionPluginUiActionExecutor({ store: h.store, service: h.service, operationGate: h.gate, events: h.events }));
    const update = h.store.runs.updateRun.bind(h.store.runs);
    let fail = true;
    vi.spyOn(h.store.runs, "updateRun").mockImplementation((id, input) => {
      if (fail && (input.metadata?.uiAction as any)?.executionState === "unknown") { fail = false; throw new Error("before-invoke save failed"); }
      return update(id, input);
    });
    const receipt = await h.service.invokeAction(h.session.id, h.instance.instanceId,
      { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: {} });
    await h.engine.runtimeBridge.waitForRun(receipt.runId);
    expect(h.effects()).toBe("0");
    expect(h.store.runs.getRun(receipt.runId)).toMatchObject({ status: "failed", metadata: { uiAction: { executionState: "not_started" } } });
  });

  it("rechecks the final await-to-transaction gap before admitting a new action", async () => {
    const h = await harness(); h.setExecutor({ execute: async () => {} });
    const prepare = h.service.prepareAction.bind(h.service);
    vi.spyOn(h.service, "prepareAction").mockImplementation(async (...args) => {
      const prepared = await prepare(...args);
      queueMicrotask(() => { h.store.runs.createRun({ id: "model-work", sessionId: h.session.id }); });
      return prepared;
    });
    await expect(h.service.invokeAction(h.session.id, h.instance.instanceId,
      { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: {} })).rejects.toMatchObject({ code: "plugin_ui_session_busy" });
    expect(h.store.runs.listRuns(h.session.id).filter(run => run.metadata.uiAction)).toEqual([]);
  });

  it.each(["missing", "malformed", "future-schema", "foreign-plugin"])("keeps a %s last action read-only but dismissible", async state => {
    const h = await harness(); h.setExecutor({ execute: async () => {} });
    const receipt = await h.service.invokeAction(h.session.id, h.instance.instanceId,
      { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: {} });
    await h.engine.runtimeBridge.waitForRun(receipt.runId);
    h.service.settleAction(receipt.runId, "failed");
    const saved = h.store.runs.getRun(receipt.runId)!;
    if (state === "missing") h.store.conversations.upsertMessagePart({ ...h.source(), metadata: {
      pluginUi: { ...readPluginUiInstance(h.source().metadata)!, lastActionRunId: "missing" },
    } });
    else h.store.runs.updateRun(receipt.runId, { metadata: { uiAction: state === "malformed" ? {} : {
      ...(saved.metadata.uiAction as object), ...(state === "future-schema" ? { schemaVersion: 2 } : { pluginId: "foreign" }),
    } } });
    expect((await h.service.get(h.session.id, h.instance.instanceId)).availability).toEqual({ code: "action-unknown", canRender: true, canInvoke: false });
    await expect(h.service.invokeAction(h.session.id, h.instance.instanceId,
      { requestId: randomUUID(), expectedRevision: 3, actionId: "run", args: {} })).rejects.toMatchObject({ code: "plugin_ui_action_unknown" });
    expect(await h.service.dismiss(h.session.id, h.instance.instanceId, { requestId: randomUUID(), expectedRevision: 3 })).toMatchObject({ status: "dismissed" });
    expect(h.effects()).toBe("0");
  });

  it("accepts boundary-depth args and canonical retries independently of object key order", async () => {
    const h = await harness(); h.setExecutor({ execute: async () => {} });
    let args: Record<string, any> = { z: 2, a: 1 };
    let reordered: Record<string, any> = { a: 1, z: 2 };
    for (let depth = 0; depth < 19; depth++) { args = { nested: args }; reordered = { nested: reordered }; }
    const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args };
    const receipt = await h.service.invokeAction(h.session.id, h.instance.instanceId, input);
    await h.engine.runtimeBridge.waitForRun(receipt.runId);
    expect((await h.service.invokeAction(h.session.id, h.instance.instanceId, { ...input, args: reordered })).runId).toBe(receipt.runId);
    await expect(h.service.invokeAction(h.session.id, h.instance.instanceId, { ...input, actionId: "resolve" })).rejects.toMatchObject({ code: "plugin_ui_request_conflict" });
    expect(h.effects()).toBe("0");
  });

  it.each(["permission", "arguments"])("retains not_started for checked-tool %s rejection", async reason => {
    const h = await harness(reason === "permission");
    const { SessionPluginUiActionExecutor } = await import("../session-plugin-ui-action-executor.js");
    h.setExecutor(new SessionPluginUiActionExecutor({ store: h.store, service: h.service, operationGate: h.gate, events: h.events }));
    const receipt = await h.service.invokeAction(h.session.id, h.instance.instanceId,
      { requestId: randomUUID(), expectedRevision: 1, actionId: "run", args: reason === "arguments" ? { value: 123 } : {} });
    await h.engine.runtimeBridge.waitForRun(receipt.runId);
    expect(h.store.runs.getRun(receipt.runId)).toMatchObject({ status: "failed", metadata: { uiAction: { executionState: "not_started" } } });
    expect(h.effects()).toBe("0");
  });

  it("allows dismiss while a normal Run is busy and plugin rendering is disabled", async () => {
    const h = await harness();
    h.setCurrent({ enabled: false, snapshot: "changed", permissionsApproved: false });
    h.store.runs.createRun({ id: "normal-model", sessionId: h.session.id });
    expect(await h.service.dismiss(h.session.id, h.instance.instanceId,
      { requestId: randomUUID(), expectedRevision: 1 })).toMatchObject({ status: "dismissed", revision: 2 });
    expect(h.store.runs.getRun("normal-model")?.status).toBe("pending");
    expect(h.effects()).toBe("0");
  });
});
