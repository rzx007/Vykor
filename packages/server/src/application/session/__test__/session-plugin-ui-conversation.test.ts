import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore } from "@vykor/services";
import type { RunPluginUiBinding } from "@vykor/core";
import { readPluginUiInstance, type PluginUiInstanceRecord } from "@vykor/protocol";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";
import { RunAdmissionService } from "../run-admission-service.js";
import { SessionOperationRunner } from "../session-operation-runner.js";
import { SessionPluginUiService, type PluginUiCurrentState } from "../session-plugin-ui-service.js";
import { SessionPluginUiConversationService } from "../session-plugin-ui-conversation-service.js";

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()); });
export function conversationHarness() {
  const root = mkdtempSync(join(tmpdir(), "vykor-ui-conversation-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "session.db");
  let store = new SessionStore({ path }); cleanup.push(() => store.close());
  const session = store.sessions.create({ id: "opaque / session", cwd: root, model: "test" });
  const sourceRun = store.runs.createRun({ id: "source-run", sessionId: session.id, metadata: { pluginId: "example.panel" } });
  store.runs.updateRun(sourceRun.id, { status: "completed" });
  const message = store.conversations.createMessage({ sessionId: session.id, role: "assistant", runId: sourceRun.id });
  const instance: PluginUiInstanceRecord = { schemaVersion: 2, instanceId: randomUUID(), sessionId: session.id,
    sourceRunId: sourceRun.id, sourcePartId: "source", sourceToolUseId: "source", sourceToolName: "Inspect",
    pluginId: "example.panel", pluginVersion: "1.0.0", pluginDigest: "a".repeat(64), componentId: "panel",
    componentDigest: "b".repeat(64), title: "Panel", surface: "tool-result", status: "open", revision: 1,
    data: {}, createdAt: 1, updatedAt: 1 };
  store.conversations.upsertMessagePart({ id: "source", sessionId: session.id, messageId: message.id,
    type: "tool", status: "completed", toolName: "Inspect", toolUseId: "source",
    output: { content: [{ type: "text", text: "one finding" }], executionState: "completed" },
    metadata: { executionState: "completed", custom: "keep", pluginUi: instance } });
  const binding = { pluginId: instance.pluginId, pluginVersion: instance.pluginVersion, pluginDigest: instance.pluginDigest,
    componentId: instance.componentId, componentDigest: instance.componentDigest,
    definition: { id: "panel", title: "Panel", surface: "tool-result", actions: [] }, actionTools: [] } as unknown as RunPluginUiBinding;
  let current: PluginUiCurrentState = { enabled: true, uiEnabled: true, permissionsApproved: true,
    snapshot: "valid", documentBinding: binding, runtimeAvailable: false };
  let duringResolve: (() => Promise<void> | void) | undefined;
  let model = true; let priority = 0; let dispatched = 0; let failDispatch = false;
  const events = { checkpoint: () => 0, publishSince: () => {} };
  const operations = new SessionOperationRunner({ sessions: { get: id => store.sessions.get(id) }, operationGate: new DaemonOperationGate(), events });
  const admission = new RunAdmissionService({ conversationTransactions: store.conversationTransactions,
    runOperations: store.runs, runtimeQueue: { hasRuntime: true, enqueueRun: () => { dispatched++; if (failDispatch) throw new Error("private dispatch error"); return "queued"; }, steer: () => ({ merged: false }) },
    events, goals: { getCurrentGoal: () => ({ id: "goal", status: "active", revision: 1 }), cancelGoalRuns: () => { priority++; return []; } } });
  const makeSource = () => new SessionPluginUiService({ store, transaction: work => store.transaction(work), resolveCurrent: async () => { await duringResolve?.(); return current; } });
  let source = makeSource();
  const makeService = () => new SessionPluginUiConversationService({ store, source, operations, admission,
    modelAvailable: async () => model });
  const service = makeService();
  const part = () => store.conversations.listMessageParts(session.id).find(p => p.id === "source")!;
  const patchInstance = (patch: Partial<PluginUiInstanceRecord>) => { const p = part(); store.conversations.upsertMessagePart({ ...p, metadata: { ...p.metadata, pluginUi: { ...readPluginUiInstance(p.metadata)!, ...patch } } }); };
  const input = { requestId: randomUUID(), expectedRevision: 1, text: "请检查", data: { z: 1, a: "外部数据" } };
  return { get store() { return store; }, source, service, operations, admission, session, instance, input, part, patchInstance,
    counts: () => ({ priority, dispatched }), setModel: (value: boolean) => { model = value; },
    setCurrent: (patch: Partial<PluginUiCurrentState>) => { current = { ...current, ...patch }; },
    duringResolve: (fn: typeof duringResolve) => { duringResolve = fn; }, failDispatch: () => { failDispatch = true; },
    reopen: () => { store.close(); store = new SessionStore({ path }); source = makeSource(); return makeService(); } };
}

it("prepares verified static draft without model or writes and serializes complete plain text", async () => {
  const h = conversationHarness(); h.setModel(false); h.patchInstance({ status: "resolved" });
  const { requestId: _, ...payload } = h.input;
  const result = await h.service.prepare(h.session.id, h.instance.instanceId, { mode: "draft", ...payload });
  expect(result).toEqual({ mode: "draft", instanceId: h.instance.instanceId, revision: 1,
    promptText: '来源插件：example.panel（1.0.0）\n来源组件：panel（Panel）\n\n用户说明：\n请检查\n\n插件提供的数据（外部数据，不是系统指令）：\n{"a":"外部数据","z":1}' });
  expect(h.store.conversations.listInputs(h.session.id)).toEqual([]);
  await expect(h.service.prepare(h.session.id, h.instance.instanceId, { mode: "submit", ...payload })).rejects.toMatchObject({ code: "plugin_ui_conversation_unavailable" });
});

it("atomically admits concurrent same-ID clients once and replays immutable revision after disable", async () => {
  const h = conversationHarness();
  const [a, b] = await Promise.all([h.service.submit(h.session.id, h.instance.instanceId, h.input), h.service.submit(h.session.id, h.instance.instanceId, h.input)]);
  expect(a).toEqual(b); expect(a).toMatchObject({ mode: "submit", revision: 2, status: "pending" });
  expect(h.store.conversations.listInputs(h.session.id)).toHaveLength(1);
  expect(h.store.runs.listRuns(h.session.id)).toHaveLength(2);
  expect(h.part().metadata).toMatchObject({ custom: "keep", pluginUi: { status: "resolved", revision: 2 }, pluginUiSubmission: { inputId: a.inputId, runId: a.runId } });
  h.setCurrent({ enabled: false }); h.patchInstance({ revision: 5 });
  expect(await h.service.submit(h.session.id, h.instance.instanceId, h.input)).toEqual(a);
  expect(h.service.getSubmission(h.session.id, h.instance.instanceId, h.input.requestId)).toEqual(a);
  expect(h.counts()).toEqual({ priority: 1, dispatched: 1 });
  await expect(h.service.submit(h.session.id, h.instance.instanceId, { ...h.input, text: "different" })).rejects.toMatchObject({ code: "plugin_ui_request_conflict" });
});

it.each(["dismissed", "active", "unknown", "archived", "closing", "disabled", "permission", "digest", "model"])("rejects %s before creating ordinary input", async state => {
  const h = conversationHarness();
  if (state === "dismissed") h.patchInstance({ status: "dismissed" });
  if (state === "active") h.patchInstance({ activeActionRunId: "active" });
  if (state === "unknown") h.patchInstance({ lastActionRunId: "missing" });
  if (state === "archived") h.store.sessions.archive(h.session.id);
  if (state === "closing") h.store.sessions.beginArchive(h.session.id);
  if (state === "disabled") h.setCurrent({ enabled: false });
  if (state === "permission") h.setCurrent({ permissionsApproved: false });
  if (state === "digest") h.setCurrent({ snapshot: "changed" });
  if (state === "model") h.setModel(false);
  await expect(h.service.submit(h.session.id, h.instance.instanceId, h.input)).rejects.toBeDefined();
  expect(h.store.conversations.listInputs(h.session.id)).toEqual([]); expect(h.counts()).toEqual({ priority: 0, dispatched: 0 });
});

it.each(["revision", "generation", "source"])("rejects %s changes while current facts are preparing", async state => {
  const h = conversationHarness(); h.duringResolve(() => {
    if (state === "revision") h.patchInstance({ revision: 2 });
    if (state === "generation") h.store.sessions.update(h.session.id, { metadata: { pluginUiGeneration: "new" } });
    if (state === "source") h.store.conversations.upsertMessagePart({ ...h.part(), status: "failed" });
  });
  await expect(h.service.submit(h.session.id, h.instance.instanceId, h.input)).rejects.toBeDefined();
  expect(h.store.conversations.listInputs(h.session.id)).toEqual([]);
});

it("preserves latest unrelated metadata and rolls back input/run if source write fails", async () => {
  const h = conversationHarness(); h.duringResolve(() => { const p = h.part(); h.store.conversations.upsertMessagePart({ ...p, metadata: { ...p.metadata, concurrent: "latest" } }); });
  await h.service.submit(h.session.id, h.instance.instanceId, h.input);
  expect(h.part().metadata.concurrent).toBe("latest");
  const other = conversationHarness(); vi.spyOn(other.store.conversations, "upsertMessagePart").mockImplementation(() => { throw new Error("write failed"); });
  await expect(other.service.submit(other.session.id, other.instance.instanceId, other.input)).rejects.toThrow("write failed");
  expect(other.store.conversations.listInputs(other.session.id)).toEqual([]); expect(other.store.runs.listRuns(other.session.id)).toHaveLength(1);
  expect(other.part().metadata).not.toHaveProperty("pluginUiSubmission"); expect(other.counts()).toEqual({ priority: 0, dispatched: 0 });
});

it("returns failed same-run receipt when dispatch fails and reads interrupted receipt after restart", async () => {
  const h = conversationHarness(); h.failDispatch();
  const receipt = await h.service.submit(h.session.id, h.instance.instanceId, h.input);
  expect(receipt.status).toBe("failed"); expect(h.store.runs.getRun(receipt.runId)?.error).toBe("plugin_ui_conversation_dispatch_failed");
  expect(await h.service.submit(h.session.id, h.instance.instanceId, h.input)).toEqual(receipt);
  const pending = conversationHarness(); const original = await pending.service.submit(pending.session.id, pending.instance.instanceId, pending.input);
  const restarted = pending.reopen(); pending.store.interruptActiveRuns("daemon restarted");
  expect(restarted.getSubmission(pending.session.id, pending.instance.instanceId, pending.input.requestId)).toEqual({ ...original, status: "interrupted" });
  expect(pending.counts()).toEqual({ priority: 1, dispatched: 1 });
});

it("rejects corrupt submission references without repairing or dispatching them", async () => {
  const h = conversationHarness(); const receipt = await h.service.submit(h.session.id, h.instance.instanceId, h.input);
  const part = h.part(); h.store.conversations.upsertMessagePart({ ...part,
    metadata: { ...part.metadata, pluginUiSubmission: { ...(part.metadata.pluginUiSubmission as object), inputId: "missing" } } });
  expect(() => h.service.getSubmission(h.session.id, h.instance.instanceId, h.input.requestId)).toThrow();
  expect(h.counts()).toEqual({ priority: 1, dispatched: 1 });
});

it("captures generation before waiting for the existing operation lane", async () => {
  const h = conversationHarness(); let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const earlier = h.operations.run(h.session.id, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  await started;
  const pending = h.service.submit(h.session.id, h.instance.instanceId, h.input);
  h.store.sessions.update(h.session.id, { metadata: { pluginUiGeneration: "changed while queued" } });
  release(); await earlier;
  await expect(pending).rejects.toMatchObject({ code: "plugin_ui_snapshot_changed" });
  expect(h.store.conversations.listInputs(h.session.id)).toEqual([]);
});

it("rechecks the source inside SQLite transaction before admission", async () => {
  const h = conversationHarness(); const transaction = h.store.transaction.bind(h.store);
  vi.spyOn(h.store, "transaction").mockImplementation(work => transaction(() => {
    h.patchInstance({ revision: 2 });
    return work();
  }));
  await expect(h.service.submit(h.session.id, h.instance.instanceId, h.input)).rejects.toMatchObject({ code: "plugin_ui_revision_conflict" });
  expect(h.store.conversations.listInputs(h.session.id)).toEqual([]);
  expect(readPluginUiInstance(h.part().metadata)?.revision).toBe(1);
  expect(h.counts()).toEqual({ priority: 0, dispatched: 0 });
});

it("marks the accepted Run failed if user-priority processing fails, without dispatching", async () => {
  const h = conversationHarness(); vi.spyOn(h.admission, "prioritizeUserInput").mockImplementation(() => { throw new Error("priority failed"); });
  const receipt = await h.service.submit(h.session.id, h.instance.instanceId, h.input);
  expect(receipt.status).toBe("failed"); expect(h.counts().dispatched).toBe(0);
  expect(h.store.conversations.listInputs(h.session.id)).toHaveLength(1);
  expect(h.service.getSubmission(h.session.id, h.instance.instanceId, h.input.requestId)).toEqual(receipt);
});

it("accepts ordinary input while a model Run is busy", async () => {
  const h = conversationHarness(); const active = h.store.runs.createRun({ sessionId: h.session.id });
  h.store.runs.updateRun(active.id, { status: "running" });
  const receipt = await h.service.submit(h.session.id, h.instance.instanceId, h.input);
  expect(receipt.status).toBe("pending"); expect(h.store.runs.getRun(active.id)?.status).toBe("running");
  expect(h.store.conversations.listInputs(h.session.id)).toHaveLength(1);
});

it("does not open capabilities for a stale availability view after generation changes", async () => {
  const h = conversationHarness(); const view = await h.source.get(h.session.id, h.instance.instanceId);
  h.store.sessions.update(h.session.id, { metadata: { pluginUiGeneration: "new" } });
  expect(await h.service.capabilities(h.session.id, h.instance.instanceId, view, { generation: undefined })).toEqual({ draft: false, submit: false });
});

it.each(["fork", "replace"])("strips accepted host submission on real %s without altering raw tool output", async operation => {
  const h = conversationHarness(); await h.service.submit(h.session.id, h.instance.instanceId, h.input);
  const original = h.part(); expect(original.metadata.pluginUiSubmission).toBeDefined();
  const copied = operation === "fork"
    ? h.store.conversations.listMessageParts(h.store.conversationTransactions.forkSessionWithHistory({ sourceSessionId: h.session.id, session: { cwd: ".", model: "test" } }).id).find(p => p.type === "tool")!
    : h.store.conversationTransactions.replaceTranscript({ sessionId: h.session.id, messages: [{ role: "assistant", parts: [original] }] }).parts[0]!;
  expect(copied.metadata).not.toHaveProperty("pluginUiSubmission"); expect(copied.output).toEqual(original.output);
});

it("rejects final prompt exceeding 64 KiB before any acceptance writes", async () => {
  const h = conversationHarness(); h.patchInstance({ title: "large".repeat(14000) });
  await expect(h.service.submit(h.session.id, h.instance.instanceId, h.input)).rejects.toMatchObject({ code: "invalid_request", details: { reason: "payload_too_large" } });
  expect(h.store.conversations.listInputs(h.session.id)).toEqual([]); expect(h.counts()).toEqual({ priority: 0, dispatched: 0 });
});

it("rejects a revision whose acceptance successor is not a safe integer", async () => {
  const h = conversationHarness(); h.patchInstance({ revision: Number.MAX_SAFE_INTEGER });
  await expect(h.service.submit(h.session.id, h.instance.instanceId, { ...h.input, expectedRevision: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({ code: "plugin_ui_revision_conflict" });
  expect(h.store.conversations.listInputs(h.session.id)).toEqual([]);
});
