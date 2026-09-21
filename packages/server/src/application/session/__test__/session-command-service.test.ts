import { describe, expect, it, vi } from "vitest";

import { SessionApplicationError } from "../session-application-error.js";
import {
  SessionCommandService,
  type SessionCommandServiceOptions,
} from "../session-command-service.js";

const session = {
  id: "s1",
  cwd: "/repo",
  title: "Session",
  model: "gpt-test",
  status: "idle" as const,
  metadata: { runtime: { model: "gpt-test" } },
  createdAt: 1,
  updatedAt: 1,
};

function createService(overrides: {
  sessionRecord?: typeof session | null;
  hasWork?: boolean;
  barrierBlocked?: boolean;
} = {}) {
  const currentSession = overrides.sessionRecord === null ? undefined : (overrides.sessionRecord ?? session);
  const sessions = {
    createSession: vi.fn((input) => ({ ...session, ...input })),
    getSession: vi.fn(() => currentSession),
    updateSession: vi.fn((_id, input) => ({ ...session, ...input })),
    archiveSession: vi.fn(() => ({ ...session, status: "archived" as const })),
    beginArchive: vi.fn(() => ({ ...session, status: "closing" as const })),
    listChildSessions: vi.fn(() => []),
    deleteSessionTree: vi.fn((id: string) => [id]),
    forkSessionWithHistory: vi.fn((input: any) => ({ ...session, ...input.session })),
  };
  const transactions = {
    transaction: vi.fn((work: () => unknown) => work()),
    createMessage: vi.fn((input) => ({ id: "msg-switch", ...input })),
    upsertMessagePart: vi.fn((input) => ({ id: "part-switch", ...input })),
  };
  const runtimeControl = {
    closeAgent: vi.fn(async () => {}),
    hasActiveWorkForSession: vi.fn(() => false),
    interruptSession: vi.fn(() => ({ activeRunId: "r1", queuedRunIds: [] })),
    waitForRuns: vi.fn(async () => {}),
    hasRunWork: vi.fn(() => overrides.hasWork ?? false),
    interruptLiveChild: vi.fn(async () => false),
    hasLiveChild: vi.fn(() => false),
    warmSession: vi.fn(),
  };
  let barrierReleased = false;
  const operationGate = {
    tryEnterBarrier: vi.fn((_target, predicate) => {
      if (overrides.barrierBlocked) return null;
      if (predicate && !predicate()) return null;
      return { release: () => { barrierReleased = true; } };
    }),
    hasActiveBarriers: vi.fn(() => false),
  };
  const events = {
    checkpoint: vi.fn(() => 42),
    publishSince: vi.fn(),
  };
  const contextUsageCache = {
    invalidate: vi.fn(),
  };

  const options: SessionCommandServiceOptions = {
    sessions,
    transactions,
    runtimeControl,
    operationGate,
    events,
    contextUsageCache,
  };

  const service = new SessionCommandService(options);
  return {
    service,
    sessions,
    transactions,
    runtimeControl,
    operationGate,
    events,
    contextUsageCache,
    isBarrierReleased: () => barrierReleased,
  };
}

describe("SessionCommandService", () => {
  describe("createSession", () => {
    it("creates a session with runtime metadata, warms it, and publishes events", () => {
      const { service, sessions, runtimeControl, events } = createService();

      const created = service.createSession({
        id: "s2",
        cwd: "/repo",
        metadata: { runtime: { model: "custom-model" } },
      });

      expect(sessions.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "s2",
          cwd: "/repo",
          model: "custom-model",
          metadata: expect.objectContaining({
            runtime: expect.objectContaining({ model: "custom-model" }),
          }),
        }),
      );
      expect(runtimeControl.warmSession).toHaveBeenCalledWith(created);
      expect(events.publishSince).toHaveBeenCalledWith(42);
    });
  });

  describe("updateSession", () => {
    it("fails when session does not exist", async () => {
      const { service } = createService({ sessionRecord: null });

      await expect(service.updateSession("missing", { title: "New" })).rejects.toMatchObject({
        status: 404,
        message: "Session not found",
      });
    });

    it("rejects runtime config update when session has active work", async () => {
      const { service } = createService({ hasWork: true });

      await expect(
        service.updateSession("s1", { metadata: { runtime: { model: "another-model" } } }),
      ).rejects.toMatchObject({
        status: 409,
        message: "Cannot update runtime session settings while the session is active",
      });
    });

    it("switches model, creates presentation message, closes agent pool, and invalidates context usage cache", async () => {
      const { service, sessions, transactions, runtimeControl, contextUsageCache, events } = createService();

      await service.updateSession("s1", { metadata: { runtime: { model: "gpt-4o" } } });

      expect(transactions.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "s1",
          role: "system",
          metadata: {
            presentation: {
              kind: "model_switch",
              fromModel: "gpt-test",
              toModel: "gpt-4o",
            },
          },
        }),
      );
      expect(transactions.upsertMessagePart).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "s1",
          text: "模型已切换 gpt-test → gpt-4o",
        }),
      );
      expect(runtimeControl.closeAgent).toHaveBeenCalledWith("s1");
      expect(contextUsageCache.invalidate).toHaveBeenCalledWith("s1");
      expect(events.publishSince).toHaveBeenCalledWith(42);
    });

    it("updates title only without barrier or model switch message", async () => {
      const { service, sessions, transactions, operationGate, events } = createService();

      await service.updateSession("s1", { title: "Renamed Title" });

      expect(operationGate.tryEnterBarrier).not.toHaveBeenCalled();
      expect(transactions.createMessage).not.toHaveBeenCalled();
      expect(sessions.updateSession).toHaveBeenCalledWith("s1", expect.objectContaining({
        title: "Renamed Title",
      }));
      expect(events.publishSince).toHaveBeenCalledWith(42);
    });
  });

  describe("forkSession", () => {
    it("fails when source session does not exist", () => {
      const { service } = createService({ sessionRecord: null });

      expect(() => service.forkSession("missing")).toThrowError(
        new SessionApplicationError(404, "Session not found: missing"),
      );
    });

    it("maps Fork point not found error to 404", () => {
      const { service, sessions } = createService();
      sessions.forkSessionWithHistory.mockImplementation(() => {
        throw new Error("Fork point not found");
      });

      expect(() => service.forkSession("s1", { beforeMessageId: "invalid" })).toThrowError(
        new SessionApplicationError(404, "Fork point not found"),
      );
    });

    it("forks session, warms it, and publishes events", () => {
      const { service, sessions, runtimeControl, events } = createService();

      service.forkSession("s1", { afterMessageId: "m-1" });

      expect(sessions.forkSessionWithHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceSessionId: "s1",
          afterMessageId: "m-1",
          session: expect.objectContaining({
            parentId: "s1",
            cwd: "/repo",
            title: "Session fork",
            model: "gpt-test",
          }),
        }),
      );
      expect(runtimeControl.warmSession).toHaveBeenCalled();
      expect(events.publishSince).toHaveBeenCalledWith(42);
    });
  });

  describe("archiveSessionTree", () => {
    it("returns immediately if session is already archived", async () => {
      const { service, sessions } = createService({
        sessionRecord: { ...session, status: "archived" },
      });

      const result = await service.archiveSessionTree("s1");

      expect(result.status).toBe("archived");
      expect(sessions.archiveSession).not.toHaveBeenCalled();
    });

    it("fails archive when session does not exist", async () => {
      const { service } = createService({ sessionRecord: null });

      await expect(service.archiveSessionTree("missing")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("fails archive when session is busy with another operation", async () => {
      const { service } = createService({ barrierBlocked: true });

      await expect(service.archiveSessionTree("s1")).rejects.toMatchObject({
        status: 409,
        message: "Session is busy with another operation",
      });
    });

    it("deduplicates concurrent archiveSessionTree calls", async () => {
      const { service, sessions, runtimeControl } = createService();
      let resolveClose!: () => void;
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      runtimeControl.closeAgent.mockReturnValue(closePromise);

      const p1 = service.archiveSessionTree("s1");
      const p2 = service.archiveSessionTree("s1");

      resolveClose();
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBe(r2);
      expect(sessions.archiveSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("deleteSessionTree", () => {
    it("fails delete when session does not exist", async () => {
      const { service } = createService({ sessionRecord: null });

      await expect(service.deleteSessionTree("missing")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("fails delete when session is busy with another operation", async () => {
      const { service } = createService({ barrierBlocked: true });

      await expect(service.deleteSessionTree("s1")).rejects.toMatchObject({
        status: 409,
        message: "Session is busy with another operation",
      });
    });

    it("deletes child sessions recursively, cleans up runtime, and releases operation lease", async () => {
      const { service, sessions, runtimeControl, events, isBarrierReleased } = createService();
      const child = { ...session, id: "child-1", parentId: "s1" };
      sessions.listChildSessions.mockImplementation((id: string) => (id === "s1" ? [child as any] : []));
      sessions.deleteSessionTree.mockImplementation(() => {
        expect(isBarrierReleased()).toBe(false);
        return ["s1", "child-1"];
      });

      const deletedIds = await service.deleteSessionTree("s1");

      expect(deletedIds).toEqual(["s1", "child-1"]);
      expect(runtimeControl.interruptLiveChild).toHaveBeenCalledWith("s1", "Session deleted");
      expect(runtimeControl.interruptSession).toHaveBeenCalledWith("s1");
      expect(runtimeControl.closeAgent).toHaveBeenCalledWith("s1");
      expect(sessions.deleteSessionTree).toHaveBeenCalledWith("s1");
      expect(sessions.deleteSessionTree).toHaveBeenCalledTimes(1);
      expect(events.publishSince).toHaveBeenCalledWith(42);
      expect(sessions.beginArchive).not.toHaveBeenCalled();
      expect(isBarrierReleased()).toBe(true);
    });

    it("releases the deletion barrier without leaving sessions closing when persistence fails", async () => {
      const { service, sessions, isBarrierReleased } = createService();
      sessions.deleteSessionTree.mockImplementation(() => {
        throw new Error("delete failed");
      });

      await expect(service.deleteSessionTree("s1")).rejects.toThrow("delete failed");

      expect(sessions.beginArchive).not.toHaveBeenCalled();
      expect(isBarrierReleased()).toBe(true);
    });
  });
});
