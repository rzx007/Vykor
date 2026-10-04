import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureNativeUiLogs, expectNoPrivateUiData } from "../../../../agent-runtime/test-helpers/native-ui-logs.js";
import { createDefaultNodeAgent, getNativeToolRuntimeSnapshot } from "@vykor/agent-runtime";
import { getInstalledPluginStorePath, type Settings } from "@vykor/core";
import { installLocalNativePlugin, updateInstalledPluginStore } from "@vykor/plugins";
import { CURRENT_PROTOCOL_VERSION, readPluginUiInstance } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { VykorClient } from "../../../../client/src/index.js";
import { VykorHttpServer } from "../server.js";
import { createSystemRoutes } from "../routes/system.js";
import { createDefaultPluginService } from "../../application/default-services/plugin-service.js";
import { createDefaultSettingsService } from "../../application/default-services/settings-service.js";

const cleanup: (() => void | Promise<void>)[] = [];
let nativeLogs: ReturnType<typeof captureNativeUiLogs>;
beforeEach(() => { nativeLogs = captureNativeUiLogs({ pluginId: "test.ui-http", sessionId: "opaque-session",
  toolNames: ["NativeInspect", "NativeAction"], inputSummaries: ["{}", "{value:string(8)}", "{drift:boolean}"],
  diagnostics: ["Native Host registration unavailable", "Plugin UI component 'panel' requires its own active Native tools."] }); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); nativeLogs.verify(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const pluginId = "test.ui-http";
const html = "<!doctype html><p>Verified panel</p>";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function harness(link = false) {
  const root = mkdtempSync(join(tmpdir(), "vykor-ui-http-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv("VYKOR_CONFIG_DIR", join(root, "config"));
  const source = join(root, "source");
  for (const path of [".vykor-plugin", "ui", "tools"]) mkdirSync(join(source, path), { recursive: true });
  writeFileSync(join(source, ".vykor-plugin/plugin.json"), JSON.stringify({ schemaVersion: 1, id: pluginId,
    name: "ui-http", version: "1.0.0", components: { tools: ["./tools/index.mjs"], ui: ["./ui/manifest.json"] } }));
  writeFileSync(join(source, "ui/manifest.json"), JSON.stringify({ schemaVersion: 1, components: [{
    id: "panel", title: "Panel", entry: "./ui/panel.html", surfaces: ["tool-result"],
    actions: [{ id: "apply", label: "Apply", tool: "NativeAction", completion: "keep-open" }],
  }] }));
  writeFileSync(join(source, "ui/panel.html"), html);
  writeFileSync(join(source, "tools/index.mjs"), `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    export function registerTools() {
      if (existsSync(${JSON.stringify(join(root, "host-down"))})) throw new Error("Native Host registration unavailable");
      return [
      { name: "NativeInspect", description: "inspect", inputSchema: { type: "object" }, async invoke(input) {
        if (input.drift) writeFileSync(${JSON.stringify(join(source, "ui/panel.html"))}, "changed during tool execution");
        return { content: [{ type: "text", text: "One finding" }], metadata: { ui: { schemaVersion: 1, componentId: "panel", data: { count: 1 } } } };
      } },
      { name: "NativeAction", description: "apply", inputSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
        async invoke(input, context) { const file = join(context.cwd, "effects");
          writeFileSync(file, String((existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1));
          if (existsSync(join(context.cwd, "wait-action"))) await new Promise((resolve, reject) => {
            context.signal.throwIfAborted();
            context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          });
          return { content: [{ type: "text", text: "Applied " + (input.value ?? "once") }], metadata: { ui: { schemaVersion: 1, componentId: "panel", data: { count: 0 } } } };
        } }
    ]; }
  `);
  const installed = await installLocalNativePlugin({ sourcePath: source, cwd: root, scope: "user", link, approvedPermissions: ["ui:render", "ui:invoke-own-tools"] });
  expect(installed.status).toBe("installed");
  if (installed.status !== "installed") throw new Error("Native UI fixture installation failed");
  const settings: Settings = { apiFormat: "openai", model: "never", maxTurns: 3,
    permission: { mode: "full_auto" }, sandbox: { enabled: false }, memory: { enabled: false } };
  const settingsRef = { current: settings };
  let store = new SessionStore({ path: join(root, "session.db") });
  let modelCalls = 0;
  let nextInspection: { id: string; input: Record<string, unknown> } | undefined;
  const histories: string[] = [];
  const logs: unknown[] = [];
  let agentLoads = 0;
  let beforeSettings: (() => Promise<void>) | undefined;
  let beforeCreate: (() => Promise<void>) | undefined;
  let modelPause: ReturnType<typeof deferred> | undefined;
  const boot = (hostUnavailable = false) => {
    if (hostUnavailable) writeFileSync(join(root, "host-down"), "down");
    return new VykorHttpServer({ store, settings: settingsRef.current, getSettings: () => settingsRef.current,
    token: "secret-token", logger: event => logs.push(event),
    services: { plugin: createDefaultPluginService(settingsRef), settings: createDefaultSettingsService(settingsRef) },
    getSettingsForCwd: async () => { await beforeSettings?.(); return settingsRef.current; },
    createAgent: async ({ options }) => {
      agentLoads++;
      await beforeCreate?.();
      return createDefaultNodeAgent({ ...options, capabilityOverrides: { ...options.capabilityOverrides, terminal: false, memory: false },
        client: { async *streamMessage(params) {
          if (modelPause) { const paused = modelPause; modelPause = undefined; await paused.promise; }
          histories.push(JSON.stringify(params.messages));
          if (++modelCalls === 1 || nextInspection) {
            const inspection = nextInspection ?? { id: "source-call", input: {} }; nextInspection = undefined;
            yield { type: "tool_use_start", toolUse: { type: "tool_use", ...inspection, name: "NativeInspect" } };
            yield { type: "complete", stopReason: "tool_use" };
          } else { yield { type: "text_delta", delta: "Done" }; yield { type: "complete", stopReason: "end_turn" }; }
        } },
      });
    },
    });
  };
  let server = boot(); await server.application.ready();
  cleanup.push(async () => { await server.close(); store.close(); });
  const client = () => new VykorClient({ baseUrl: "http://localhost", token: "secret-token", fetch: (input, init) => server.app.fetch(new Request(input, init)) });
  const session = store.sessions.create({ id: "opaque-session", cwd: root, model: "never", metadata: { runtime: { model: "never" } } });
  const prompt = await server.application.interactions.admitPrompt(session.id, { items: [
    { type: "text", text: "Inspect" }, { type: "capability", kind: "plugin", pluginId, displayName: "UI HTTP" },
  ] });
  await server.application.runControl.waitForRuns([prompt.run!.id]);
  expect(store.runs.getRun(prompt.run!.id), JSON.stringify(logs)).toMatchObject({ status: "completed" });
  const instance = () => readPluginUiInstance(store.conversations.listMessageParts(session.id).find(p => p.id === "source-call")?.metadata);
  return { root, settings, session, instance, client, logs, histories, modelCalls: () => modelCalls,
    agentLoads: () => agentLoads,
    nativeRuntime: () => getNativeToolRuntimeSnapshot(installed.record.cachePath),
    pauseRead: (phase: "settings" | "preparation") => {
      const started = deferred(); const release = deferred();
      const wait = async () => {
        if (phase === "settings") beforeSettings = undefined;
        else beforeCreate = undefined;
        started.resolve(); await release.promise;
      };
      if (phase === "settings") beforeSettings = wait;
      else beforeCreate = wait;
      return { started: started.promise, release: release.resolve };
    },
    inspectAgain: async (drift: boolean) => {
      nextInspection = { id: "second-source-call", input: { drift } };
      const admitted = await server.application.interactions.admitPrompt(session.id, { items: [
        { type: "text", text: "Inspect again" }, { type: "capability", kind: "plugin", pluginId, displayName: "UI HTTP" },
      ] });
      await server.application.runControl.waitForRuns([admitted.run!.id]);
      return store.runs.getRun(admitted.run!.id)!;
    },
    store: () => store, server: () => server,
    pauseModel: () => { modelPause = deferred(); return modelPause; },
    effects: () => existsSync(join(root, "effects")) ? readFileSync(join(root, "effects"), "utf8") : "0",
    mutateInstall: async (work: (record: any) => void) => updateInstalledPluginStore(getInstalledPluginStorePath(), value => { Object.values(value.plugins).forEach(work); }),
    restart: async (hostUnavailable = false, beforeStartup?: (reopened: SessionStore) => void) => {
      await server.close(); store = new SessionStore({ path: join(root, "session.db") }); beforeStartup?.(store);
      server = boot(hostUnavailable); await server.application.ready();
    },
    raw: (path: string, body?: unknown, headers: Record<string, string> = {}) => server.app.request(path, {
      method: body === undefined ? "GET" : "POST", headers: { "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION), authorization: "Bearer secret-token", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  };
}

it("wires source capture, authenticated Client actions, durable retries, summaries and export through the real daemon", async () => {
  const h = await harness();
  expect(h.instance()).toBeDefined();
  const id = h.instance()!.instanceId;
  const client = h.client();
  expect((await client.protocol.capabilities()).features.pluginUi).toBe(1);
  expect(await client.pluginUi.getDocument(h.session.id, id)).toEqual({ html, sha256: createHash("sha256").update(html).digest("hex") });
  expect((await client.pluginUi.get(h.session.id, id)).actions[0]).toMatchObject({ id: "apply", toolName: "NativeAction" });
  const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: { value: "approved" } };
  const route = `/sessions/${h.session.id}/plugin-ui/${id}`;
  const admitted = await h.raw(route + "/actions", input);
  expect(admitted.status).toBe(202);
  const { receipt } = await admitted.json();
  await h.server().application.runControl.waitForRuns([receipt.runId]);
  expect(h.effects()).toBe("1");
  expect(h.modelCalls()).toBe(2);
  expect(h.store().conversations.listInputs(h.session.id)).toHaveLength(1);
  expect(await client.pluginUi.getAction(h.session.id, id, input.requestId)).toMatchObject({ receipt: { runId: receipt.runId, status: "completed" }, result: { executionState: "completed" } });
  expect((await h.raw(route + "/actions", input)).status).toBe(200);
  await h.restart();
  expect((await h.client().pluginUi.invokeAction(h.session.id, id, input)).runId).toBe(receipt.runId);
  expect(h.effects()).toBe("1");
  const next = await h.server().application.interactions.admitPrompt(h.session.id, { items: [{ type: "text", text: "Continue" }] });
  await h.server().application.runControl.waitForRuns([next.run!.id]);
  expect(h.histories.at(-1)).toContain("外部工具数据");
  expect(h.histories.at(-1)).toContain("Applied approved");
  const exported = await h.server().application.maintenance.exportSession(h.session.id, { format: "json", filename: join(h.root, "export.json") });
  expect(JSON.parse(readFileSync(exported.filepath, "utf8")).ui_actions[0]).toMatchObject({ runId: receipt.runId, status: "completed" });
  const dismissed = await h.client().pluginUi.dismiss(h.session.id, id, { requestId: randomUUID(), expectedRevision: 3 });
  expect(dismissed.status).toBe("dismissed");
  expectNoPrivateUiData([h.logs, nativeLogs.values], ["secret-token", html, "approved", join(h.root, "config")]);
  expectNoPrivateUiData(await h.client().pluginUi.get(h.session.id, id), [h.root]);
});

it.each(["disable", "uninstall", "reload", "reinstall"] as const)("cancels only UI work and revokes its session before %s completes", async mutation => {
  const h = await harness(); const id = h.instance()!.instanceId;
  writeFileSync(join(h.root, "wait-action"), "wait");
  const before = h.store().sessions.get(h.session.id)!.metadata.pluginUiGeneration;
  const receipt = await h.client().pluginUi.invokeAction(h.session.id, id, {
    requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: {},
  });
  await vi.waitFor(() => expect(h.effects()).toBe("1"), { timeout: 10000 });
  const result = mutation === "disable" ? h.client().plugins.disable(pluginId, { cwd: h.root })
    : mutation === "uninstall" ? h.client().plugins.uninstall(pluginId, { cwd: h.root })
    : mutation === "reload" ? h.client().plugins.reload({ cwd: h.root })
    : h.client().plugins.installLocal({ cwd: h.root, sourcePath: join(h.root, "source"), scope: "user",
      approvedPermissions: ["ui:render", "ui:invoke-own-tools"] });
  await expect(result).resolves.toBeDefined();
  expect(h.store().runs.getRun(receipt.runId)).toMatchObject({ status: "interrupted", metadata: { uiAction: { executionState: "unknown" } } });
  expect(h.instance()!.activeActionRunId).toBeUndefined();
  expect(h.effects()).toBe("1");
  expect(h.modelCalls()).toBe(2);
  expect(h.store().sessions.get(h.session.id)!.metadata.pluginUiGeneration).toEqual(expect.any(String));
  expect(h.store().sessions.get(h.session.id)!.metadata.pluginUiGeneration).not.toBe(before);
});

it("cancels a real UI permission wait before disabling, with no Native side effect", async () => {
  const h = await harness(); h.settings.permission = { mode: "default" }; await h.restart();
  const receipt = await h.client().pluginUi.invokeAction(h.session.id, h.instance()!.instanceId, {
    requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: {},
  });
  await vi.waitFor(() => expect(h.store().permissions.list({ sessionId: h.session.id, status: "pending" })).toHaveLength(1), { timeout: 10000 });
  await expect(h.client().plugins.disable(pluginId, { cwd: h.root })).resolves.toBeDefined();
  expect(h.store().runs.getRun(receipt.runId)).toMatchObject({ status: "interrupted", metadata: { uiAction: { executionState: "not_started" } } });
  expect(h.effects()).toBe("0");
  expect(h.store().permissions.list({ sessionId: h.session.id, status: "pending" })).toHaveLength(0);
});
it("cancels UI before switching off its session plugin capability", async () => {
  const h = await harness(); const id = h.instance()!.instanceId;
  writeFileSync(join(h.root, "wait-action"), "wait");
  const receipt = await h.client().pluginUi.invokeAction(h.session.id, id, {
    requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: {},
  });
  await vi.waitFor(() => expect(h.effects()).toBe("1"), { timeout: 10000 });
  await expect(h.client().sessions.update(h.session.id, { metadata: { runtime: { pluginsEnabled: false } } })).resolves.toBeDefined();
  expect(h.store().runs.getRun(receipt.runId)).toMatchObject({ status: "interrupted" });
  expect((await h.client().pluginUi.get(h.session.id, id)).availability.code).toBe("plugin-disabled");
  expect(h.effects()).toBe("1");
});
it("turns off only plugin UI without disabling ordinary plugin tools", async () => {
  const h = await harness();
  h.settings.plugins = { enabled: true, uiEnabled: false };
  expect((await h.client().pluginUi.get(h.session.id, h.instance()!.instanceId)).availability)
    .toMatchObject({ code: "plugin-disabled", canRender: false, canInvoke: false });
  await h.restart(); await h.inspectAgain(false);
  expect(h.store().conversations.listMessageParts(h.session.id).find(part => part.id === "second-source-call")?.status).toBe("completed");
  expect(readPluginUiInstance(h.store().conversations.listMessageParts(h.session.id).find(part => part.id === "second-source-call")?.metadata)).toBeUndefined();
});
it.each([{ plugins: { enabled: true, uiEnabled: false } }, { path: "plugins.enabled", value: "false" }])("cancels UI and revokes documents through settings patch $path", async patch => {
  const h = await harness(); const id = h.instance()!.instanceId;
  writeFileSync(join(h.root, "wait-action"), "wait");
  const receipt = await h.client().pluginUi.invokeAction(h.session.id, id, {
    requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: {},
  });
  await vi.waitFor(() => expect(h.effects()).toBe("1"), { timeout: 10000 });
  await expect(h.client().system.patchSettings(patch)).resolves.toBeDefined();
  expect(h.store().runs.getRun(receipt.runId)?.status).toBe("interrupted");
  expect((await h.client().pluginUi.get(h.session.id, id)).availability.canRender).toBe(false);
  expect(h.effects()).toBe("1");
});
it("keeps ordinary model work running and refuses maintenance with the existing 409 barrier", async () => {
  const h = await harness(); const pause = h.pauseModel();
  const ordinary = await h.server().application.interactions.admitPrompt(h.session.id, { items: [{ type: "text", text: "ordinary work" }] });
  try {
    await expect(h.client().plugins.disable(pluginId, { cwd: h.root })).rejects.toMatchObject({ status: 409 });
    expect(h.store().runs.getRun(ordinary.run!.id)!.status).not.toBe("interrupted");
    expect(h.effects()).toBe("0");
  } finally { pause.resolve(); await h.server().application.runControl.waitForRuns([ordinary.run!.id]); }
  expect(h.store().runs.getRun(ordinary.run!.id)!.status).toBe("completed");
});
it("blocks UI admission during maintenance and releases it after a failed mutation", async () => {
  const h = await harness(); const id = h.instance()!.instanceId; const gate = deferred();
  const work = h.server().application.pluginUi.withPluginUiLifecycleMutation({ kind: "global", pluginId }, async () => {
    await gate.promise; throw new Error("fixture mutation failed");
  });
  const rejection = expect(work).rejects.toThrow("fixture mutation failed");
  try {
    await expect(h.client().pluginUi.invokeAction(h.session.id, id, { requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: {} }))
      .rejects.toMatchObject({ status: 409, body: { code: "plugin_ui_lifecycle_mutating" } });
    expect(h.effects()).toBe("0");
  } finally { gate.resolve(); await rejection; }
  expect((await h.client().pluginUi.get(h.session.id, id)).availability.canInvoke).toBe(true);
  expect(h.instance()).toMatchObject({ revision: 1, status: "open" });
});

it.each(["permission", "native"] as const)("closes the daemon during a real UI %s wait and preserves durable cancellation without replay", async phase => {
  const h = await harness(); const id = h.instance()!.instanceId;
  if (phase === "permission") { h.settings.permission = { mode: "default" }; await h.restart(); }
  else writeFileSync(join(h.root, "wait-action"), "wait");
  const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: {} };
  const receipt = await h.client().pluginUi.invokeAction(h.session.id, id, input);
  await vi.waitFor(() => {
    if (phase === "permission") expect(h.store().permissions.list({ sessionId: h.session.id, status: "pending" })).toHaveLength(1);
    else expect(h.effects()).toBe("1");
  }, { timeout: 10000 });
  // The executor must keep maintenance excluded until its atomic settlement finishes.
  expect(h.server().application.control.acquireGlobalMutation()).toBeUndefined();
  let closed = false;
  const closing = h.server().close().then(() => { closed = true; });
  try {
    await expect(h.client().pluginUi.invokeAction(h.session.id, id, { ...input, requestId: randomUUID() }))
      .rejects.toMatchObject({ status: 503 });
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 3000 });
  } finally {
    // Rescue only a regressing implementation, so a failing test cannot hang its cleanup.
    if (!closed) h.server().application.runControl.interruptRun(h.session.id, receipt.runId);
    await closing;
  }
  expect(h.nativeRuntime()).toMatchObject({ hostCount: 0, registeredToolCount: 0 });
  await h.restart(false, reopened => {
    // Inspect before startup recovery: shutdown itself must have committed all three facts.
    const executionState = phase === "permission" ? "not_started" : "unknown";
    expect(reopened.runs.getRun(receipt.runId)).toMatchObject({ status: "interrupted", metadata: { uiAction: { executionState } } });
    expect(reopened.conversations.listMessageParts(h.session.id).find(part => part.toolName === "NativeAction"))
      .toMatchObject({ status: "interrupted", metadata: { executionState, toolProgress: null } });
    expect(h.instance()).toMatchObject({ revision: 3, data: { count: 1 }, lastActionRunId: receipt.runId });
    expect(h.instance()!.activeActionRunId).toBeUndefined();
    expect(reopened.permissions.list({ sessionId: h.session.id, status: "pending" })).toHaveLength(0);
  });
  expect((await h.client().pluginUi.invokeAction(h.session.id, id, input)).status).toBe("interrupted");
  if (phase === "native") {
    await expect(h.client().pluginUi.invokeAction(h.session.id, id, { ...input, requestId: randomUUID(), expectedRevision: 3 }))
      .rejects.toMatchObject({ status: 409, body: { code: "plugin_ui_action_unknown" } });
  }
  expect(h.effects()).toBe(phase === "permission" ? "0" : "1");
  expect(h.modelCalls()).toBe(2);
});

it("blocks real UI reads throughout global maintenance after the pool has closed", async () => {
  const h = await harness(); const id = h.instance()!.instanceId;
  const control = h.server().application.control;
  const barrier = control.acquireGlobalMutation()!; expect(barrier).toBeDefined();
  try {
    await control.closeAllRuntimes();
    const loads = h.agentLoads();
    expect((await h.client().pluginUi.get(h.session.id, id)).availability)
      .toEqual({ code: "runtime-unavailable", canRender: false, canInvoke: false });
    await expect(h.client().pluginUi.getDocument(h.session.id, id)).rejects.toMatchObject({ status: 503, body: { code: "plugin_ui_unavailable" } });
    expect(h.agentLoads()).toBe(loads);
    expect(control.runtimeSnapshot().warmAgentCount).toBe(0);
    expect(h.nativeRuntime()).toMatchObject({ hostCount: 0, registeredToolCount: 0 });
  } finally { barrier.release(); }
  expect((await h.client().pluginUi.get(h.session.id, id)).availability.code).toBe("available");
  expect(control.runtimeSnapshot().warmAgentCount).toBe(1);
  expect(h.effects()).toBe("0");
});

it.each(["get", "document"] as const)("protects an in-flight UI %s installation read against actual reload and uninstall", async kind => {
  const h = await harness(); const id = h.instance()!.instanceId;
  const pause = h.pauseRead("settings");
  const path = `/sessions/${h.session.id}/plugin-ui/${id}${kind === "document" ? "/document" : ""}`;
  const reading = h.raw(path);
  await pause.started;
  try {
    const reloadStatus = await h.client().plugins.reload({ cwd: h.root }).then(() => 200, error => error.status);
    const uninstallStatus = await h.client().plugins.uninstall(pluginId, { cwd: h.root }).then(() => 200, error => error.status);
    expect([reloadStatus, uninstallStatus]).toEqual([409, 409]);
  } finally { pause.release(); await reading; }
  const response = await reading; expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject(kind === "get" ? { availability: { code: "available" } } : { html });
  await h.client().plugins.reload({ cwd: h.root });
  expect(h.server().application.control.runtimeSnapshot().warmAgentCount).toBe(0);
  expect((await h.client().pluginUi.get(h.session.id, id)).availability.code).toBe("available");
  await h.client().plugins.uninstall(pluginId, { cwd: h.root });
  const loads = h.agentLoads();
  expect((await h.client().pluginUi.get(h.session.id, id)).availability.code).toBe("plugin-disabled");
  await expect(h.client().pluginUi.getDocument(h.session.id, id)).rejects.toMatchObject({ status: 503 });
  expect(h.agentLoads()).toBe(loads);
  expect(h.server().application.control.runtimeSnapshot().warmAgentCount).toBe(0);
  expect(h.nativeRuntime()).toMatchObject({ hostCount: 0, registeredToolCount: 0 });
  expect(h.effects()).toBe("0");
});

it.each([
  { kind: "get", phase: "settings" }, { kind: "document", phase: "settings" },
  { kind: "get", phase: "preparation" }, { kind: "document", phase: "preparation" },
] as const)("drains UI $kind during $phase on close without preparing after shutdown or returning stale availability", async ({ kind, phase }) => {
  const h = await harness(); const id = h.instance()!.instanceId;
  const control = h.server().application.control;
  await control.closeAllRuntimes();
  const pause = h.pauseRead(phase);
  const path = `/sessions/${h.session.id}/plugin-ui/${id}${kind === "document" ? "/document" : ""}`;
  const reading = h.raw(path);
  await pause.started;
  const loads = h.agentLoads();
  let closed = false;
  const closing = h.server().close().then(() => { closed = true; });
  let refused: Response | undefined;
  const refusing = h.raw(path).then(response => { refused = response; });
  try {
    await vi.waitFor(() => expect(refused).toBeDefined(), { timeout: 3000 });
    if (kind === "get") expect(await refused!.json()).toMatchObject({ availability: { canRender: false, canInvoke: false } });
    else expect(refused!.status).toBe(503);
    expect(closed).toBe(false);
  } finally { pause.release(); await reading; await refusing; await closing; }
  const response = await reading;
  if (kind === "get") expect(await response.json()).toMatchObject({ availability: { canRender: false, canInvoke: false } });
  else expect(response.status).toBe(503);
  expect(h.agentLoads()).toBe(loads);
  expect(h.nativeRuntime()).toMatchObject({ hostCount: 0, registeredToolCount: 0 });
  // The exact installed snapshot remains usable after a cold reopen, without replaying a tool.
  await h.restart();
  expect(h.server().application.control.runtimeSnapshot().warmAgentCount).toBe(0);
  expect((await h.client().pluginUi.get(h.session.id, id)).availability.code).toBe("available");
  expect(h.agentLoads()).toBe(loads + 1);
  expect(h.effects()).toBe("0");
});

it("enforces auth, Origin, ownership, strict JSON and byte limits without invoking", async () => {
  const h = await harness(); expect(h.instance()).toBeDefined(); const id = h.instance()!.instanceId;
  const path = `/sessions/${h.session.id}/plugin-ui/${id}`;
  expect((await h.raw(path, undefined, { authorization: "" })).status).toBe(401);
  expect((await h.raw(path, undefined, { origin: "https://evil.test" })).status).toBe(403);
  expect((await h.raw(`/sessions/other/plugin-ui/${id}`)).status).toBe(404);
  expect((await h.raw(`/sessions/${h.session.id}/plugin-ui/not-a-uuid`)).status).toBe(400);
  expect((await h.raw(path + "/document/assets/a.html")).status).toBe(404);
  expect((await h.raw(path + "/document?path=../../private")).status).toBe(400);
  const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: { value: "é".repeat(33000) } };
  const large = await h.raw(path + "/actions", input);
  expect(large.status).toBe(413); expect(await large.json()).toMatchObject({ code: "plugin_ui_payload_too_large" });
  const huge = await h.raw(path + "/actions", { ...input, args: { value: "x".repeat(1024 * 1024) } });
  expect(huge.status).toBe(413); expect(await huge.json()).toMatchObject({ code: "plugin_ui_payload_too_large" });
  const invalid = await h.raw(path + "/actions", { ...input, args: {}, pluginId: "forged" });
  expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: "invalid_request" });
  await expect(h.client().pluginUi.invokeAction(h.session.id, id, { ...input, args: { value: NaN } })).rejects.toMatchObject({ code: "invalid_request" });
  expect(h.effects()).toBe("0");
});

it("omits the feature for narrow HTTP assemblies without a full backend", async () => {
  const app = createSystemRoutes({ control: {} as any });
  expect((await (await app.request("/capabilities")).json()).features.pluginUi).toBeUndefined();
});

it("rechecks a warm linked source after the Native tool changes files, keeping successful text but no new instance", async () => {
  const h = await harness(true); expect(h.instance()).toBeDefined();
  expect(await h.inspectAgain(true)).toMatchObject({ status: "completed" });
  const part = h.store().conversations.listMessageParts(h.session.id).find(p => p.id === "second-source-call")!;
  expect(part).toMatchObject({ status: "completed", output: { content: [{ type: "text", text: "One finding" }], metadata: { ui: { componentId: "panel" } } } });
  expect(readPluginUiInstance(part.metadata)).toBeUndefined();
  expect(h.logs).toContainEqual(expect.objectContaining({ event: "plugin_ui_invalid_result", sessionId: h.session.id }));
  expect((await h.client().pluginUi.get(h.session.id, h.instance()!.instanceId)).availability.code).toBe("snapshot-changed");
});

it("retains admitted Native work after its HTTP caller aborts and safely retries", async () => {
  const h = await harness(); const id = h.instance()!.instanceId;
  const controller = new AbortController();
  const client = new VykorClient({ baseUrl: "http://localhost", token: "secret-token", fetch: async (input, init) => {
    const response = await h.server().app.fetch(new Request(input, init));
    if (String(input).endsWith("/actions")) { controller.abort(); throw controller.signal.reason; }
    return response;
  } });
  const input = { requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: {} };
  await expect(client.pluginUi.invokeAction(h.session.id, id, input, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  const { receipt } = await h.client().pluginUi.getAction(h.session.id, id, input.requestId);
  await h.server().application.runControl.waitForRuns([receipt.runId]);
  expect((await h.client().pluginUi.invokeAction(h.session.id, id, input)).runId).toBe(receipt.runId);
  expect(h.effects()).toBe("1");
});

it.each(["global", "session"])("blocks document and action admission when %s plugins are disabled", async mode => {
  const h = await harness(); const id = h.instance()!.instanceId;
  if (mode === "global") h.settings.plugins = { enabled: false };
  else h.store().sessions.update(h.session.id, { metadata: { runtime: { model: "never", pluginsEnabled: false } } });
  expect((await h.client().pluginUi.get(h.session.id, id)).availability.code).toBe("plugin-disabled");
  await expect(h.client().pluginUi.getDocument(h.session.id, id)).rejects.toMatchObject({ status: 503 });
  await expect(h.client().pluginUi.invokeAction(h.session.id, id, { requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: {} })).rejects.toMatchObject({ status: 503 });
  expect(h.effects()).toBe("0");
});

it("uses the real permission broker and never runs a denied Native action", async () => {
  const h = await harness(); const id = h.instance()!.instanceId;
  h.settings.permission = { mode: "default" };
  await h.restart();
  const client = h.client();
  const receipt = await client.pluginUi.invokeAction(h.session.id, id, { requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: {} });
  let permissionId = "";
  await vi.waitFor(async () => {
    const pending = await client.permissions.list({ sessionId: h.session.id, status: "pending" });
    expect(pending).toHaveLength(1); permissionId = pending[0]!.id;
  }, { timeout: 10000 });
  await client.permissions.reply(permissionId, { status: "denied" });
  await h.server().application.runControl.waitForRuns([receipt.runId]);
  expect(h.store().runs.getRun(receipt.runId)).toMatchObject({ status: "failed", metadata: { uiAction: { executionState: "not_started" } } });
  expect(h.effects()).toBe("0");
});

it("rejects a component whose action is absent from a successfully prepared runtime", async () => {
  const h = await harness(); const id = h.instance()!.instanceId;
  h.store().sessions.update(h.session.id, { metadata: { runtime: { model: "never", disallowedTools: ["NativeAction"] } } });
  await h.restart();
  expect((await h.client().pluginUi.get(h.session.id, id)).availability)
    .toEqual({ code: "invalid-definition", canRender: false, canInvoke: false });
  await expect(h.client().pluginUi.getDocument(h.session.id, id)).rejects.toMatchObject({ status: 409 });
  expect(h.effects()).toBe("0");
});

it.each(["not_started", "unknown"])("settles durable %s actions through the real startup callback before ordinary interruption", async executionState => {
  const h = await harness(); const id = h.instance()!.instanceId;
  const completed = await h.client().pluginUi.invokeAction(h.session.id, id, { requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: {} });
  await h.server().application.runControl.waitForRuns([completed.runId]);
  const input = { requestId: randomUUID(), expectedRevision: 3, actionId: "apply", args: {} };
  const receipt = { runId: "ui_run_" + createHash("sha256").update(JSON.stringify([h.session.id, id, input.requestId])).digest("hex") };
  await h.restart(true, store => {
    const template = store.runs.getRun(completed.runId)!;
    const run = store.runs.createRun({ id: receipt.runId, sessionId: h.session.id,
      metadata: { uiAction: { ...(template.metadata.uiAction as object), requestId: input.requestId,
        expectedRevision: 3, toolUseId: "crashed-call", executionState,
        requestFingerprint: createHash("sha256").update(JSON.stringify({ actionId: "apply", args: {}, expectedRevision: 3 })).digest("hex"),
      } } });
    if (executionState === "unknown") store.runs.updateRun(run.id, { status: "running" });
    const part = store.conversations.listMessageParts(h.session.id).find(p => p.id === "source-call")!;
    store.conversations.upsertMessagePart({ ...part, metadata: { ...part.metadata,
      pluginUi: { ...readPluginUiInstance(part.metadata)!, revision: 4, activeActionRunId: run.id } } });
  });
  expect(h.store().runs.getRun(receipt.runId)).toMatchObject({ status: "interrupted", error: "plugin_ui_daemon_restarted", metadata: { uiAction: { executionState } } });
  expect(h.instance()!.activeActionRunId).toBeUndefined();
  expect((await h.client().pluginUi.invokeAction(h.session.id, id, input)).status).toBe("interrupted");
  expect((await h.client().pluginUi.get(h.session.id, id)).availability).toMatchObject({ canRender: true, canInvoke: false,
    code: executionState === "unknown" ? "action-unknown" : "runtime-unavailable" });
  expect(h.effects()).toBe("1");
});

it("keeps exact verified documents read-only after a cold Host failure, and rejects disabled, unapproved or drifted snapshots", async () => {
  const h = await harness(); expect(h.instance()).toBeDefined(); const id = h.instance()!.instanceId;
  await h.restart(true);
  expect(await h.client().pluginUi.get(h.session.id, id)).toMatchObject({ availability: { code: "runtime-unavailable", canRender: true, canInvoke: false }, actions: [] });
  expect((await h.client().pluginUi.getDocument(h.session.id, id)).html).toBe(html);
  await expect(h.client().pluginUi.invokeAction(h.session.id, id, { requestId: randomUUID(), expectedRevision: 1, actionId: "apply", args: {} })).rejects.toMatchObject({ status: 503 });
  await h.mutateInstall(record => { record.enabled = false; });
  await expect(h.client().pluginUi.getDocument(h.session.id, id)).rejects.toMatchObject({ status: 503 });
  await h.mutateInstall(record => { record.enabled = true; record.approvedPermissions = []; });
  await expect(h.client().pluginUi.getDocument(h.session.id, id)).rejects.toMatchObject({ status: 403 });
  await h.mutateInstall(record => { record.approvedPermissions = ["ui:render", "ui:invoke-own-tools"]; writeFileSync(join(record.cachePath, "ui/panel.html"), "changed"); });
  await expect(h.client().pluginUi.getDocument(h.session.id, id)).rejects.toMatchObject({ status: 409 });
  expect(h.effects()).toBe("0");
});
