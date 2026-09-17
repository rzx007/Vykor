import { describe, expect, it, vi } from "vitest";

import { SessionPostRunMaintenance } from "../session-post-run-maintenance.js";

function createStore(runStatus = "completed") {
  const store = {
    getSession: vi.fn(() => ({
      id: "s1",
      cwd: "/repo",
      model: "gpt-test",
      updatedAt: 20,
    })),
    getRun: vi.fn(() => ({ id: "run-1", sessionId: "s1", status: runStatus })),
    listMessages: vi.fn(() => [{ id: "m1", seq: 1, role: "user" }]),
    listMessageParts: vi.fn(() => [{ id: "p1", seq: 1, text: "ssh ops@10.0.0.9" }]),
    listSessions: vi.fn(() => []),
  };
  return {
    ...store,
    sessions: { get: store.getSession, list: store.listSessions },
    runs: { getRun: store.getRun },
    conversations: {
      listMessages: store.listMessages,
      listMessageParts: store.listMessageParts,
    },
  };
}

describe("SessionPostRunMaintenance", () => {
  it("runs personalization and semantic memory after a completed run", async () => {
    const store = createStore();
    const remember = vi.fn(async () => ({ skipped: true, writtenIds: [], titles: [] }));
    const personalizationUpdater = vi.fn(() => 1);
    const maintenance = new SessionPostRunMaintenance({
      data: store as any,
      getSettings: vi.fn(async () => ({
        memory: {
          enabled: true,
          sessionMemoryEnabled: false,
          autoExtractEnabled: true,
          autoDreamEnabled: false,
        },
      } as any)),
      personalizationUpdater,
      log: vi.fn(),
    });

    await maintenance.run("s1", "run-1", { remember } as any);

    expect(personalizationUpdater).toHaveBeenCalledWith([
      { role: "user", content: "ssh ops@10.0.0.9" },
    ]);
    expect(remember).toHaveBeenCalledOnce();
  });

  it("does nothing for a non-completed run", async () => {
    const getSettings = vi.fn();
    const maintenance = new SessionPostRunMaintenance({
      data: createStore("failed") as any,
      getSettings,
      log: vi.fn(),
    });

    await maintenance.run("s1", "run-1", { remember: vi.fn() } as any);

    expect(getSettings).not.toHaveBeenCalled();
  });

  it("keeps personalization active when semantic memory is disabled", async () => {
    const personalizationUpdater = vi.fn(() => 1);
    const remember = vi.fn();
    const maintenance = new SessionPostRunMaintenance({
      data: createStore() as any,
      getSettings: vi.fn(async () => ({ memory: { enabled: false } } as any)),
      personalizationUpdater,
      log: vi.fn(),
    });

    await maintenance.run("s1", "run-1", { remember } as any);

    expect(personalizationUpdater).toHaveBeenCalledOnce();
    expect(remember).not.toHaveBeenCalled();
  });

  it("logs best-effort failures without failing the completed run", async () => {
    const log = vi.fn();
    const maintenance = new SessionPostRunMaintenance({
      data: createStore() as any,
      getSettings: vi.fn(async () => ({
        memory: { enabled: true, sessionMemoryEnabled: false, autoExtractEnabled: false },
      } as any)),
      personalizationUpdater: vi.fn(() => { throw new Error("disk full"); }),
      log,
    });

    await expect(maintenance.run("s1", "run-1", { remember: vi.fn() } as any)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "session.personalization.extract_failed",
      error: "disk full",
    }));
  });

  it("does not reopen a completed run when loading maintenance settings fails", async () => {
    const log = vi.fn();
    const maintenance = new SessionPostRunMaintenance({
      data: createStore() as any,
      getSettings: vi.fn(async () => { throw new Error("bad settings"); }),
      log,
    });

    await expect(
      maintenance.run("s1", "run-1", { remember: vi.fn() } as any),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "session.post_run_maintenance_failed",
      error: "bad settings",
    }));
  });
});
