import { afterEach, expect, it, vi } from "vitest";
import { getInstalledPluginStorePath } from "@vykor/host-config";
import { updateInstalledPluginStore } from "@vykor/plugins";
import { HookExecutor } from "@vykor/hooks";
import { pluginAppHarness } from "../../../../../test-helpers/plugin-app-harness.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture(kind: "native-tools" | "mcp-server") { const h = await pluginAppHarness(kind); cleanups.push(h.close); return h; }

it("reports busy only before admission and permits a fresh retry without duplicate effects", async () => {
  const h = await fixture("native-tools");
  h.store().runs.createRun({ id: "other-work", sessionId: h.session.id });
  await expect(h.client().pluginApps.invoke(h.request)).rejects.toMatchObject({ status: 409, body: {
    code: "plugin_app_not_accepted", kind: "tool", reason: "busy", source: h.request.source,
    requestId: h.request.requestId, expectedRevision: h.request.expectedRevision,
  } });
  expect(h.store().runs.listRuns(h.session.id)).toHaveLength(1);
  expect(h.effects()).toBe(0);
  h.store().runs.updateRun("other-work", { status: "completed" });
  const accepted = await h.client().pluginApps.invoke(h.request);
  await h.wait(accepted.receipt.runId);
  expect(h.effects()).toBe(1);
  const stale = await h.client().pluginApps.invoke({ ...h.request, requestId: "stale" }).catch(error => error);
  // A stale revision must not be advertised as safely retryable busy work.
  expect(stale).toMatchObject({ status: 409, body: { code: "plugin_app_not_accepted" } });
  expect(stale.body).not.toHaveProperty("reason", "busy");
}, 30_000);

it("admits a declared payload over 1 MiB with one original receipt and no repeated permission review", async () => {
  const h = await pluginAppHarness("native-tools", false, true); cleanups.push(h.close);
  // The saved result exceeds the page-result budget, while the original Run must remain completed.
  const request = { ...h.request, args: { value: "x".repeat(1100 * 1024) } };
  const accepted = await h.client().pluginApps.invoke(request);
  await h.wait(accepted.receipt.runId);
  const settled = await h.client().pluginApps.getAction(request.source, request.requestId);
  expect(settled.receipt).toMatchObject({ status: "completed", executionState: "completed" });
  expect(settled.dataError).toBeDefined();
  expect((await h.client().pluginApps.invoke(request)).receipt).toEqual(settled.receipt);
  const part = h.store().conversations.listMessageParts(h.session.id).find(p => p.type === "tool");
  expect(part?.input).toEqual(request.args);
  expect(h.effects()).toBe(1);
  expect(h.reviews).toHaveLength(0);
  expect(h.store().runs.listRuns(h.session.id)).toHaveLength(1);
}, 30_000);

it.each(["native-tools", "mcp-server"] as const)("deduplicates %s by stable identity, retains exact result, rejects revision drift", async kind => {
  const h = await fixture(kind);
  const [a, b] = await Promise.all([h.client().pluginApps.invoke(h.request), h.client().pluginApps.invoke(h.request)]);
  expect(a.receipt.runId).toBe(b.receipt.runId);
  await h.wait(a.receipt.runId);
  const result = await h.client().pluginApps.getAction(h.opened.source, h.request.requestId);
  expect(result.receipt.executionState).toBe("completed");
  expect(result.result?.structuredContent).toEqual({ value: "approved" });
  expect(h.effects()).toBe(1); expect(h.modelCalls()).toBe(0);
  expect(h.store().runs.listRuns(h.session.id)).toHaveLength(1);
  expect(h.store().conversations.listInputs(h.session.id)).toHaveLength(0);
  const changedLease = { ...h.request, lease: { ...h.request.lease, token: "expired" } };
  expect((await h.client().pluginApps.invoke(changedLease)).receipt).toEqual(result.receipt);
  for (const patch of [{ args: { value: "different" } }, { expectedRevision: 2 }])
    await expect(h.client().pluginApps.invoke({ ...h.request, ...patch })).rejects.toMatchObject({ status: 409 });
  await h.client().pluginApps.close(h.opened.source, { expectedRevision: 2 });
  expect((await h.client().pluginApps.getAction(h.opened.source, h.request.requestId)).receipt).toEqual(result.receipt);
  expect(h.reviews[0]?.evidence.userInstruction).toContain("approved");
}, 30_000);

it("keeps a Native write error unknown and blocks replay despite a forged not_started result", async () => {
  const h = await fixture("native-tools");
  const request = { ...h.request, args: { value: "forge" } };
  const accepted = await h.client().pluginApps.invoke(request); await h.wait(accepted.receipt.runId);
  const response = await h.client().pluginApps.getAction(h.opened.source, "request");
  // The IPC response proves the callback returned, not that every write effect is known.
  expect(response.receipt).toMatchObject({ status: "failed", executionState: "unknown" });
  expect(response.result).toBeUndefined();
  const parts = h.store().conversations.listMessageParts(h.session.id).filter(p => p.type === "tool");
  expect(parts).toHaveLength(1);
  expect(parts[0]?.output).toMatchObject({ content: [{ type: "text", text: "Saved" }], isError: true, executionState: "unknown", metadata: { appData: { value: "forge" } } });
  const operations = h.store().toolOperations.list({ runId: accepted.receipt.runId });
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({ kind: "non_replayable", state: "unknown", result: parts[0]?.output });
  expect(h.store().toolOperations.listAttempts(operations[0]!.id)).toMatchObject([{ status: "unknown", result: parts[0]?.output }]);
  expect((await h.client().pluginApps.invoke(request)).receipt).toEqual(response.receipt);
  const prepared = await h.client().pluginApps.prepare(h.opened.source);
  expect(prepared.availability).toMatchObject({ canInvokeTools: false, reason: "action-unconfirmed" });
  await expect(h.client().pluginApps.invoke({ ...request, requestId: "retry", lease: prepared.lease!, expectedRevision: prepared.app.controlRevision })).rejects.toMatchObject({ status: 409 });
  expect(h.effects()).toBe(1); expect(h.modelCalls()).toBe(0);
  expect(h.store().runs.listRuns(h.session.id)).toHaveLength(1);
}, 30_000);

it.each(["native-tools", "mcp-server"] as const)("preserves closed state and unknown execution when a running %s call is cancelled", async kind => {
  const h = await fixture(kind);
  const first = await h.client().pluginApps.invoke({ ...h.request, args: { value: "approved", wait: true } });
  await expect.poll(h.effects, { timeout: 15_000 }).toBe(1);
  await h.client().pluginApps.close(h.opened.source, { expectedRevision: 1 });
  await h.client().pluginApps.cancelAction(h.opened.source, "request"); await h.wait(first.receipt.runId);
  expect(h.store().pluginApps.get(h.opened.app.id)).toMatchObject({ status: "closed", controlRevision: 3, lastActionRunId: first.receipt.runId });
  expect((await h.client().pluginApps.getAction(h.opened.source, "request")).receipt.executionState).toBe("unknown");
  expect(h.effects()).toBe(1); expect(h.modelCalls()).toBe(0);
}, 30_000);

it.each(["native-tools", "mcp-server"] as const)("keeps %s unknown after failed result save, reopen and daemon restart, and rejects generic resume", async kind => {
  const h = await fixture(kind);
  const original = h.store().conversations.upsertMessagePart.bind(h.store().conversations);
  let fault = true;
  vi.spyOn(h.store().conversations, "upsertMessagePart").mockImplementation(input => {
    if (fault && input.output !== undefined) { fault = false; throw new Error("disk failure after side effect"); }
    return original(input);
  });
  const first = await h.client().pluginApps.invoke(h.request); await h.wait(first.receipt.runId);
  expect((await h.client().pluginApps.getAction(h.opened.source, "request")).receipt.executionState).toBe("unknown");
  expect(h.effects()).toBe(1);
  await h.client().pluginApps.close(h.opened.source, { expectedRevision: 2 });
  await h.restart();
  const reopened = await h.client().pluginApps.open(h.session.id, { pluginId: h.pluginId, surfaceId: "editor" });
  expect(reopened.app.id).toBe(h.opened.app.id); expect(reopened.availability.reason).toBe("action-unconfirmed");
  expect((await h.raw("/plugins/reload", { cwd: h.root })).status).toBe(200);
  expect((await h.client().pluginApps.prepare(reopened.source)).availability.reason).toBe("action-unconfirmed");
  await expect(h.client().pluginApps.invoke({ ...h.request, requestId: "new", lease: reopened.lease!, expectedRevision: reopened.app.controlRevision })).rejects.toMatchObject({ status: 409 });
  await expect(h.client().pluginApps.submitConversation({ source: reopened.source, lease: reopened.lease!, requestId: "message", expectedRevision: reopened.app.controlRevision, text: "continue", data: {} })).rejects.toMatchObject({ status: 409 });
  expect((await h.raw(`/sessions/${h.session.id}/runs/${first.receipt.runId}/resume`, {})).status).toBe(409);
  expect((await h.client().pluginApps.invoke(h.request)).receipt.executionState).toBe("unknown");
  expect(h.effects()).toBe(1); expect(h.modelCalls()).toBe(0);
}, 40_000);

it.each(["native-tools", "mcp-server"] as const)("rechecks %s approval after reviewer waits and executes zero calls after revocation", async kind => {
  const h = await fixture(kind);
  h.beforeReview(async () => { await updateInstalledPluginStore(getInstalledPluginStorePath(), store => { Object.values(store.plugins).forEach(p => { p.enabled = false; }); }); });
  const first = await h.client().pluginApps.invoke(h.request); await h.wait(first.receipt.runId);
  expect((await h.client().pluginApps.getAction(h.opened.source, "request")).receipt.executionState).toBe("not_started");
  expect(h.effects()).toBe(0); expect(h.modelCalls()).toBe(0);
}, 30_000);

it.each(["approved", "forge"])("retains the Native write outcome and original SQLite Part after a post-hook failure (%s)", async value => {
  const h = await fixture("native-tools");
  const postHook = vi.spyOn(HookExecutor.prototype, "execute").mockImplementation(async event => {
    if (event === "post_tool_use") throw new Error("post-return hook failed"); return { blocked: false };
  });
  const request = { ...h.request, args: { value } };
  const accepted = await h.client().pluginApps.invoke(request); await h.wait(accepted.receipt.runId);
  const response = await h.client().pluginApps.getAction(h.opened.source, "request");
  const executionState = value === "forge" ? "unknown" : "completed";
  expect(response.receipt).toMatchObject({ status: value === "forge" ? "failed" : "completed", executionState });
  if (value === "forge") expect(response.result).toBeUndefined();
  else expect(response.result).toMatchObject({ content: [{ type: "text", text: "Saved" }], structuredContent: { value } });
  const parts = h.store().conversations.listMessageParts(h.session.id).filter(p => p.type === "tool");
  expect(parts).toHaveLength(1);
  expect(parts[0]?.output).toMatchObject({ content: [{ type: "text", text: "Saved" }], executionState, metadata: { appData: { value } } });
  expect(parts[0]?.isError).toBe(value === "forge");
  const operations = h.store().toolOperations.list({ runId: accepted.receipt.runId });
  expect(operations).toHaveLength(1);
  const state = value === "forge" ? "unknown" : "confirmed";
  expect(operations[0]).toMatchObject({ kind: "non_replayable", state, result: parts[0]?.output });
  expect(h.store().toolOperations.listAttempts(operations[0]!.id)).toMatchObject([{ status: state, result: parts[0]?.output }]);
  expect((await h.client().pluginApps.invoke(request)).receipt).toEqual(response.receipt);
  expect(postHook.mock.calls.some(([event]) => event === "post_tool_use")).toBe(true);
  expect(h.effects()).toBe(1); expect(h.store().runs.listRuns(h.session.id)).toHaveLength(1); expect(h.modelCalls()).toBe(0);
}, 30_000);
it.each(["mcp-malformed", "mcp-oversized", "mcp-valid", "invalid-app-data"])("persists the completed Native %s result before page conversion", async value => {
  const h = await fixture("native-tools");
  const accepted = await h.client().pluginApps.invoke({ ...h.request, args: { value } }); await h.wait(accepted.receipt.runId);
  const response = await h.client().pluginApps.getAction(h.opened.source, "request");
  expect(response.receipt).toMatchObject({ status: "completed", executionState: "completed" });
  expect(response.result?.content).toEqual([{ type: "text", text: "Saved" }]);
  expect(response.result).not.toHaveProperty("_meta");
  if (value === "invalid-app-data") expect(response.dataError).toBe("plugin_app_invalid_data");
  else expect(response.result?.structuredContent).toEqual({ value });
  const part = h.store().conversations.listMessageParts(h.session.id).find(p => p.type === "tool");
  expect(part?.output).toMatchObject({ content: [{ type: "text", text: "Saved" }], executionState: "completed" });
  expect(part?.output).not.toHaveProperty("mcpResult");
  expect(h.effects()).toBe(1); expect(h.store().runs.listRuns(h.session.id)).toHaveLength(1);
}, 30_000);
