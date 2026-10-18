import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry, type RunPluginUiBinding, type ToolResult } from "@vykor/core";
import { createRunCapabilityView } from "@vykor/agent-runtime";
import { SessionStore } from "@vykor/services";
import { SessionTranscriptProjection } from "../transcript-projection.js";
import { SessionPluginUiService, type PluginUiCurrentState } from "../session-plugin-ui-service.js";
import { SessionPluginUiConversationService } from "../session-plugin-ui-conversation-service.js";
import { SessionPluginCapabilityService } from "../session-plugin-capability-service.js";
import { SessionOperationRunner } from "../session-operation-runner.js";
import { RunAdmissionService } from "../run-admission-service.js";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const pluginId = "example.ui-fixture";
function fixture(scope: string | readonly string[] = pluginId) {
  const registry = new ToolRegistry();
  registry.register({ name: "Inspect", description: "Inspect text", inputSchema: { type: "object" },
    execute: async () => ({ content: [{ type: "text", text: "done" }] }) }, { kind: "plugin", id: pluginId });
  registry.register({ name: "Fix", description: "Fix text", inputSchema: { type: "object" },
    execute: async () => ({ content: [{ type: "text", text: "fixed" }] }) }, { kind: "plugin", id: pluginId });
  const tools = createRunCapabilityView({ toolRegistry: registry, pluginIds: new Set([pluginId]) }, pluginId).tools;
  const binding: RunPluginUiBinding = {
    pluginId, pluginVersion: "1.0.0", pluginDigest: "a".repeat(64), componentId: "findings",
    componentDigest: "b".repeat(64), htmlSha256: "c".repeat(64), root: "/private/plugin", entryPath: "/private/plugin/ui.html",
    definition: { id: "findings", title: "Findings", entry: "ui.html", surface: "tool-result",
      actions: [{ id: "fix", label: "Fix", tool: "Fix", completion: "resolve" }] },
    actionTools: [tools.get("Fix")!],
  };
  const view = createRunCapabilityView({ toolRegistry: registry, pluginIds: new Set(typeof scope === "string" ? [scope] : scope), pluginUi: [binding] }, scope);
  return { binding, view };
}
function result(): ToolResult {
  return { content: [{ type: "text", text: "Found one issue" }], executionState: "completed",
    metadata: { ui: { schemaVersion: 2, componentId: "findings", data: { count: 1 } },
      pluginUi: { instanceId: "forged" }, uiAction: { instanceId: "forged" }, pluginUiSubmission: { inputId: "forged" }, custom: "retained" } };
}
function harness(automaticOwners?: 1 | 2, verifySourceBinding?: (binding: RunPluginUiBinding) => Promise<boolean>) {
  const directory = mkdtempSync(join(tmpdir(), "vykor-ui-instance-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "session.db");
  let store = new SessionStore({ path });
  cleanup.push(() => store.close());
  const session = store.sessions.create({ id: "s1", cwd: directory, model: "test" });
  const input = store.conversationTransactions.admitPrompt({ sessionId: session.id, content: "inspect" });
  const owners = automaticOwners === 2 ? [pluginId, "other.plugin"] : [pluginId];
  const selection = { status: "resolved", scopeVersion: 2, source: "auto", pluginId: null, reason: "matched", pluginIds: owners,
    candidates: owners.map(id => ({ pluginId: id, displayName: id, description: "", version: "1.0.0", behaviorDigest: "a".repeat(64) })) };
  store.runs.createRun({ id: "run", sessionId: session.id, inputId: input.id, metadata: automaticOwners
    ? { pluginId: null, pluginSelection: selection } : { pluginId } });
  const { binding, view } = fixture(automaticOwners ? owners : pluginId);
  let current: PluginUiCurrentState = { enabled: true, uiEnabled: true, permissionsApproved: true,
    snapshot: "valid", binding, runtimeAvailable: true };
  const diagnostics: unknown[] = [];
  const makeService = () => new SessionPluginUiService({ store, transaction: work => store.transaction(work), resolveCurrent: async () => current,
    ...(verifySourceBinding ? { verifySourceBinding } : {}), diagnose: diagnostic => diagnostics.push(diagnostic) });
  const service = makeService();
  const releaseRootView = service.registerRunView("run", view);
  const projection = new SessionTranscriptProjection(store, service);
  const state = projection.beginRun(session.id, input.id, "run", input);
  projection.projectStreamEvent(state, { type: "generation_started", generationId: "gen", attempt: 1 });
  projection.projectStreamEvent(state, { type: "tool_use_start", toolUse: { type: "tool_use", id: "call", name: "Inspect", input: {} } });
  projection.projectStreamEvent(state, { type: "complete", stopReason: "tool_use" });
  return { get store() { return store; }, session, service, projection, state, binding, view, diagnostics, releaseRootView,
    registerRunCapabilities: (snapshot: Parameters<SessionPluginCapabilityService["authorizeRun"]>[0]) => {
      const capabilities = new SessionPluginCapabilityService({ store, resolveInventory: async () => { throw new Error("No discovery during Run capture"); } });
      capabilities.authorizeRun(snapshot);
      return service.registerRunView(snapshot.scope.runId, snapshot.capabilityView);
    },
    setCurrent: (patch: Partial<PluginUiCurrentState>) => { current = { ...current, ...patch }; },
    part: () => store.conversations.listMessageParts(session.id).find(p => p.id === "call")!,
    finish: (output = result()) => store.transaction(() => projection.projectStreamEvent(state, { type: "tool_use_end", toolUseId: "call", result: output })),
    reopen: () => { store.close(); store = new SessionStore({ path }); return makeService(); },
  };
}

describe("trusted plugin UI source projection", () => {
  it("keeps a newer card view when an older registration of the same view releases", () => {
    const h = harness();
    const first = h.service.registerRunView("run", h.view);
    const second = h.service.registerRunView("run", h.view);
    first();
    h.finish();
    expect(h.part().metadata).toHaveProperty("pluginUi");
    second();
  });

  it("does not carry an in-flight source check into a new registration of the same view", async () => {
    let verified!: () => void;
    const verification = new Promise<boolean>(resolve => { verified = () => resolve(true); });
    const h = harness(undefined, () => verification);
    const preflight = h.service.preflightSource({ runId: "run", toolUseId: "call", toolName: "Inspect", result: result() });
    h.releaseRootView();
    const release = h.service.registerRunView("run", h.view);
    verified();
    await preflight;
    h.finish();
    expect(h.part().metadata).not.toHaveProperty("pluginUi");
    release();
  });

  function childRun(h: ReturnType<typeof harness>, explicit = false) {
    const child = h.store.sessions.create({ id: "worker", parentId: h.session.id, cwd: h.session.cwd,
      model: "test", metadata: { childId: "worker-handle" } });
    const input = h.store.conversationTransactions.admitPrompt({ sessionId: child.id, content: "inspect child" });
    h.store.runs.createRun({ id: "child-run", sessionId: child.id, inputId: input.id,
      metadata: { parentRunId: "run" } });
    h.store.runs.updateRun("child-run", { status: "running" });
    const { view } = fixture(explicit ? pluginId : [pluginId]);
    const snapshot = { scope: { agentId: child.id, sessionId: child.id, inputId: input.id, runId: "child-run",
      traceId: "child-trace", cwd: child.cwd, signal: new AbortController().signal },
      identity: { childId: "worker-handle", parentSessionId: h.session.id, parentRunId: "run" },
      capabilityView: view,
      pluginCandidates: [{ pluginId, displayName: pluginId, description: "", version: "1.0.0", behaviorDigest: "a".repeat(64) }] };
    const state = h.projection.beginRun(child.id, input.id, "child-run", input);
    h.projection.projectStreamEvent(state, { type: "generation_started", generationId: "child-gen", attempt: 1 });
    h.projection.projectStreamEvent(state, { type: "tool_use_start", toolUse: { type: "tool_use", id: "child-call", name: "Inspect", input: {} } });
    h.projection.projectStreamEvent(state, { type: "complete", stopReason: "tool_use" });
    return { child, input, snapshot,
      part: () => h.store.conversations.listMessageParts(child.id).find(p => p.id === "child-call")!,
      finish: () => h.store.transaction(() => h.projection.projectStreamEvent(state,
        { type: "tool_use_end", toolUseId: "child-call", result: result() })) };
  }

  it.each([false, true])("captures the actual worker view and keeps durable UI provenance after release (explicit=%s)", async explicit => {
    const h = harness(explicit ? undefined : 2);
    const child = childRun(h, explicit);
    const release = h.registerRunCapabilities(child.snapshot);
    child.finish();
    const instance = (await import("@vykor/protocol")).readPluginUiInstance(child.part().metadata);
    expect(instance).toMatchObject({ sessionId: child.child.id, sourceRunId: "child-run", pluginId,
      pluginVersion: "1.0.0", pluginDigest: "a".repeat(64) });
    expect(h.store.runs.getRun("child-run")?.metadata).toMatchObject({ parentRunId: "run",
      pluginSelection: { status: "resolved", scopeVersion: 2, pluginIds: [pluginId],
        candidates: [{ pluginId, version: "1.0.0", behaviorDigest: "a".repeat(64) }] } });
    release();
    const service = h.reopen();
    expect((await service.get(child.child.id, instance!.instanceId)).availability.canRender).toBe(true);
    const { actionTools: _actionTools, ...documentBinding } = h.binding;
    h.setCurrent({ binding: undefined, documentBinding, runtimeAvailable: false });
    expect((await service.get(child.child.id, instance!.instanceId)).availability)
      .toEqual({ code: "runtime-unavailable", canRender: true, canInvoke: false });
    const source = await service.prepareConversationSource(child.child.id, instance!.instanceId, "submit", 1);
    expect(source.instance.sourceToolName).toBe("Inspect");
    await expect(service.get(h.session.id, instance!.instanceId)).rejects.toMatchObject({ code: "plugin_ui_not_found" });
  });

  it.each(["session", "input", "cwd", "child", "parent-session", "parent-run", "owner", "version", "digest"])(
    "rejects a worker capability capture with mismatched %s", field => {
      const h = harness(2), child = childRun(h);
      const snapshot = child.snapshot;
      if (field === "session") snapshot.scope.sessionId = h.session.id;
      if (field === "input") snapshot.scope.inputId = "foreign-input";
      if (field === "cwd") snapshot.scope.cwd = join(h.session.cwd, "outside");
      if (field === "child") snapshot.identity.childId = "foreign-child";
      if (field === "parent-session") snapshot.identity.parentSessionId = "foreign-session";
      if (field === "parent-run") snapshot.identity.parentRunId = "foreign-run";
      if (field === "owner") snapshot.pluginCandidates[0]!.pluginId = "other.plugin";
      if (field === "version") snapshot.pluginCandidates[0]!.version = "2.0.0";
      if (field === "digest") snapshot.pluginCandidates[0]!.behaviorDigest = "d".repeat(64);
      expect(() => h.registerRunCapabilities(snapshot)).toThrow("Run plugin capability identity mismatch");
      child.finish();
      expect(child.part().metadata).not.toHaveProperty("pluginUi");
      expect(h.store.runs.getRun("child-run")?.metadata).not.toHaveProperty("pluginSelection");
    });

  it("does not let a root callback replace its saved authorized owner set", () => {
    const h = harness(1), child = childRun(h);
    const snapshot = { ...child.snapshot, identity: undefined, scope: { ...child.snapshot.scope,
      agentId: h.session.id, sessionId: h.session.id, inputId: h.state.inputId, runId: "run" },
      capabilityView: fixture([pluginId, "other.plugin"]).view };
    snapshot.pluginCandidates.push({ ...snapshot.pluginCandidates[0]!, pluginId: "other.plugin" });
    expect(() => h.registerRunCapabilities(snapshot)).toThrow();
    expect(h.store.runs.getRun("run")?.metadata.pluginSelection).toMatchObject({ pluginIds: [pluginId] });
  });

  it("does not broaden an already captured worker Run on repeated registration", () => {
    const h = harness(2), child = childRun(h);
    const release = h.registerRunCapabilities(child.snapshot);
    const widened = { ...child.snapshot, capabilityView: fixture([pluginId, "other.plugin"]).view,
      pluginCandidates: [...child.snapshot.pluginCandidates, { ...child.snapshot.pluginCandidates[0]!, pluginId: "other.plugin" }] };
    expect(() => h.registerRunCapabilities(widened)).toThrow("Run plugin capability identity mismatch");
    expect(h.store.runs.getRun("child-run")?.metadata.pluginSelection).toMatchObject({ pluginIds: [pluginId] });
    release();
  });

  it.each(["valid", "missing-task", "foreign-child", "task-run", "task-kind", "task-source", "plugin", "forged-parent"])(
    "checks durable ownership for a parentless baseline host followup: %s", reason => {
      const h = harness(2), child = childRun(h);
      const input = h.store.conversationTransactions.admitPrompt({ sessionId: child.child.id, content: "host followup" });
      h.store.runs.createRun({ id: "host-followup", sessionId: child.child.id, inputId: input.id,
        ...(reason === "forged-parent" ? { metadata: { parentRunId: "run" } } : {}) });
      h.store.runs.updateRun("host-followup", { status: "running" });
      if (reason !== "missing-task") {
        const other = reason === "foreign-child" ? h.store.sessions.create({ parentId: h.session.id, cwd: h.session.cwd, model: "test" }) : undefined;
        h.store.runs.createSessionTask({ id: "worker-handle", sessionId: h.session.id, childSessionId: other?.id ?? child.child.id,
          ...(other ? {} : { runId: reason === "task-run" ? "child-run" : "host-followup" }),
          type: reason === "task-kind" ? "shell" : "agent", description: "worker", cwd: child.child.cwd, status: "running",
          metadata: { origin: "child_session", executionBackend: "child_agent", runtimeExecutionId: reason === "task-source" ? "foreign" : "worker-handle" } });
      }
      const snapshot = { ...child.snapshot, scope: { ...child.snapshot.scope, inputId: input.id, runId: "host-followup" },
        identity: { childId: "worker-handle" }, capabilityView: reason === "plugin" ? child.snapshot.capabilityView : fixture([]).view,
        pluginCandidates: reason === "plugin" ? child.snapshot.pluginCandidates : [] };
      if (reason === "valid") {
        const release = h.registerRunCapabilities(snapshot);
        expect(h.store.runs.getRun("host-followup")?.metadata).toMatchObject({ pluginId: null,
          pluginSelection: { source: "none", pluginIds: [], candidates: [] } });
        release();
      } else {
        expect(() => h.registerRunCapabilities(snapshot)).toThrow("Run plugin capability identity mismatch");
        expect(h.store.runs.getRun("host-followup")?.metadata).not.toHaveProperty("pluginSelection");
      }
    });

  it.each([false, true])("requires fresh source verification for a worker UI result (verified=%s)", async verified => {
    const h = harness(2, async () => verified), child = childRun(h);
    const release = h.registerRunCapabilities(child.snapshot);
    await h.service.preflightSource({ runId: "child-run", toolUseId: "child-call", toolName: "Inspect", result: result() });
    child.finish();
    expect(Boolean(child.part().metadata.pluginUi)).toBe(verified);
    release();
  });

  it.each([false, true])("rejects durable worker UI after its saved source changes (explicit=%s)", async explicit => {
    const h = harness(explicit ? undefined : 2), child = childRun(h, explicit);
    const release = h.registerRunCapabilities(child.snapshot);
    child.finish(); release();
    const instance = (await import("@vykor/protocol")).readPluginUiInstance(child.part().metadata)!;
    const selection = h.store.runs.getRun("child-run")!.metadata.pluginSelection as Record<string, unknown>;
    h.store.runs.updateRun("child-run", { metadata: { pluginSelection: { ...selection,
      candidates: [{ ...child.snapshot.pluginCandidates[0], version: "2.0.0" }] } } });
    await expect(h.reopen().get(child.child.id, instance.instanceId)).rejects.toMatchObject({ code: "plugin_ui_not_found" });
  });

  it.each([1, 2] as const)("creates automatic UI with %s owners and submits after releasing the view and reopening SQLite", async owners => {
    const h = harness(owners); h.finish();
    const instance = h.part().metadata.pluginUi as { instanceId: string } | undefined;
    expect(instance).toMatchObject({ pluginId, pluginVersion: "1.0.0", pluginDigest: "a".repeat(64) });
    h.releaseRootView();
    const source = h.reopen();
    expect((await source.get("s1", instance!.instanceId)).availability.canRender).toBe(true);
    const events = { checkpoint: () => 0, publishSince: () => {} };
    const operations = new SessionOperationRunner({ sessions: h.store.sessions, events, operationGate: new DaemonOperationGate() });
    const admission = new RunAdmissionService({ conversationTransactions: h.store.conversationTransactions,
      runOperations: h.store.runs, events, runtimeQueue: { hasRuntime: true, enqueueRun: () => "queued", steer: () => ({ merged: false }) } });
    const pluginCapabilities = new SessionPluginCapabilityService({ resolveInventory: async () => ({
      plugins: new Map(), skills: new Map(), agents: new Map(), mcpServers: new Map(), nativeToolEntries: new Map(), diagnostics: [],
    }) });
    const conversation = new SessionPluginUiConversationService({ store: h.store, source, operations, admission,
      pluginCapabilities, modelAvailable: async () => true });
    const receipt = await conversation.submit("s1", instance!.instanceId, { requestId: "00000000-0000-0000-0000-000000000001",
      expectedRevision: 1, text: "Continue from this result", data: { count: 1 } });
    expect(h.store.conversations.getInput(receipt.inputId)!.content).toContain("Continue from this result");
    expect(receipt).toMatchObject({ revision: 2, status: "pending" });
  });

  it.each(["uncaptured-owner", "foreign-tool-source", "foreign-tool-owner", "foreign-ui"])("rejects automatic UI with %s", reason => {
    const h = harness(2);
    const tool = h.view.tools.get("Inspect")!;
    const view = reason === "uncaptured-owner" ? { ...h.view, pluginIds: new Set<string>() }
      : reason === "foreign-ui" ? { ...h.view, pluginUi: new Map([[`${pluginId}:findings`, { ...h.binding, pluginId: "other.plugin" }]]) }
      : { ...h.view, tools: new Map(h.view.tools).set("Inspect", reason === "foreign-tool-source"
        ? { ...tool, source: { kind: "plugin" as const, id: "other.plugin" } } : { ...tool, ownerPluginId: "other.plugin" }) };
    h.service.registerRunView("run", view); h.finish();
    expect(h.part().metadata).not.toHaveProperty("pluginUi");
    expect(h.diagnostics).toHaveLength(1);
  });

  it.each(["owner", "version", "digest", "malformed"])("rejects automatic durable UI after its saved %s changes", async field => {
    const h = harness(2); h.finish();
    const instance = h.part().metadata.pluginUi as { instanceId: string } | undefined;
    expect(instance).toBeDefined();
    const selection = h.store.runs.getRun("run")!.metadata.pluginSelection as { pluginIds: string[]; candidates: Array<Record<string, unknown>> };
    const changed = field === "owner" ? { ...selection, pluginIds: selection.pluginIds.slice(1), candidates: selection.candidates.slice(1) }
      : field === "malformed" ? { ...selection, candidates: [] }
      : { ...selection, candidates: selection.candidates.map((candidate, index) => index === 0
        ? { ...candidate, [field === "version" ? "version" : "behaviorDigest"]: "changed" } : candidate) };
    h.store.runs.updateRun("run", { metadata: { pluginSelection: changed } });
    h.releaseRootView();
    await expect(h.reopen().get("s1", instance!.instanceId)).rejects.toMatchObject({ code: "plugin_ui_not_found" });
  });

  it("rejects a current definition whose surface differs from the persisted instance", async () => {
    const h = harness(); h.finish();
    h.setCurrent({ binding: { ...h.binding, definition: { ...h.binding.definition, surface: "session-sidebar" } } });
    const instance = (await import("@vykor/protocol")).readPluginUiInstance(h.part().metadata)!;
    expect((await h.service.get(h.session.id, instance.instanceId)).availability).toEqual({ code: "invalid-definition", canRender: false, canInvoke: false });
  });
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
    expect(instance).toMatchObject({ schemaVersion: 2, status: "open", revision: 1, sessionId: "s1",
      sourceRunId: "run", sourcePartId: "call", sourceToolUseId: "call", sourceToolName: "Inspect", pluginId,
      pluginVersion: "1.0.0", data: { count: 1 } });
    expect(instance.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.part().metadata).not.toHaveProperty("uiAction");
    expect(h.part().metadata).not.toHaveProperty("pluginUiSubmission");
    expect(h.part().output).toEqual(savedOriginal);
    expect(original).toEqual(savedOriginal);
    h.releaseRootView();
    const response = await h.reopen().get("s1", instance.instanceId);
    expect(response).toMatchObject({ instance, availability: { code: "available", canRender: true, canInvoke: true },
      actions: [{ id: "fix", label: "Fix", toolName: "Fix", inputSchema: { type: "object" }, completion: "resolve" }] });
    expect(response.actions).toEqual([{ id: "fix", label: "Fix", toolName: "Fix", inputSchema: { type: "object" }, completion: "resolve" }]);
    expect(JSON.stringify(response)).not.toContain("/private");
    expect(JSON.stringify(response)).not.toContain('"tool"');
  });

  it.each([
    ["unsupported version", { metadata: { ui: { schemaVersion: 1, componentId: "findings", data: {} } } }],
    ["forged proposal identity", { metadata: { ui: { schemaVersion: 2, componentId: "findings", data: {}, pluginId } } }],
    ["missing component", { metadata: { ui: { schemaVersion: 2, componentId: "other", data: {} } } }],
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
    if (reason === "uncaptured") h.releaseRootView();
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
    h.releaseRootView();
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
      schemaVersion: 2, instanceId: instance.instanceId, requestId: "00000000-0000-0000-0000-000000000001",
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
