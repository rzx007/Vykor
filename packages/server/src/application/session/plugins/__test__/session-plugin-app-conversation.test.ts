import { afterEach, expect, it, vi } from "vitest";
import { pluginAppHarness } from "../../../../../test-helpers/plugin-app-harness.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("admits separate ordinary messages, atomically records provenance and never duplicates a model run", async () => {
  const h = await pluginAppHarness("native-tools"); cleanups.push(h.close);
  const input = { source: h.opened.source, lease: h.opened.lease!, requestId: "msg-1", expectedRevision: 0, text: "Explain the selection", data: { selected: 1 } };
  const [a, b] = await Promise.all([h.client().pluginApps.submitConversation(input), h.client().pluginApps.submitConversation(input)]);
  expect(a.runId).toBe(b.runId); await h.wait(a.runId);
  const retry = await h.client().pluginApps.submitConversation({ ...input, lease: { token: "expired", backendGeneration: "old" } });
  expect(retry.runId).toBe(a.runId);
  await expect(h.client().pluginApps.submitConversation({ ...input, text: "Different" })).rejects.toMatchObject({ status: 409 });
  const second = await h.client().pluginApps.submitConversation({ ...input, requestId: "msg-2", text: "Next selection" }); await h.wait(second.runId);
  expect(second.runId).not.toBe(a.runId);
  expect(h.store().conversations.listInputs(h.session.id)).toHaveLength(2);
  expect(h.store().pluginApps.get(h.opened.app.id)).toMatchObject({ status: "open", controlRevision: 0 });
  expect(h.modelCalls()).toBe(2); expect(h.effects()).toBe(0);
  const stored = h.store().conversations.getInput(a.inputId)!;
  expect(stored.metadata.pluginAppSubmission).toEqual(h.store().runs.getRun(a.runId)?.metadata.pluginAppSubmission);
  const fork = h.store().conversationTransactions.forkSessionWithHistory({ sourceSessionId: h.session.id,
    session: { cwd: h.root, model: "never" } });
  expect(h.store().conversations.listInputs(fork.id)).toHaveLength(2);
  expect(h.store().conversations.listInputs(fork.id).every(item => !Object.hasOwn(item.metadata, "pluginAppSubmission"))).toBe(true);
  expect(h.store().pluginApps.list(fork.id)).toEqual([]);
}, 30_000);
it("validates explicit composer references in ordinary admission, preserves deduplication and never persists credentials", async () => {
  const h = await pluginAppHarness("native-tools"); cleanups.push(h.close);
  const context = { source: h.opened.source, lease: h.opened.lease!, requestId: "selection-1", expectedRevision: 0,
    text: "Selected paragraph", data: { selection: [1, 2] } };
  const request = { id: "composer-1", items: [{ type: "text" as const, text: "Explain this" }], pluginAppContexts: [context] };
  const first = await h.client().sessions.admitPrompt(h.session.id, request); await h.wait(first.run!.id);
  const retry = await h.client().sessions.admitPrompt(h.session.id, request);
  expect(retry.input.id).toBe(first.input.id); expect(retry.run?.id).toBe(first.run?.id);
  expect(h.modelCalls()).toBe(1);
  const input = h.store().conversations.getInput(first.input.id)!;
  expect(input.content).toContain("Selected paragraph"); expect(input.content).toContain('"selection":[1,2]');
  const persisted = JSON.stringify({ input, runs: h.store().runs.listRuns(h.session.id) });
  expect(persisted).not.toContain(context.lease.token);
  expect(persisted).not.toContain("backendGeneration"); expect(persisted).not.toContain("pluginAppContexts");
  const snapshot = JSON.stringify(await h.client().sessions.getState(h.session.id));
  expect(snapshot).not.toContain(context.lease.token);
}, 30_000);
it("rejects wrong-session, stale and closed composer sources before Input/Run admission", async () => {
  const h = await pluginAppHarness("native-tools"); cleanups.push(h.close);
  const context = { source: h.opened.source, lease: h.opened.lease!, requestId: "selection", expectedRevision: 0,
    text: "Selected paragraph", data: null };
  const request = { items: [{ type: "text" as const, text: "draft" }], pluginAppContexts: [context] };
  const other = h.store().sessions.create({ cwd: h.root, model: "never" });
  await expect(h.client().sessions.admitPrompt(other.id, { ...request, id: "wrong" })).rejects.toMatchObject({ status: 409 });
  await expect(h.client().sessions.admitPrompt(h.session.id, { ...request, id: "stale", pluginAppContexts: [{ ...context, expectedRevision: 99 }] })).rejects.toMatchObject({ status: 409 });
  await h.client().pluginApps.close(context.source, { expectedRevision: 0 });
  await expect(h.client().sessions.admitPrompt(h.session.id, { ...request, id: "closed" })).rejects.toMatchObject({ status: 409 });
  expect(h.store().conversations.listInputs(h.session.id)).toEqual([]); expect(h.modelCalls()).toBe(0);
  // Removing the reference leaves the existing ordinary input path available.
  const ordinary = await h.client().sessions.admitPrompt(h.session.id, { id: "ordinary", items: request.items }); await h.wait(ordinary.run!.id);
  expect(h.modelCalls()).toBe(1);
}, 30_000);
