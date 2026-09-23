import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "@openharness/services";

import { StorePermissionBroker } from "../permission-broker.js";

function withBroker(
  test: (ctx: { broker: StorePermissionBroker; store: SessionStore; changes: number[] }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ohs-permission-broker-"));
  const store = new SessionStore({ path: join(dir, "store.db") });
  const changes: number[] = [];
  const broker = new StorePermissionBroker({
    permissions: store.permissions,
    getSession: (sessionId) => store.sessions.get(sessionId),
    latestEventSeq: () => store.conversations.latestEventSeq(),
    onChange: (seq) => changes.push(seq),
  });
  store.sessions.create({ id: "s1", cwd: process.cwd(), model: "m" });
  const input = store.conversationTransactions.admitPrompt({ id: "i1", sessionId: "s1", content: "edit" });
  store.runs.createRun({ id: "r1", sessionId: "s1", inputId: input.id });
  return test({ broker, store, changes }).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("StorePermissionBroker", () => {
  it("works with the permission repository and narrow session and event queries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-permission-broker-narrow-"));
    const store = new SessionStore({ path: join(dir, "store.db") });
    try {
      store.sessions.create({ id: "s1", cwd: process.cwd(), model: "m" });
      const input = store.conversationTransactions.admitPrompt({ id: "i1", sessionId: "s1", content: "edit" });
      store.runs.createRun({ id: "r1", sessionId: "s1", inputId: input.id });
      const broker = new StorePermissionBroker({
        permissions: store.permissions,
        getSession: (sessionId) => store.sessions.get(sessionId),
        latestEventSeq: () => store.conversations.latestEventSeq(),
      });

      const allowed = broker.ask({ sessionId: "s1", runId: "r1", toolName: "Write" });
      const request = store.permissions.list({ status: "pending" })[0]!;
      broker.reply({ requestId: request.id, status: "approved", decision: "once" });

      await expect(allowed).resolves.toEqual({ status: "approved", decision: "once" });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists an ask before blocking and resolves when a client replies", async () => {
    await withBroker(async ({ broker, store, changes }) => {
      const allowed = broker.ask({
        sessionId: "s1",
        runId: "r1",
        toolName: "Write",
        reason: "needs edit",
        input: { path: "README.md" },
      });

      const pending = store.permissions.list({ status: "pending" });
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        sessionId: "s1",
        runId: "r1",
        toolName: "Write",
        status: "pending",
      });
      expect(changes.length).toBeGreaterThanOrEqual(1);

      const replied = broker.reply({
        requestId: pending[0]!.id,
        status: "approved",
        decision: "once",
        clientId: "web-1",
      });
      expect(replied).toMatchObject({ status: "approved", decision: "once", decidedByClientId: "web-1" });
      await expect(allowed).resolves.toEqual({ status: "approved", decision: "once" });
      expect(store.conversations.listEvents().map((event) => event.type)).toContain("permission.replied");
    });
  });

  it("returns an AskUser answer from the persisted reply", async () => {
    await withBroker(async ({ broker, store }) => {
      const answer = broker.ask({
        sessionId: "s1",
        runId: "r1",
        toolName: "AskUser",
        reason: "Choose a mode",
        input: { kind: "question", question: "Choose a mode" },
      });
      const request = store.permissions.list({ status: "pending" })[0]!;
      broker.reply({
        requestId: request.id,
        status: "approved",
        decision: "once",
        answer: JSON.stringify({ selected: { "0": [1] }, custom: {} }),
      });

      await expect(answer).resolves.toMatchObject({
        status: "approved",
        answer: JSON.stringify({ selected: { "0": [1] }, custom: {} }),
      });
    });
  });

  it("never reuses a session approval for AskUser questions", async () => {
    await withBroker(async ({ broker, store }) => {
      const first = broker.ask({ sessionId: "s1", runId: "r1", toolName: "AskUser", reason: "first" });
      const firstRequest = store.permissions.list({ status: "pending" })[0]!;
      broker.reply({ requestId: firstRequest.id, status: "approved", decision: "session", answer: "first" });
      await expect(first).resolves.toMatchObject({ status: "approved", answer: "first" });

      const second = broker.ask({ sessionId: "s1", runId: "r1", toolName: "AskUser", reason: "second" });
      expect(store.permissions.list({ status: "pending", toolName: "AskUser" })).toHaveLength(1);
      broker.reply({ requestId: store.permissions.list({ status: "pending" })[0]!.id, status: "approved", decision: "once", answer: "second" });
      await expect(second).resolves.toMatchObject({ status: "approved", answer: "second" });
    });
  });

  it("persists session-scoped approvals and reuses them for later matching asks", async () => {
    await withBroker(async ({ broker, store }) => {
      const first = broker.ask({ sessionId: "s1", runId: "r1", toolName: "Bash", input: { command: "pnpm test" } });
      const firstRequest = store.permissions.list({ status: "pending" })[0]!;
      broker.reply({ requestId: firstRequest.id, status: "approved", decision: "session" });
      await expect(first).resolves.toEqual({ status: "approved", decision: "session" });

      await expect(broker.ask({ sessionId: "s1", runId: "r1", toolName: "Bash" })).resolves.toEqual({
        status: "approved",
        decision: "session",
      });
      const bashRequests = store.permissions.list({ sessionId: "s1", toolName: "Bash" });
      expect(bashRequests).toHaveLength(2);
      expect(bashRequests[1]).toMatchObject({
        status: "approved",
        decision: "session",
        payload: { reusedApprovalRequestId: firstRequest.id },
      });
    });
  });

  it("routes child asks to the parent session and reuses parent session approvals", async () => {
    await withBroker(async ({ broker, store }) => {
      store.sessions.create({ id: "child", parentId: "s1", cwd: process.cwd(), model: "m" });
      const childInput = store.conversationTransactions.admitPrompt({ id: "child-input", sessionId: "child", content: "edit" });
      store.runs.createRun({ id: "child-run", sessionId: "child", inputId: childInput.id });

      const parentAsk = broker.ask({ sessionId: "s1", runId: "r1", toolName: "Write" });
      const parentRequest = store.permissions.list({ sessionId: "s1", status: "pending" })[0]!;
      broker.reply({ requestId: parentRequest.id, status: "approved", decision: "session" });
      await expect(parentAsk).resolves.toEqual({ status: "approved", decision: "session" });

      const childAsk = broker.ask({
        sessionId: "child",
        runId: "child-run",
        toolName: "Write",
        input: { path: "child.txt" },
      });
      await expect(childAsk).resolves.toEqual({ status: "approved", decision: "session" });

      const childRequest = store.permissions.list({ sessionId: "s1", toolName: "Write" }).at(-1);
      expect(childRequest).toMatchObject({
        sessionId: "s1",
        status: "approved",
        decision: "session",
        payload: {
          childSessionId: "child",
          childRunId: "child-run",
          reusedApprovalRequestId: parentRequest.id,
        },
      });
      expect(childRequest?.runId).toBeUndefined();
      expect(store.permissions.list({ sessionId: "child" })).toHaveLength(0);
    });
  });

  it("expires a pending request when its run is interrupted", async () => {
    await withBroker(async ({ broker, store }) => {
      const controller = new AbortController();
      const allowed = broker.ask({
        sessionId: "s1",
        runId: "r1",
        toolName: "Write",
        signal: controller.signal,
      });
      const request = store.permissions.list({ status: "pending" })[0]!;
      controller.abort();

      await expect(allowed).resolves.toMatchObject({ status: "expired" });
      expect(store.permissions.get(request.id)).toMatchObject({ status: "expired" });
    });
  });
});
