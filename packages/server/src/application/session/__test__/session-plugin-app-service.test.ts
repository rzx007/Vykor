import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "@vykor/services";
import { SessionPluginAppService, type PluginAppBackendDescriptor, type PluginAppCurrentFacts, type PluginAppLeaseAuthority } from "../session-plugin-app-service.js";
import type { PluginAppRecord, PluginAppRuntimeLease } from "@vykor/protocol";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "session-plugin-app-"));
  const store = new SessionStore({ path: join(dir, "store.db") });
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.sessions.create({ id: "s", cwd: dir, model: "m" });
  const descriptor: PluginAppBackendDescriptor = {
    pluginId: "notes", pluginVersion: "1", pluginDigest: "p", definitionDigest: "d", backendId: "notes", backendKind: "native-tools",
    surfaces: [{ id: "notes", title: "Notes", backend: "notes", resourceUri: "ui://notes", availability: "session" }],
  };
  const facts: PluginAppCurrentFacts = { enabled: true, renderApproved: true, invokeApproved: true, snapshot: "valid", resourceAvailable: true, toolsAvailable: true,
    backendGeneration: "g1", isCurrent: () => true };
  let execution: "not_started" | "completed" | "unknown" | undefined;
  // Test-only stand-in for the Agent's private, source-bound runtime binding authority.
  const leases = new Map<string, { identity: string; lease: PluginAppRuntimeLease }>();
  const identity = (app: PluginAppRecord) => JSON.stringify([app.sessionId, app.id, app.pluginDigest, app.definitionDigest, app.backendId, app.backendKind]);
  const leaseAuthority: PluginAppLeaseAuthority = {
    issue(app, backendGeneration) {
      const prior = leases.get(app.id);
      const lease = prior?.identity === identity(app) && prior.lease.backendGeneration === backendGeneration ? prior.lease : { token: randomUUID(), backendGeneration };
      leases.set(app.id, { identity: identity(app), lease }); return { ...lease };
    },
    validate(app, lease, generation) { const bound = leases.get(app.id); return !!bound && bound.identity === identity(app) && bound.lease.token === lease.token && bound.lease.backendGeneration === generation; },
    revoke(source) { leases.delete(source.appId); }, clear() { leases.clear(); },
  };
  const descriptors = [descriptor];
  const service = new SessionPluginAppService({ store, leaseAuthority, catalogue: { list: async () => descriptors }, resolveCurrent: async () => ({ ...facts }),
    readExecutionState: () => execution });
  return { store, service, descriptor, descriptors, facts, setExecution: (state: typeof execution) => { execution = state; } };
}

describe("session plugin app lifecycle", () => {
  it("renews host control revision for a captured context after admission without relaxing lease or final revision checks", async () => {
    const { store, service, facts, setExecution } = setup();
    const opened = await service.open("s", { pluginId: "notes", surfaceId: "notes" });
    const context = { source: opened.source, lease: opened.lease!, requestId: "context",
      expectedRevision: 0, text: "selected text", data: { documentRevision: 3 } };
    store.runs.createRun({ id: "autosave", sessionId: "s" });
    store.pluginApps.admitAction(opened.app.id, { expectedRevision: 0, runId: "autosave" });
    store.pluginApps.settleAction(opened.app.id, "autosave"); setExecution("completed");
    const materialized = await service.materializeComposerContexts("s", [context]);
    expect(JSON.stringify(materialized.items)).toContain("selected text");
    expect(JSON.stringify(materialized.items)).toContain("documentRevision");
    materialized.assertCurrent();
    await expect(service.materializeComposerContexts("s", [{ ...context, expectedRevision: 99 }])).rejects.toThrow();
    facts.backendGeneration = "g2";
    await expect(service.materializeComposerContexts("s", [context])).rejects.toThrow();
    facts.backendGeneration = "g1";
    expect(store.pluginApps.get(opened.app.id)!.status).not.toBe("closed");
    store.pluginApps.close(opened.app.id, store.pluginApps.get(opened.app.id)!.controlRevision);
    expect(() => materialized.assertCurrent()).toThrow();
    await expect(service.materializeComposerContexts("s", [context])).rejects.toThrow();
  });
  it("opens a surface without any tool Run or fake Part and reuses the durable identity", async () => {
    const { store, service } = setup();
    const first = await service.open("s", { pluginId: "notes", surfaceId: "notes" });
    const second = await service.open("s", { pluginId: "notes", surfaceId: "notes" });
    expect(second.source).toEqual(first.source);
    expect(first.openedByRequest).toBe(true); expect(second.openedByRequest).toBe(false);
    expect(second.app.controlRevision).toBe(0);
    expect(second.lease).toEqual(first.lease);
    expect(store.runs.listRuns("s")).toEqual([]);
    expect(store.conversations.listMessages("s")).toEqual([]);
    expect(first.app.origin).toEqual({ kind: "surface", surfaceId: "notes" });
  });

  it("keeps unknown and unverifiable last operations blocked across close/reopen", async () => {
    const { store, service, setExecution } = setup();
    const opened = await service.open("s", { pluginId: "notes", surfaceId: "notes" });
    const appId = opened.source.appId;
    store.transaction(() => { store.runs.createRun({ id: "r", sessionId: "s" }); store.pluginApps.admitAction(appId, { expectedRevision: 0, runId: "r" }); });
    store.pluginApps.settleAction(appId, "r");
    service.close(opened.source, { expectedRevision: 2 });
    for (const state of [undefined, "unknown"] as const) {
      setExecution(state);
      const reopened = await service.open("s", { pluginId: "notes", surfaceId: "notes" });
      expect(reopened.app.lastActionRunId).toBe("r");
      expect(reopened.availability).toMatchObject({ canReadResource: true, canInvokeTools: false, canMessage: false, reason: "action-unconfirmed" });
      await expect(service.assertCanInvoke(reopened.source, reopened.lease!)).rejects.toThrow("尚未确认");
    }
    setExecution("completed");
    expect((await service.prepare(opened.source)).availability.canInvokeTools).toBe(true);
  });

  it("invalidates old generation leases without changing control revision", async () => {
    const { service, facts } = setup();
    const opened = await service.open("s", { pluginId: "notes", surfaceId: "notes" });
    facts.backendGeneration = "g2";
    const next = await service.prepare(opened.source);
    expect(next.app.controlRevision).toBe(0);
    expect(next.lease?.token).not.toBe(opened.lease?.token);
    await expect(service.assertCanInvoke(opened.source, opened.lease!)).rejects.toThrow();
    facts.isCurrent = () => false;
    await expect(service.assertCanInvoke(next.source, next.lease!)).rejects.toThrow();
  });

  it("allows verified resource reads when tool permission or runtime is unavailable", async () => {
    const { service, facts } = setup();
    facts.invokeApproved = false; facts.toolsAvailable = false;
    const opened = await service.open("s", { pluginId: "notes", surfaceId: "notes" });
    expect(opened.availability).toMatchObject({ canReadResource: true, canInvokeTools: false });
    facts.renderApproved = false;
    expect((await service.prepare(opened.source)).availability.canReadResource).toBe(false);
  });

  it("revokes a superseded definition and gives the new definition a new identity", async () => {
    const { service, descriptor, store } = setup();
    const old = await service.open("s", { pluginId: "notes", surfaceId: "notes" });
    descriptor.pluginVersion = "2"; descriptor.definitionDigest = "d2";
    const current = await service.open("s", { pluginId: "notes", surfaceId: "notes" });
    expect(current.source.appId).not.toBe(old.source.appId);
    expect(store.pluginApps.get(old.source.appId)).toMatchObject({ status: "revoked", controlRevision: 1 });
    await expect(service.assertCanInvoke(old.source, old.lease!)).rejects.toThrow();
  });
});

it("keeps distinct manifests of one plugin open and revokes both after plugin upgrade", async () => {
  const h = setup();
  h.descriptors.push({ ...h.descriptor, backendId: "second", definitionDigest: "separate-manifest",
    surfaces: [{ id: "second", title: "Second", backend: "second", resourceUri: "ui://second", availability: "session" }] });
  const first = await h.service.open("s", { pluginId: "notes", surfaceId: "notes" });
  const second = await h.service.open("s", { pluginId: "notes", surfaceId: "second" });
  expect(h.store.pluginApps.get(first.app.id)?.status).toBe("open");
  expect((await h.service.open("s", { pluginId: "notes", surfaceId: "notes" })).app.id).toBe(first.app.id);
  expect(h.store.pluginApps.get(second.app.id)?.status).toBe("open");
  h.descriptors.forEach(d => { d.pluginVersion = "2"; d.pluginDigest = "new-install"; });
  await h.service.open("s", { pluginId: "notes", surfaceId: "notes" });
  expect(h.store.pluginApps.get(first.app.id)?.status).toBe("revoked");
  expect(h.store.pluginApps.get(second.app.id)?.status).toBe("revoked");
});
