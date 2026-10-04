import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry, type RunPluginUiBinding, type ToolResult } from "@vykor/core";
import { createRunCapabilityView } from "@vykor/agent-runtime";
import { SessionStore } from "@vykor/services";
import { SessionTranscriptProjection } from "../transcript-projection.js";
import { SessionPluginUiService, type PluginUiCurrentState } from "../session-plugin-ui-service.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const pluginId = "example.ui-fixture";
function fixture() {
  const registry = new ToolRegistry();
  registry.register({ name: "Inspect", description: "Inspect text", inputSchema: { type: "object" },
    execute: async () => ({ content: [{ type: "text", text: "done" }] }) }, { kind: "plugin", id: pluginId });
  registry.register({ name: "Fix", description: "Fix text", inputSchema: { type: "object" },
    execute: async () => ({ content: [{ type: "text", text: "fixed" }] }) }, { kind: "plugin", id: pluginId });
  const tools = createRunCapabilityView({ toolRegistry: registry, pluginIds: new Set([pluginId]) }, pluginId).tools;
  const binding: RunPluginUiBinding = {
    pluginId, pluginVersion: "1.0.0", pluginDigest: "a".repeat(64), componentId: "findings",
    componentDigest: "b".repeat(64), htmlSha256: "c".repeat(64), root: "/private/plugin", entryPath: "/private/plugin/ui.html",
    definition: { id: "findings", title: "Findings", entry: "ui.html", surfaces: ["tool-result"],
      actions: [{ id: "fix", label: "Fix", tool: "Fix", completion: "resolve" }] },
    actionTools: [tools.get("Fix")!],
  };
  const view = createRunCapabilityView({ toolRegistry: registry, pluginIds: new Set([pluginId]), pluginUi: [binding] }, pluginId);
  return { binding, view };
}
function result(): ToolResult {
  return { content: [{ type: "text", text: "Found one issue" }], executionState: "completed",
    metadata: { ui: { schemaVersion: 1, componentId: "findings", data: { count: 1 } },
      pluginUi: { instanceId: "forged" }, uiAction: { instanceId: "forged" }, custom: "retained" } };
}
function harness() {
  const directory = mkdtempSync(join(tmpdir(), "vykor-ui-instance-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "session.db");
  let store = new SessionStore({ path });
  cleanup.push(() => store.close());
  const session = store.sessions.create({ id: "s1", cwd: directory, model: "test" });
  const input = store.conversationTransactions.admitPrompt({ sessionId: session.id, content: "inspect" });
  store.runs.createRun({ id: "run", sessionId: session.id, inputId: input.id, metadata: { pluginId } });
  const { binding, view } = fixture();
  let current: PluginUiCurrentState = { enabled: true, uiEnabled: true, permissionsApproved: true,
    snapshot: "valid", binding, runtimeAvailable: true };
  const diagnostics: unknown[] = [];
  const makeService = () => new SessionPluginUiService({ store, transaction: work => store.transaction(work), resolveCurrent: async () => current,
    diagnose: diagnostic => diagnostics.push(diagnostic) });
  const service = makeService();
  service.registerRunView("run", view);
  const projection = new SessionTranscriptProjection(store, service);
  const state = projection.beginRun(session.id, input.id, "run", input);
  projection.projectStreamEvent(state, { type: "generation_started", generationId: "gen", attempt: 1 });
  projection.projectStreamEvent(state, { type: "tool_use_start", toolUse: { type: "tool_use", id: "call", name: "Inspect", input: {} } });
  projection.projectStreamEvent(state, { type: "complete", stopReason: "tool_use" });
  return { store, session, service, projection, state, binding, view, diagnostics,
    setCurrent: (patch: Partial<PluginUiCurrentState>) => { current = { ...current, ...patch }; },
    part: () => store.conversations.listMessageParts(session.id).find(p => p.id === "call")!,
    finish: (output = result()) => store.transaction(() => projection.projectStreamEvent(state, { type: "tool_use_end", toolUseId: "call", result: output })),
    reopen: () => { store.close(); store = new SessionStore({ path }); return makeService(); },
  };
}

describe("trusted plugin UI source projection", () => {
  it("renders verified static definitions without inventing Native action schemas", async () => {
    const h = harness(); h.finish();
    const { actionTools: _tools, ...documentBinding } = h.binding;
    h.setCurrent({ binding: undefined, documentBinding, runtimeAvailable: false });
    const instance = (await import("@vykor/protocol")).readPluginUiInstance(h.part().metadata)!;
    expect(await h.service.get(h.session.id, instance.instanceId)).toMatchObject({
      availability: { code: "runtime-unavailable", canRender: true, canInvoke: false }, actions: [],
    });
  });
  it("does not authorize a runtime binding that differs from the verified document", async () => {
    const h = harness(); h.finish();
    const { actionTools: _tools, ...documentBinding } = h.binding;
    h.setCurrent({ documentBinding, binding: { ...h.binding, pluginVersion: "2.0.0" } });
    const instance = (await import("@vykor/protocol")).readPluginUiInstance(h.part().metadata)!;
    expect((await h.service.get(h.session.id, instance.instanceId)).availability)
      .toEqual({ code: "snapshot-changed", canRender: false, canInvoke: false });
  });
  it("persists host identity in the source Part, preserving raw output, and reads after SQLite reopen", async () => {
    const h = harness();
    const original = result();
    const savedOriginal = structuredClone(original);
    h.finish(original);
    const instance = h.part().metadata.pluginUi as any;
    expect(instance).toMatchObject({ schemaVersion: 1, status: "open", revision: 1, sessionId: "s1",
      sourceRunId: "run", sourcePartId: "call", sourceToolUseId: "call", sourceToolName: "Inspect", pluginId,
      pluginVersion: "1.0.0", data: { count: 1 } });
    expect(instance.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.part().metadata).not.toHaveProperty("uiAction");
    expect(h.part().output).toEqual(savedOriginal);
    expect(original).toEqual(savedOriginal);
    h.service.releaseRunView("run");
    const response = await h.reopen().get("s1", instance.instanceId);
    expect(response).toMatchObject({ instance, availability: { code: "available", canRender: true, canInvoke: true },
      actions: [{ id: "fix", label: "Fix", toolName: "Fix", inputSchema: { type: "object" }, completion: "resolve" }] });
    expect(response.actions).toEqual([{ id: "fix", label: "Fix", toolName: "Fix", inputSchema: { type: "object" }, completion: "resolve" }]);
    expect(JSON.stringify(response)).not.toContain("/private");
    expect(JSON.stringify(response)).not.toContain('"tool"');
  });

  it.each([
    ["unsupported version", { metadata: { ui: { schemaVersion: 2, componentId: "findings", data: {} } } }],
    ["forged proposal identity", { metadata: { ui: { schemaVersion: 1, componentId: "findings", data: {}, pluginId } } }],
    ["missing component", { metadata: { ui: { schemaVersion: 1, componentId: "other", data: {} } } }],
    ["no text", { content: [] }], ["blank text", { content: [{ type: "text", text: "  " }] }],
    ["failed", { isError: true }], ["unknown", { executionState: "unknown" }],
    ["legacy execution", { executionState: undefined }],
  ])("keeps ordinary tool output for %s", (_name, patch) => {
    const h = harness();
    const output = { ...result(), ...patch } as ToolResult;
    const original = structuredClone(output);
    h.finish(output);
    expect(h.part().metadata).not.toHaveProperty("pluginUi");
    expect(h.part().output).toEqual(original);
    expect(h.diagnostics).toEqual([expect.objectContaining({ code: "plugin_ui_invalid_result" })]);
  });

  it.each(["uncaptured", "foreign-source", "ui-action", "uncommitted", "superseded"])("rejects %s provenance", (reason) => {
    const h = harness();
    if (reason === "uncaptured") h.service.releaseRunView("run");
    if (reason === "foreign-source") h.service.registerRunView("run", { ...h.view, tools: new Map([
      ["Inspect", { ...h.view.tools.get("Inspect")!, source: { kind: "mcp", id: pluginId } }],
    ]) });
    if (reason === "ui-action") h.store.runs.updateRun("run", { metadata: { uiAction: { instanceId: "other" } } });
    if (reason === "uncommitted" || reason === "superseded") h.store.conversations.upsertMessagePart({
      ...h.part(), metadata: { modelGeneration: { generationId: "gen", attempt: 1, committed: false, superseded: reason === "superseded" } },
    });
    h.finish();
    expect(h.part().metadata).not.toHaveProperty("pluginUi");
    expect(h.diagnostics).toHaveLength(1);
  });

  it("rolls back the source output and instance together when the enclosing transaction fails", () => {
    const h = harness();
    expect(() => h.store.transaction(() => { h.finish(); throw new Error("rollback"); })).toThrow("rollback");
    expect(h.part().metadata).not.toHaveProperty("pluginUi");
    expect(h.part().output).toBeUndefined();
    expect(h.part().status).toBe("running");
    h.reopen();
    expect(h.part().metadata).not.toHaveProperty("pluginUi");
  });

  it("does not lend the captured parent view to an uncaptured child Run", () => {
    const h = harness();
    const child = h.store.sessions.create({ parentId: "s1", cwd: ".", model: "test" });
    const input = h.store.conversationTransactions.admitPrompt({ sessionId: child.id, content: "inspect child" });
    h.store.runs.createRun({ id: "child-run", sessionId: child.id, inputId: input.id, metadata: { pluginId } });
    const state = h.projection.beginRun(child.id, input.id, "child-run", input);
    h.projection.projectStreamEvent(state, { type: "tool_use_start", toolUse: { type: "tool_use", id: "child-call", name: "Inspect", input: {} } });
    const output = result();
    h.store.transaction(() => h.projection.projectStreamEvent(state, { type: "tool_use_end", toolUseId: "child-call", result: output }));
    const part = h.store.conversations.listMessageParts(child.id).find(p => p.id === "child-call")!;
    expect(part.metadata).not.toHaveProperty("pluginUi");
    expect(part.output).toEqual(output);
    expect(h.diagnostics).toEqual([{ code: "plugin_ui_invalid_result", sessionId: child.id, runId: "child-run", partId: "child-call" }]);
  });

  it.each(["open", "resolved", "dismissed"])("preserves the first raw output and %s instance across repeated delivery after view release", (status) => {
    const h = harness(); h.finish(); const source = h.part();
    const resolved = { ...(source.metadata.pluginUi as object), status, revision: 4, data: { count: 0 } };
    h.store.conversations.upsertMessagePart({ ...source, metadata: { pluginUi: resolved } });
    h.service.releaseRunView("run");
    h.finish({ ...result(), content: [{ type: "text", text: "duplicate delivery" }] });
    expect(h.part().metadata.pluginUi).toEqual(resolved);
    expect(h.part().output).toEqual(source.output);
  });

  it.each(["run-owner", "message-owner", "raw-output"])("rejects durable source corruption: %s", async (field) => {
    const h = harness(); h.finish(); const source = h.part(); const instance = source.metadata.pluginUi as any;
    if (field === "run-owner") h.store.runs.updateRun("run", { metadata: { pluginId: "other-plugin" } });
    if (field === "message-owner") {
      h.store.runs.createRun({ id: "other-run", sessionId: "s1", metadata: { pluginId } });
      h.store.conversations.upsertMessagePart({ ...source, metadata: { pluginUi: { ...instance, sourceRunId: "other-run" } } });
    }
    if (field === "raw-output") h.store.conversations.upsertMessagePart({ ...source, output: { ...result(), executionState: "unknown" } });
    await expect(h.service.get("s1", instance.instanceId)).rejects.toMatchObject({ code: "plugin_ui_not_found" });
  });

  it("uses a safe unavailable response when current host resolution fails", async () => {
    const h = harness(); h.finish(); const instance = h.part().metadata.pluginUi as any;
    const unavailable = new SessionPluginUiService({ store: h.store, transaction: work => h.store.transaction(work),
      resolveCurrent: async () => { throw new Error("/private/plugin/secret"); } });
    const response = await unavailable.get("s1", instance.instanceId);
    expect(response.availability).toEqual({ code: "runtime-unavailable", canRender: false, canInvoke: false });
    expect(JSON.stringify(response)).not.toContain("/private");
  });

  it("does not expose actions whose captured Native target is missing or foreign", async () => {
    const h = harness(); h.finish(); const instance = h.part().metadata.pluginUi as any;
    for (const actionTools of [[], [{ ...h.binding.actionTools[0]!, ownerPluginId: "other" }]]) {
      h.setCurrent({ binding: { ...h.binding, actionTools } });
      const response = await h.service.get("s1", instance.instanceId);
      expect(response.availability).toEqual({ code: "invalid-definition", canRender: false, canInvoke: false });
      expect(response.actions).toEqual([]);
    }
  });

  it.each(["resolved", "dismissed", "active", "unknown"])("keeps %s instance read-only with a valid snapshot", async (state) => {
    const h = harness(); h.finish(); const source = h.part(); const instance = source.metadata.pluginUi as any;
    const patch = state === "active" ? { activeActionRunId: "action" }
      : state === "unknown" ? { lastActionRunId: "action" } : { status: state };
    h.store.conversations.upsertMessagePart({ ...source, metadata: { pluginUi: { ...instance, ...patch } } });
    if (state === "unknown") h.store.runs.createRun({ id: "action", sessionId: "s1", metadata: { uiAction: {
      schemaVersion: 1, instanceId: instance.instanceId, requestId: "00000000-0000-0000-0000-000000000001",
      requestFingerprint: "d".repeat(64), expectedRevision: 1, actionId: "fix", label: "Fix", args: {},
      pluginId, pluginVersion: "1.0.0", pluginDigest: "a".repeat(64), componentDigest: "b".repeat(64),
      toolName: "Inspect", toolUseId: "action-call", executionState: "unknown",
    } } });
    expect((await h.service.get("s1", instance.instanceId)).availability).toEqual({
      code: state === "unknown" ? "action-unknown" : "available", canRender: true, canInvoke: false,
    });
  });

  it("restores availability when the same approved snapshot is enabled again", async () => {
    const h = harness(); h.finish(); const instance = h.part().metadata.pluginUi as any;
    h.setCurrent({ enabled: false });
    expect((await h.service.get("s1", instance.instanceId)).availability.canRender).toBe(false);
    h.setCurrent({ enabled: true });
    expect((await h.service.get("s1", instance.instanceId)).availability.canInvoke).toBe(true);
    expect(h.part().metadata.pluginUi).toEqual(instance);
  });

  it("never authorizes copied, mismatched, uncommitted or removed source Parts", async () => {
    const h = harness(); h.finish();
    const instance = h.part().metadata.pluginUi as any;
    h.store.sessions.create({ id: "s2", cwd: ".", model: "test" });
    await expect(h.service.get("s2", instance.instanceId)).rejects.toMatchObject({ code: "plugin_ui_not_found", status: 404 });
    const original = h.part();
    for (const patch of [{ sourcePartId: "other" }, { sourceRunId: "other" }, { sourceToolUseId: "other" }, { sessionId: "s2" }, { sourceToolName: "Other" }]) {
      h.store.conversations.upsertMessagePart({ ...original, metadata: { pluginUi: { ...instance, ...patch } } });
      await expect(h.service.get("s1", instance.instanceId)).rejects.toMatchObject({ code: "plugin_ui_not_found" });
    }
    h.store.conversations.upsertMessagePart({ ...original, metadata: { ...original.metadata, modelGeneration: { generationId: "gen", attempt: 1, committed: false } } });
    await expect(h.service.get("s1", instance.instanceId)).rejects.toMatchObject({ code: "plugin_ui_not_found" });
    h.store.conversationTransactions.replaceTranscript({ sessionId: "s1", messages: [] });
    await expect(h.service.get("s1", instance.instanceId)).rejects.toMatchObject({ code: "plugin_ui_not_found" });
  });

  it.each([
    [{ enabled: false }, "plugin-disabled", false], [{ uiEnabled: false }, "plugin-disabled", false],
    [{ permissionsApproved: false }, "permission-missing", false], [{ snapshot: "missing" }, "snapshot-missing", false],
    [{ snapshot: "changed" }, "snapshot-changed", false], [{ binding: undefined }, "invalid-definition", false],
    [{ runtimeAvailable: false }, "runtime-unavailable", true],
  ] as const)("computes current availability %s without changing business state", async (patch, code, canRender) => {
    const h = harness(); h.finish(); const instance = h.part().metadata.pluginUi as any;
    h.setCurrent(patch);
    expect((await h.service.get("s1", instance.instanceId)).availability).toEqual({ code, canRender, canInvoke: false });
    expect(h.part().metadata.pluginUi).toEqual(instance);
  });

  it("keeps archived results read-only and rejects current version drift", async () => {
    const h = harness(); h.finish(); const instance = h.part().metadata.pluginUi as any;
    h.setCurrent({ binding: { ...h.binding, pluginVersion: "2.0.0" } });
    expect((await h.service.get("s1", instance.instanceId)).availability.code).toBe("snapshot-changed");
    h.setCurrent({ binding: h.binding });
    h.store.sessions.archive("s1");
    expect((await h.service.get("s1", instance.instanceId)).availability).toEqual({ code: "session-archived", canRender: true, canInvoke: false });
  });

  it("strips host UI identity at the real fork and transcript replacement boundaries", () => {
    const h = harness(); h.finish();
    const source = h.part();
    const fork = h.store.conversationTransactions.forkSessionWithHistory({ sourceSessionId: "s1", session: { cwd: ".", model: "test" } });
    const copy = h.store.conversations.listMessageParts(fork.id).find(p => p.type === "tool")!;
    expect(copy.metadata).not.toHaveProperty("pluginUi");
    expect(copy.output).toEqual(source.output);
    const replaced = h.store.conversationTransactions.replaceTranscript({ sessionId: "s1", messages: [{ role: "assistant", parts: [source] }] });
    expect(replaced.parts[0]!.metadata).not.toHaveProperty("pluginUi");
    expect(replaced.parts[0]!.output).toEqual(source.output);
  });
});
