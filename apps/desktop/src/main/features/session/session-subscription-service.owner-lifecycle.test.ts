import { afterEach, describe, expect, it, vi } from "vitest"
import type { SessionEventRecord } from "@rzx/client"
import { SessionSubscriptionService } from "./session-subscription-service"

afterEach(() => vi.useRealTimers())

function makeClient() {
  const session = (id: string) => ({
    id,
    ...(id === "child-A" || id === "fork-A" ? { parentId: "A" } : id === "child-B" ? { parentId: "B" } : {}),
    cwd: "D:/repo",
    title: id,
    model: "m",
    status: "idle" as const,
    metadata: { desktop: { workspaceMode: "outside_project" },
      ...(id === "child-A" || id === "fork-A" ? { childId: "task-A" } : id === "child-B" ? { childId: "task-B" } : {}) },
    createdAt: 1,
    updatedAt: 1,
  })
  return {
    sessions: {
      getState: vi.fn(async (sessionId: string) => ({
        cursor: 1,
        session: session(sessionId),
        inputs: [],
        messages: [],
        parts: [],
        runs: [],
        attempts: [],
        permissions: [],
        tasks: sessionId === "A" || sessionId === "B" ? [{ id: `task-${sessionId}`, sessionId, type: "agent", childSessionId: `child-${sessionId}`,
          description: "worker", cwd: "D:/repo", status: "completed", metadata: {}, createdAt: 1, updatedAt: 1 }] : [],
      })),
    },
    events: {
      list: vi.fn(async () => []),
      stream: vi.fn(async function* () {
        await new Promise<never>(() => undefined)
        yield {
          id: "never",
          seq: 2,
          type: "daemon.test",
          schemaVersion: 1,
          payload: {},
          createdAt: 2,
        } satisfies SessionEventRecord
      }),
    },
  }
}

function makeWebContents(id = 77) {
  return { id, once: vi.fn(), isDestroyed: () => false, send: vi.fn() }
}

describe("session subscription owner lifecycle", () => {
  it.each(["fork", "task-kind", "task-owner", "task-child", "child-id"])("rejects Agents details ownership when actual worker evidence is %s", async mismatch => {
    const client = makeClient(); const owner = makeWebContents(); const service = new SessionSubscriptionService();
    const readState = client.sessions.getState.getMockImplementation()!;
    client.sessions.getState.mockImplementation(async sessionId => {
      const snapshot = await readState(sessionId);
      const task = snapshot.tasks[0];
      if (sessionId === "A" && task) {
        if (mismatch === "task-kind") task.type = "shell";
        if (mismatch === "task-owner") task.sessionId = "B";
        if (mismatch === "task-child") task.childSessionId = "other";
      }
      if (mismatch === "child-id" && sessionId === "child-A") snapshot.session.metadata.childId = "wrong";
      return snapshot;
    });
    const source = mismatch === "fork" ? "fork-A" : "child-A";
    try {
      await service.openSession(client as never, owner as never, "A");
      await service.openAuxSession(client as never, owner as never, { subscriptionId: "agents:details", sessionId: source });
      expect(service.getOwnerSessionToken(77, source)).toBeUndefined();
    } finally { service.clearAll(); }
  });
  it("grants child UI ownership only to the current root's exact open Agents details subscription", async () => {
    const service = new SessionSubscriptionService();
    const client = makeClient(); const owner = makeWebContents();
    const observed: string[] = []; const invalidated: string[] = [];
    service.onOwnerSnapshot((_ownerId, view) => { observed.push(view.session.id); });
    service.onSessionInvalidated((_ownerId, sessionId) => { invalidated.push(sessionId); });
    try {
      await service.openSession(client as never, owner as never, "A");
      const rootToken = service.getOwnerSessionToken(77, "A");
      expect(rootToken).toBeDefined();
      await service.openAuxSession(client as never, owner as never, { subscriptionId: "side-chat", sessionId: "child-A" });
      expect(service.getOwnerSessionToken(77, "child-A")).toBeUndefined();
      await service.openAuxSession(client as never, owner as never, { subscriptionId: "agents:details", sessionId: "child-B" });
      expect(service.getOwnerSessionToken(77, "child-B")).toBeUndefined();
      await service.openAuxSession(client as never, owner as never, { subscriptionId: "agents:details", sessionId: "child-A" });
      const childToken = service.getOwnerSessionToken(77, "child-A");
      expect(childToken).toBeDefined();
      expect(service.getOwnerSessionToken(78, "child-A")).toBeUndefined();
      expect(observed).toContain("child-A");
      await service.openSession(client as never, owner as never, "A");
      expect(service.getOwnerSessionToken(77, "A")).toBe(rootToken);
      expect(service.getOwnerSessionToken(77, "child-A")).toBe(childToken);
      service.closeAuxSession(77, { subscriptionId: "agents:details" });
      expect(service.getOwnerSessionToken(77, "child-A")).toBeUndefined();
      expect(service.getOwnerSessionToken(77, "A")).toBe(rootToken);
      expect(invalidated).toContain("child-A");
      await service.openAuxSession(client as never, owner as never, { subscriptionId: "agents:details", sessionId: "child-A" });
      expect(service.getOwnerSessionToken(77, "child-A")).not.toBe(childToken);
      await service.openSession(client as never, owner as never, "B");
      expect(service.getOwnerSessionToken(77, "child-A")).toBeUndefined();
      await service.openSession(client as never, owner as never, "A");
      expect(service.getOwnerSessionToken(77, "child-A")).toBeUndefined();
    } finally { service.clearAll(); }
  });
  it("keeps the same worker through task completion/resync and retires its bridge when the task proof disappears", async () => {
    const client = makeClient(); const owner = makeWebContents(); const service = new SessionSubscriptionService();
    const readState = client.sessions.getState.getMockImplementation()!;
    let status = "running"; let includeTask = true;
    client.sessions.getState.mockImplementation(async sessionId => {
      const snapshot = await readState(sessionId);
      if (sessionId === "A") {
        if (!includeTask) snapshot.tasks = [];
        else snapshot.tasks[0]!.status = status;
      }
      return snapshot;
    });
    const invalidated: string[] = [];
    service.onSessionInvalidated((_ownerId, sessionId) => { invalidated.push(sessionId); });
    try {
      await service.openSession(client as never, owner as never, "A");
      await service.openAuxSession(client as never, owner as never, { subscriptionId: "agents:details", sessionId: "child-A" });
      const workerToken = service.getOwnerSessionToken(77, "child-A");
      expect(workerToken).toBeDefined();
      status = "completed";
      await service.openSession(client as never, owner as never, "A");
      expect(service.getOwnerSessionToken(77, "child-A")).toBe(workerToken);
      expect(invalidated).toEqual([]);
      includeTask = false;
      await service.openSession(client as never, owner as never, "A");
      expect(service.getOwnerSessionToken(77, "child-A")).toBeUndefined();
      expect(invalidated).toEqual(["child-A"]);
    } finally { service.clearAll(); }
  });
  it("每个 webContents 只注册一次 destroyed 回收钩子", async () => {
    const client = makeClient()
    const webContents = makeWebContents()
    const service = new SessionSubscriptionService()

    await service.openSession(client as never, webContents as never, "A")
    await service.openSession(client as never, webContents as never, "B")
    await service.openSession(client as never, webContents as never, "C")

    const destroyedRegistrations = webContents.once.mock.calls.filter(
      ([event]) => event === "destroyed"
    )
    expect(destroyedRegistrations).toHaveLength(1)
    service.clearAll()
  })

  it("destroyed 钩子仍然回收该 owner 的订阅", async () => {
    const client = makeClient()
    const webContents = makeWebContents()
    const service = new SessionSubscriptionService()

    await service.openSession(client as never, webContents as never, "A")
    await service.openSession(client as never, webContents as never, "B")
    expect(service.hasPrimary(77, "B")).toBe(true)

    const registration = webContents.once.mock.calls.find(([event]) => event === "destroyed")
    expect(registration).toBeDefined()
    const handler = registration![1] as () => void
    handler()

    expect(service.hasPrimary(77, "B")).toBe(false)
    service.clearAll()
  })
})
