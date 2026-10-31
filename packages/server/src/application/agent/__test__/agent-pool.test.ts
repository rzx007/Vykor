import {hostedAgentFactory} from "../../../../test-helpers/hosted-agent.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentPool } from "../agent-pool.js";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";

const session = {
  id: "s1",
  cwd: "/repo",
  title: "Session",
  model: "gpt-test",
  status: "idle",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
} as const;

function createAgent(close = vi.fn(async () => {})) {
  return {
    state: "idle",
    children: { list: () => [] },
    canSuspend: () => true,
    loadHistory: vi.fn(),
    setCompactContextProvider: vi.fn(),
    close,
  } as any;
}

function createContext(factory = vi.fn(async () => createAgent())) {
  return {
    store: {
      getSession: vi.fn(() => session),
      listMessages: vi.fn(() => []),
      listMessageParts: vi.fn(() => []),
      listSessions: vi.fn(() => [session]),
    },
    loadAgent: vi.fn(hostedAgentFactory(factory)),
  };
}

describe("AgentPool", () => {
  afterEach(() => vi.useRealTimers());

  it("reuses a warm agent, then rebuilds an expired idle agent from current durable history", async () => {
    vi.useFakeTimers();
    const first = createAgent();
    const second = createAgent();
    const context = createContext(vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second));
    const pool = new AgentPool({ ...context, idleTimeoutMs: 100 } as any);
    expect(await pool.acquireSession("s1")).toBe(first);
    await vi.advanceTimersByTimeAsync(90);
    expect(await pool.acquireSession("s1")).toBe(first);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pool.get("s1")).toBe(first);
    const latest = [{ id: "persisted-message" }] as any;
    context.store.listMessages.mockReturnValue(latest);
    await vi.advanceTimersByTimeAsync(110);
    expect(pool.size).toBe(0);
    expect(context.store.getSession("s1")).toBe(session);
    expect(await pool.acquireSession("s1")).toBe(second);
    expect(context.loadAgent.mock.calls[1]![0].history).toBe(latest);
    await pool.closeAll();
  });

  it("starts the idle period only after the host reports no remaining work", async () => {
    vi.useFakeTimers();
    let busy = true;
    const agent = createAgent();
    const pool = new AgentPool({ ...createContext(vi.fn(async () => agent)), idleTimeoutMs: 100, hasSessionWork: () => busy } as any);
    await pool.acquireSession("s1");
    await vi.advanceTimersByTimeAsync(500);
    expect(await pool.get("s1")).toBe(agent);
    busy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pool.get("s1")).toBe(agent);
    await vi.advanceTimersByTimeAsync(100);
    expect(pool.size).toBe(0);
    await pool.closeAll();
  });

  it("does not expire a long tool or a retained framework child", async () => {
    vi.useFakeTimers();
    let suspendable = false;
    const agent = { ...createAgent(), state: "running", canSuspend: () => suspendable };
    const pool = new AgentPool({ ...createContext(vi.fn(async () => agent)), idleTimeoutMs: 100 } as any);
    await pool.acquireSession("s1");
    await vi.advanceTimersByTimeAsync(300);
    agent.state = "idle";
    await vi.advanceTimersByTimeAsync(300);
    expect(await pool.get("s1")).toBe(agent);
    suspendable = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(pool.size).toBe(0);
    await pool.closeAll();
  });

  it("rechecks generation after an async suspend check so new input wins the race", async () => {
    vi.useFakeTimers();
    const check = deferred();
    const started = deferred();
    let checks = 0;
    const agent = { ...createAgent(), canSuspend: () => {
      if (++checks === 1) return true;
      started.resolve(); return check.promise.then(() => true);
    } };
    const pool = new AgentPool({ ...createContext(vi.fn(async () => agent)), idleTimeoutMs: 100 } as any);
    await pool.acquireSession("s1");
    const sweeping = vi.advanceTimersByTimeAsync(200);
    await started.promise;
    expect(await pool.acquireSession("s1")).toBe(agent);
    check.resolve();
    await sweeping;
    expect(await pool.get("s1")).toBe(agent);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pool.get("s1")).toBe(agent);
    await vi.advanceTimersByTimeAsync(100);
    expect(pool.size).toBe(0);
    await pool.closeAll();
  });

  it("waits for idle cleanup before serving new input and keeps failed cleanup recoverable", async () => {
    vi.useFakeTimers();
    const closing = deferred();
    const closeError = new Error("resource still owned");
    let attempts = 0;
    const old = createAgent(vi.fn(async () => { attempts++; if (attempts === 1) { await closing.promise; throw closeError; } }));
    const next = createAgent();
    const context = createContext(vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next));
    const failures: unknown[] = [];
    const pool = new AgentPool({ ...context, idleTimeoutMs: 100, onIdleEvictionError: (error: unknown) => failures.push(error) } as any);
    await pool.acquireSession("s1");
    await vi.advanceTimersByTimeAsync(200);
    expect(await pool.get("s1")).toBeUndefined();
    const acquiring = pool.acquireSession("s1");
    const rejected = expect(acquiring).rejects.toBe(closeError);
    closing.resolve();
    await rejected;
    expect(pool.size).toBe(1);
    expect(await pool.get("s1")).toBeUndefined();
    expect(await pool.acquireSession("s1")).toBe(next);
    expect(failures).toEqual([closeError]);
    await pool.closeAll();
  });

  it("retains and retries an idle resource whose close throws synchronously", async () => {
    vi.useFakeTimers();
    let closes = 0;
    const old = createAgent(vi.fn(() => { if (++closes === 1) throw new Error("sync cleanup failure"); return Promise.resolve(); }));
    const next = createAgent();
    const pool = new AgentPool({
      ...createContext(vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next)), idleTimeoutMs: 100,
      onIdleEvictionError: () => {},
    } as any);
    await pool.acquireSession("s1");
    await vi.advanceTimersByTimeAsync(200);
    expect(await pool.get("s1")).toBeUndefined();
    expect(await pool.acquireSession("s1")).toBe(next);
    await pool.closeAll();
  });

  it("uses the session activity barrier and owner check before cleanup", async () => {
    vi.useFakeTimers();
    let canEnter = false;
    let owner = true;
    let leaseHeld = false;
    const agent = createAgent(vi.fn(async () => { expect(leaseHeld).toBe(true); }));
    const pool = new AgentPool({
      ...createContext(vi.fn(async () => agent)), idleTimeoutMs: 100,
      enterIdleEviction: (_id: string, isIdle: () => boolean) => {
        if (!owner) throw new Error("owner generation lost");
        if (!canEnter || !isIdle()) return undefined;
        leaseHeld = true;
        return { release: () => { leaseHeld = false; } };
      },
      onIdleEvictionError: () => {},
    } as any);
    await pool.acquireSession("s1");
    await vi.advanceTimersByTimeAsync(200);
    expect(await pool.get("s1")).toBe(agent);
    canEnter = true;
    owner = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pool.get("s1")).toBe(agent);
    owner = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(pool.size).toBe(0);
    expect(leaseHeld).toBe(false);
    await pool.closeAll();
  });

  it("serializes eviction with existing activity leases and waits for closing resources before rebuilding", async () => {
    vi.useFakeTimers();
    const gate = new DaemonOperationGate();
    const scope = { sessionId: "s1", cwd: "/repo" };
    const lease = gate.enter(scope);
    const closing = deferred();
    const old = createAgent(vi.fn(async () => { await closing.promise; }));
    const next = createAgent();
    const pool = new AgentPool({
      ...createContext(vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next)), idleTimeoutMs: 100,
      enterIdleEviction: (sessionId: string, isIdle: () => boolean) => gate.tryEnterBarrier({ kind: "session", sessionId, cwd: "/repo" }, isIdle),
    } as any);
    await pool.acquireSession("s1");
    await vi.advanceTimersByTimeAsync(300);
    expect(await pool.get("s1")).toBe(old);
    lease.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(() => gate.enter(scope)).toThrow(/blocked/);
    const replacement = pool.acquireSession("s1");
    expect(await pool.get("s1")).toBeUndefined();
    closing.resolve();
    expect(await replacement).toBe(next);
    await Promise.resolve();
    const nextLease = gate.enter(scope);
    nextLease.release();
    await pool.closeAll();
  });

  it("stops its idle timer during daemon teardown", async () => {
    vi.useFakeTimers();
    const pool = new AgentPool({ ...createContext(), idleTimeoutMs: 100 } as any);
    await pool.acquireSession("s1");
    pool.stopIdleEviction();
    await vi.advanceTimersByTimeAsync(500);
    expect(pool.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await pool.closeAll();
  });

  it.each(["running", "stopping", "unavailable"])("retains a root while host-owned jobs are %s", async status => {
    vi.useFakeTimers();
    let active = true;
    const agent = createAgent();
    const context = createContext();
    context.loadAgent = vi.fn(async () => ({ agent, host: { jobs: { list: async () => ({
      jobs: active && status !== "unavailable" ? [{ status, id: "background-shell" }] : [],
      errors: active && status === "unavailable" ? [{ kind: "shell", message: "backend unavailable" }] : [],
    }) } } })) as any;
    const pool = new AgentPool({ ...context, idleTimeoutMs: 100 } as any);
    await pool.acquireSession("s1");
    await vi.advanceTimersByTimeAsync(500);
    expect(await pool.get("s1")).toBe(agent);
    active = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(pool.size).toBe(0);
    await pool.closeAll();
  });

  it("does not start eviction for a standalone pool unless its host enables a policy", async () => {
    vi.useFakeTimers();
    const pool = new AgentPool(createContext() as any);
    await pool.acquireSession("s1");
    expect(vi.getTimerCount()).toBe(0);
    await pool.closeAll();
  });

  it("combines supplemental sections and session memory for the same session", async () => {
    const agent = createAgent();
    const supplementalSections = vi.fn(async () => [{
      heading: "Conversation Attachments",
      content: "- attachment://att-1/notes.txt",
    }]);
    const sessionMemory = vi.fn(async () => "goal: finish phase two");
    const pool = new AgentPool({
      ...createContext(vi.fn(async () => agent)),
      supplementalSections,
      sessionMemory,
    } as any);

    await pool.acquireSession("s1");

    expect(agent.setCompactContextProvider).toHaveBeenCalledOnce();
    const provider = agent.setCompactContextProvider.mock.calls[0]![0];
    await expect(provider()).resolves.toEqual({
      supplementalSections: [{
        heading: "Conversation Attachments",
        content: "- attachment://att-1/notes.txt",
      }],
      sessionMemory: "goal: finish phase two",
    });
    expect(supplementalSections).toHaveBeenCalledWith("s1");
    expect(sessionMemory).toHaveBeenCalledWith("s1");
  });

  it.each([
    {
      name: "supplemental sections",
      sources: {
        supplementalSections: async () => [{ heading: "Extra", content: "context" }],
      },
      expected: {
        supplementalSections: [{ heading: "Extra", content: "context" }],
      },
    },
    {
      name: "session memory",
      sources: {
        sessionMemory: async () => "next: verify compact wiring",
      },
      expected: {
        sessionMemory: "next: verify compact wiring",
      },
    },
  ])("keeps the $name source usable on its own", async ({ sources, expected }) => {
    const agent = createAgent();
    const pool = new AgentPool({
      ...createContext(vi.fn(async () => agent)),
      ...sources,
    } as any);

    await pool.acquireSession("s1");

    const provider = agent.setCompactContextProvider.mock.calls[0]![0];
    await expect(provider()).resolves.toEqual(expected);
  });

  it("does not create a second agent for a framework-owned live child session", async () => {
    const context = createContext();
    const pool = new AgentPool({
      ...context,
      isSessionExternallyOwned: (sessionId) => sessionId === "s1",
    } as any);

    await pool.warm("s1");
    expect(context.loadAgent).not.toHaveBeenCalled();
    await expect(pool.acquireSession(session.id)).rejects.toThrow("owned by a live child agent");
  });

  it("deduplicates concurrent agent creation and closes the cached agent", async () => {
    const close = vi.fn(async () => {});
    const factory = vi.fn(async () => createAgent(close));
    const pool = new AgentPool(createContext(factory) as any);

    const [first, second] = await Promise.all([
      pool.acquireSession(session.id),
      pool.acquireSession(session.id),
    ]);

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledOnce();
    expect(pool.size).toBe(1);

    await pool.close(session.id);

    expect(close).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });

  it("evicts an agent when creation fails", async () => {
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce(createAgent());
    const pool = new AgentPool(createContext(factory) as any);

    await pool.warm(session.id);
    expect(pool.size).toBe(0);

    await pool.acquireSession(session.id);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(pool.size).toBe(1);
  });

  it("evicts a failed close without hiding the cleanup error", async () => {
    const closeError = new Error("close failed");
    const pool = new AgentPool(createContext(
      vi.fn(async () => createAgent(vi.fn(async () => { throw closeError; }))),
    ) as any);
    await pool.acquireSession(session.id);

    await expect(pool.close(session.id)).rejects.toBe(closeError);
    expect(pool.size).toBe(0);
  });

  it("invalidates idle agents immediately and defers busy agents until they go idle", async () => {
    const idleClose = vi.fn(async () => {});
    const busyClose = vi.fn(async () => {});
    const idleAgent = createAgent(idleClose);
    const busyAgent = { ...createAgent(busyClose), state: "running" };
    const secondSession = { ...session, id: "s2" };
    const context = createContext(
      vi.fn(async ({ session: loaded }: any) => (loaded.id === "s1" ? idleAgent : busyAgent)),
    );
    context.store.getSession.mockImplementation((id: string) =>
      id === "s1" ? session : secondSession,
    );
    const pool = new AgentPool(context as any);
    await Promise.all([pool.acquireSession("s1"), pool.acquireSession("s2")]);

    await pool.invalidateWarmAgents();

    expect(idleClose).toHaveBeenCalledOnce();
    expect(busyClose).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);

    busyAgent.state = "idle";
    await pool.closeIfStale("s2");

    expect(busyClose).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });

  it("waits for every cached agent to close before reporting cleanup failures", async () => {
    const secondSession = { ...session, id: "s2" };
    const delayedClose = deferred();
    const closeError = new Error("first close failed");
    const first = createAgent(vi.fn(async () => { throw closeError; }));
    const second = createAgent(vi.fn(async () => { await delayedClose.promise; }));
    const context = createContext(vi.fn(async ({ session: loaded }: any) => loaded.id === "s1" ? first : second));
    context.store.getSession.mockImplementation((id: string) => id === "s1" ? session : secondSession);
    const pool = new AgentPool(context as any);
    await Promise.all([pool.acquireSession("s1"), pool.acquireSession("s2")]);

    let settled = false;
    const closing = pool.closeAll().finally(() => { settled = true; });
    await vi.waitFor(() => expect(second.close).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    delayedClose.resolve();

    await expect(closing).rejects.toBe(closeError);
    expect(pool.size).toBe(0);
  });

  it("rejects archived sessions before reading their transcript", async () => {
    const context = createContext();
    context.store.getSession.mockReturnValue({ ...session, status: "archived" });
    const pool = new AgentPool(context as any);

    await expect(pool.acquireSession(session.id)).rejects.toThrow("Session runtime is not available");
    expect(context.store.listMessages).not.toHaveBeenCalled();
    expect(context.store.listMessageParts).not.toHaveBeenCalled();
  });

  it("waits for the old generation to close before creating a replacement", async () => {
    const oldClose = deferred();
    const oldAgent = createAgent(vi.fn(async () => { await oldClose.promise; }));
    const newAgent = createAgent();
    const factory = vi.fn()
      .mockResolvedValueOnce(oldAgent)
      .mockResolvedValueOnce(newAgent);
    const pool = new AgentPool(createContext(factory) as any);

    await pool.acquireSession(session.id);
    const closing = pool.close(session.id);
    await vi.waitFor(() => expect(oldAgent.close).toHaveBeenCalledOnce());
    const replacement = pool.acquireSession(session.id);
    await Promise.resolve();
    expect(factory).toHaveBeenCalledOnce();
    expect(await pool.get(session.id)).toBeUndefined();
    oldClose.resolve();
    await closing;
    expect(await replacement).toBe(newAgent);

    expect(await pool.get(session.id)).toBe(newAgent);
    await pool.closeAll();
  });

  it("does not recreate a session that becomes archived while its agent closes", async () => {
    const oldClose = deferred();
    const oldAgent = createAgent(vi.fn(async () => { await oldClose.promise; }));
    const factory = vi.fn().mockResolvedValueOnce(oldAgent);
    let status: "idle" | "archived" = "idle";
    const context = createContext(factory);
    context.store.getSession.mockImplementation(() => ({ ...session, status }));
    const pool = new AgentPool(context as any);

    await pool.acquireSession(session.id);
    const closing = pool.close(session.id);
    const replacement = pool.acquireSession(session.id);
    status = "archived";
    oldClose.resolve();

    await closing;
    await expect(replacement).rejects.toThrow("Session runtime is not available");
    expect(factory).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
