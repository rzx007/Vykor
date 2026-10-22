import {hostedAgentFactory} from "./../../../../test-helpers/hosted-agent.js";
import { describe, expect, it, vi } from "vitest";

import { AgentPool } from "../agent-pool.js";

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
