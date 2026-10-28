import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { pluginAppHarness } from "../../../test-helpers/plugin-app-harness.js";
import { CURRENT_PROTOCOL_VERSION, readPluginUiAction } from "@vykor/protocol";
import type { PluginUiInstanceRecord, PluginUiActionRunMetadata } from "@vykor/protocol";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("retains original history across restart, refuses every old admission and both generic resumes", async () => {
  const h = await pluginAppHarness("native-tools"); cleanup.push(h.close);
  let store = h.store(); const sessionId = h.session.id;
  const instanceId = "10000000-0000-4000-8000-000000000001", requestId = "20000000-0000-4000-8000-000000000001";
  const runId = "ui_run_" + createHash("sha256").update(JSON.stringify([sessionId, instanceId, requestId])).digest("hex");
  const input = store.conversationTransactions.admitPrompt({ sessionId, content: "original input" });
  store.runs.createRun({ id: "old-source", sessionId, inputId: input.id, metadata: { pluginId: "legacy.plugin" } });
  store.runs.updateRun("old-source", { status: "completed" });
  store.conversations.createMessage({ id: "source-message", sessionId, role: "assistant", runId: "old-source" });
  const instance: PluginUiInstanceRecord = { schemaVersion: 2, instanceId, sessionId, sourceRunId: "old-source", sourcePartId: "source-part", sourceToolUseId: "source-tool", sourceToolName: "Inspect",
    pluginId: "legacy.plugin", pluginVersion: "1", pluginDigest: "a".repeat(64), componentId: "panel", componentDigest: "b".repeat(64), title: "Old result", surface: "tool-result", status: "open", revision: 1, data: { original: true }, createdAt: 1, updatedAt: 1, activeActionRunId: runId };
  const sourceOutput = { content: [{ type: "text", text: "Original result" }], executionState: "completed" };
  store.conversations.upsertMessagePart({ id: "source-part", sessionId, messageId: "source-message", type: "tool", toolUseId: "source-tool", toolName: "Inspect", status: "completed", output: sourceOutput,
    metadata: { executionState: "completed", pluginUi: instance } });
  const action: PluginUiActionRunMetadata = { schemaVersion: 2, instanceId, requestId, requestFingerprint: "c".repeat(64), expectedRevision: 0, actionId: "save", label: "Save", args: { text: "original" },
    pluginId: instance.pluginId, pluginVersion: instance.pluginVersion, pluginDigest: instance.pluginDigest, componentDigest: instance.componentDigest, toolName: "Save", toolUseId: "old-action-tool", executionState: "unknown" };
  store.runs.createRun({ id: runId, sessionId, inputId: input.id, metadata: { uiAction: action } });
  store.runs.updateRun(runId, { status: "running" });
  const pendingId = "ui_run_" + createHash("sha256").update(JSON.stringify([sessionId, instanceId, "30000000-0000-4000-8000-000000000001"])).digest("hex");
  const pending = { ...action, requestId: "30000000-0000-4000-8000-000000000001", toolUseId: "pending-tool", executionState: "not_started" as const };
  store.runs.createRun({ id: pendingId, sessionId, metadata: { uiAction: pending } });
  const completeId = "ui_run_" + createHash("sha256").update(JSON.stringify([sessionId, instanceId, "40000000-0000-4000-8000-000000000001"])).digest("hex");
  const complete = { ...action, requestId: "40000000-0000-4000-8000-000000000001", toolUseId: "complete-tool", executionState: "unknown" as const };
  store.runs.createRun({ id: completeId, sessionId, metadata: { uiAction: complete } });
  const missingId = "ui_run_" + createHash("sha256").update(JSON.stringify([sessionId, instanceId, "60000000-0000-4000-8000-000000000001"])).digest("hex");
  const missing = { ...action, requestId: "60000000-0000-4000-8000-000000000001", toolUseId: "missing-tool", executionState: "completed" as const };
  store.runs.createRun({ id: missingId, sessionId, metadata: { uiAction: missing } });
  store.conversations.createMessage({ id: "complete-message", sessionId, role: "assistant", runId: completeId });
  const originalResult = { content: [{ type: "text", text: "Actual saved result" }], executionState: "completed" };
  store.conversations.upsertMessagePart({ id: "complete-tool", sessionId, messageId: "complete-message", type: "tool", toolUseId: "complete-tool", status: "completed", output: originalResult });
  await h.restart(reopened => {
    // Seed durable process-loss states immediately before the real production startup recovery.
    reopened.runs.updateRun(runId, { status: "running", metadata: { uiAction: action } });
    reopened.runs.updateRun(pendingId, { status: "pending", metadata: { uiAction: pending } });
    reopened.runs.updateRun(completeId, { status: "running", metadata: { uiAction: complete } });
    reopened.runs.updateRun(missingId, { status: "running", metadata: { uiAction: missing } });
  });
  store = h.store();
  expect(store.runs.getRun(pendingId)?.status).toBe("interrupted");
  expect(readPluginUiAction(store.runs.getRun(pendingId)?.metadata)).toEqual(pending);
  expect(store.runs.getRun(completeId)?.status).toBe("completed");
  expect((await h.client().pluginUiHistory.getAction(sessionId, instanceId, complete.requestId)).result).toEqual(originalResult);
  expect(store.runs.getRun(runId)?.status).toBe("interrupted");
  expect(readPluginUiAction(store.runs.getRun(runId)?.metadata)).toEqual(action);
  expect(store.runs.getRun(missingId)?.status).toBe("interrupted");
  expect(readPluginUiAction(store.runs.getRun(missingId)?.metadata)).toEqual({ ...missing, executionState: "unknown" });
  const receipt = await h.client().pluginUiHistory.getAction(sessionId, instanceId, requestId);
  expect(receipt.receipt).toMatchObject({ runId, requestId, instanceId, status: "interrupted" });
  for (const suffix of ["", "/document", "/actions", "/dismiss", "/conversation/prepare", "/conversation/submissions"]) {
    const response = await h.raw(`/sessions/${sessionId}/plugin-ui/${instanceId}${suffix}`, suffix === "/document" || suffix === "" ? undefined : {});
    expect(response.status).toBe(410); expect(await response.json()).toMatchObject({ code: "plugin_ui_retired" });
  }
  await expect(h.client().sessions.resumeInterruptedRun(sessionId, runId)).rejects.toMatchObject({ status: 409 });
  store.runs.createRun({ id: "app-interrupted", sessionId, inputId: input.id, metadata: { pluginAppAction: { executionState: "unknown" } } });
  store.runs.updateRun("app-interrupted", { status: "interrupted" });
  await expect(h.client().sessions.resumeInterruptedRun(sessionId, "app-interrupted")).rejects.toMatchObject({ status: 409 });
  store.runs.createRun({ id: "corrupt-old-action", sessionId, inputId: input.id, metadata: { uiAction: {} } });
  store.runs.updateRun("corrupt-old-action", { status: "interrupted" });
  await expect(h.client().sessions.resumeInterruptedRun(sessionId, "corrupt-old-action")).rejects.toMatchObject({ status: 409 });
  const current = store.conversations.listMessageParts(sessionId).find(part => part.id === "source-part")!;
  const submissionId = "50000000-0000-4000-8000-000000000001";
  const submission = { schemaVersion: 2, requestId: submissionId, requestFingerprint: "e".repeat(64), expectedRevision: 0,
    inputId: input.id, runId: "old-source", pluginDigest: instance.pluginDigest, componentDigest: instance.componentDigest, acceptedAt: 1 };
  store.conversations.upsertMessagePart({ ...current, metadata: { ...current.metadata,
    pluginUi: { ...(current.metadata.pluginUi as PluginUiInstanceRecord), status: "resolved" }, pluginUiSubmission: submission } });
  const submitted = await h.client().pluginUiHistory.getConversationSubmission(sessionId, instanceId, submissionId);
  expect(submitted).toMatchObject({ inputId: input.id, runId: "old-source", requestId: submissionId, status: "completed" });
  const unauthorized = await h.server().app.request(`/sessions/${sessionId}/plugin-ui/${instanceId}/actions/${requestId}`,
    { headers: { "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION) } });
  expect(unauthorized.status).toBe(401);
  const prior = store.conversations.listMessageParts(sessionId).find(part => part.id === "source-part");
  await h.restart();
  expect(await h.client().pluginUiHistory.getAction(sessionId, instanceId, requestId)).toEqual(receipt);
  expect(await h.client().pluginUiHistory.getConversationSubmission(sessionId, instanceId, submissionId)).toEqual(submitted);
  expect(h.store().conversations.listMessageParts(sessionId).find(part => part.id === "source-part")).toEqual(prior);
  await expect(h.client().pluginUiHistory.getAction("foreign", instanceId, requestId)).rejects.toMatchObject({ status: 404 });
  expect(h.effects()).toBe(0); expect(h.modelCalls()).toBe(0);
  console.info(JSON.stringify({ scenario: "retired-startup-no-replay", sourcePartId: prior!.id, originalInputId: input.id,
    runIdsPreserved: [pendingId, runId, completeId, missingId].every(id => h.store().runs.getRun(id)?.id === id),
    states: [pendingId, runId, completeId, missingId].map(id => ({ id, status: h.store().runs.getRun(id)?.status,
      executionState: readPluginUiAction(h.store().runs.getRun(id)?.metadata)?.executionState })),
    originalFingerprintPreserved: readPluginUiAction(h.store().runs.getRun(runId)?.metadata)?.requestFingerprint === action.requestFingerprint,
    originalResultPreserved: JSON.stringify((await h.client().pluginUiHistory.getAction(sessionId, instanceId, complete.requestId)).result) === JSON.stringify(originalResult),
    toolExecutions: h.effects(), modelCalls: h.modelCalls() }));
}, 30_000);

it("turns Apps off without activating legacy UI or replaying receipts and retains normal tool text", async () => {
  const h = await pluginAppHarness("native-tools", true); cleanup.push(h.close);
  const first = await h.client().pluginApps.invoke(h.request); await h.wait(first.receipt.runId);
  const response = await h.server().app.request("/settings", { method: "PATCH", headers: { authorization: "Bearer app-token", "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION), "content-type": "application/json" }, body: JSON.stringify({ plugins: { uiEnabled: false } }) });
  // Use the same public version negotiated by the Client for all protocol requests.
  if (response.status === 426) throw new Error("fixture protocol version must match CURRENT_PROTOCOL_VERSION");
  expect(response.status).toBe(200);
  expect((await h.client().protocol.capabilities()).features).not.toHaveProperty("pluginUi");
  expect((await h.client().pluginApps.catalog(h.session.id)).backends).toEqual([]);
  expect((await h.client().pluginApps.getAction(h.opened.source, h.request.requestId)).receipt.runId).toBe(first.receipt.runId);
  await expect(h.client().pluginApps.invoke({ ...h.request, requestId: "off" })).rejects.toMatchObject({ status: 409 });
  const submitted = await h.server().application.interactions.admitPrompt(h.session.id, { items: [{ type: "text", text: "save normally" }, { type: "capability", kind: "plugin", pluginId: h.pluginId, displayName: "App" }] });
  await h.wait(submitted.run!.id);
  expect(h.store().runs.getRun(submitted.run!.id)).toMatchObject({ status: "completed" });
  const messageIds = new Set(h.store().conversations.listMessages(h.session.id)
    .filter(message => message.runId === submitted.run!.id).map(message => message.id));
  expect(h.store().conversations.listMessageParts(h.session.id)
    .filter(part => messageIds.has(part.messageId))).toContainEqual(expect.objectContaining({
      type: "tool", toolName: "SaveDocument", status: "completed",
      output: expect.objectContaining({ content: expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "Saved" }),
      ]) }),
    }));
  expect(h.effects()).toBe(2);
}, 30_000);
