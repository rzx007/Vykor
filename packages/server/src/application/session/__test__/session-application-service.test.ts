import { describe, expect, it, vi } from "vitest";

import { SessionApplicationError, SessionApplicationService } from "../session-application-service.js";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";

const session = {
  id: "s1",
  cwd: "/repo",
  title: "Session",
  model: "gpt-test",
  status: "idle",
  metadata: { runtime: { model: "gpt-test" } },
  createdAt: 1,
  updatedAt: 1,
} as const;

function createService(options: {
  hasWork?: boolean;
  run?: Record<string, any>;
  input?: Record<string, any>;
  inputs?: Array<Record<string, any>>;
  live?: boolean;
  owningRun?: Record<string, any>;
  resolveSkillCatalog?: () => Promise<{ resolvePath(path: string): { name: string; path: string } | undefined }>;
} = {}) {
  const store = {
    transaction: vi.fn((work: () => unknown) => work()),
    createSession: vi.fn((input) => ({ ...session, ...input })),
    createMessage: vi.fn((input) => ({ id: "model-switch-message", ...input })),
    upsertMessagePart: vi.fn((input) => ({ id: "model-switch-part", ...input })),
    getSession: vi.fn(() => session),
    updateSession: vi.fn((_sessionId, input) => ({ ...session, ...input })),
    listChildSessions: vi.fn(() => []),
    beginArchive: vi.fn(),
    archiveSession: vi.fn(() => ({ ...session, status: "archived" })),
    deleteSessionTree: vi.fn((id) => [id]),
    getRun: vi.fn((id) => id === options.run?.id ? options.run : undefined),
    getInput: vi.fn(() => options.input),
    listInputs: vi.fn(() => options.inputs ?? []),
    listRunsByInput: vi.fn(() => []),
    listMessages: vi.fn(() => []),
    listMessageParts: vi.fn(() => []),
    findRunByInput: vi.fn(() => options.owningRun),
    forkSessionWithHistory: vi.fn((input) => ({ ...session, ...input.session })),
    admitPrompt: vi.fn((input) => ({ id: input.id ?? "live-input", ...input })),
    appendEvent: vi.fn(),
  };
  const runEngine = {
    admitPromptAndMaybeRun: vi.fn(() => ({
      input: { id: "recovery-input", sessionId: "s1" },
      run: { id: "recovery-run", sessionId: "s1", status: "pending" },
      queue_state: "running",
    })),
    replayInput: vi.fn(() => ({
      input: options.input,
      run: { id: "recovery-run", sessionId: "s1", status: "pending" },
      queue_state: "running",
    })),
    interruptSession: vi.fn(() => ({ interrupted: false, queuedRunIds: [] })),
    waitForRuns: vi.fn(async () => {}),
    hasWork: vi.fn(() => options.hasWork ?? false),
    hasAnyActiveRuns: vi.fn(() => false),
    hasActiveRunsForCwd: vi.fn(() => false),
  };
  const agentPool = {
    configured: true,
    warm: vi.fn(async () => {}),
    get: vi.fn(),
    close: vi.fn(async () => {}),
    closeForCwd: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
    hasActiveWorkForSession: vi.fn(() => false),
  };
  const broadcastSince = vi.fn();
  const liveChildren = {
    has: vi.fn(() => options.live ?? false),
    send: vi.fn(async () => options.live ? {
      sessionId: "s1",
      inputId: options.input?.id,
      runId: options.run?.id,
      result: Promise.resolve({ status: "completed" as const, output: "done" }),
    } : undefined),
    interrupt: vi.fn(async () => false),
  };
  const operationGate = new DaemonOperationGate();
  const contextUsageCache = { invalidate: vi.fn(), get: vi.fn(), set: vi.fn(), clear: vi.fn() };
  const service = new SessionApplicationService({
    store: store as any,
    runEngine: runEngine as any,
    agentPool: agentPool as any,
    liveChildren,
    operationGate,
    events: { checkpoint: () => 7, publishSince: broadcastSince },
    contextUsageCache,
    resolveSkillCatalog: options.resolveSkillCatalog,
  });
  return { service, store, runEngine, agentPool, liveChildren, operationGate, broadcastSince, contextUsageCache };
}

describe("SessionApplicationService", () => {
  it("delivers validated Skill instructions to a live child while preserving original input items", async () => {
    const items = [{ type: "skill" as const, name: "review", path: "/review/SKILL.md" }];
    const run = { id: "live-run", sessionId: "s1", inputId: "live-input", status: "running" };
    const { service, liveChildren, store } = createService({
      live: true, run, owningRun: run,
      resolveSkillCatalog: async () => ({ resolvePath: (path) => path === "/review/SKILL.md" ? { name: "review", path } : undefined }),
    });
    let deliveredContent = "";
    liveChildren.send.mockImplementation(async (_sessionId, sent) => {
      deliveredContent = sent.content;
      store.getInput.mockReturnValue({ id: "live-input", sessionId: "s1", delivery: "queue", items: sent.inputItems ?? [{ type: "text", text: sent.content }], metadata: {} });
      return { sessionId: "s1", inputId: "live-input", runId: "live-run" } as any;
    });
    const result = await service.admitPrompt("s1", { id: "live-input", items });
    expect(result.input.items).toEqual(items);
    expect(deliveredContent).toContain("Skill 工具");
    expect(deliveredContent).toContain("/review/SKILL.md");
  });
  it("routes live child prompts back to framework controls without warming a second agent", async () => {
    const input = {
      id: "live-input",
      sessionId: "s1",
      delivery: "queue",
      content: "follow up",
      metadata: { requestedBy: "test" },
    };
    const run = { id: "live-run", sessionId: "s1", inputId: "live-input", status: "running" };
    const { service, store, runEngine, agentPool, liveChildren } = createService({
      live: true,
      input,
      run,
      owningRun: run,
    });
    store.getInput.mockReturnValueOnce(undefined).mockReturnValue(input);

    service.getSession("s1", { warm: true });
    const admitted = await service.admitPrompt("s1", {
      id: "live-input",
      delivery: "queue",
      content: "follow up",
      metadata: { requestedBy: "test" },
    });

    expect(agentPool.warm).not.toHaveBeenCalled();
    expect(liveChildren.send).toHaveBeenCalledWith("s1", expect.objectContaining({
      id: "live-input",
      delivery: "queue",
      content: "follow up",
      metadata: { requestedBy: "test" },
    }));
    expect(runEngine.admitPromptAndMaybeRun).not.toHaveBeenCalled();
    expect(admitted).toMatchObject({ input, run, queue_state: "running" });
  });

  it("fails a live child prompt when its framework receipt was not durably projected", async () => {
    const { service, store, runEngine, liveChildren } = createService({ live: true });
    liveChildren.send.mockResolvedValue({
      sessionId: "s1",
      inputId: "missing-input",
      runId: "missing-run",
      result: Promise.resolve({ status: "completed" as const, output: "done" }),
    });

    await expect(service.admitPrompt("s1", { content: "follow up" })).rejects.toEqual(
      expect.objectContaining<Partial<SessionApplicationError>>({ status: 500 }),
    );
    expect(store.admitPrompt).not.toHaveBeenCalled();
    expect(runEngine.admitPromptAndMaybeRun).not.toHaveBeenCalled();
  });

  it("accepts an active child steer owned by a transcript message in the current run", async () => {
    const input = {
      id: "live-input",
      sessionId: "s1",
      delivery: "steer",
      content: "follow up",
      metadata: {},
    };
    const run = { id: "live-run", sessionId: "s1", inputId: "primary-input", status: "running" };
    const { service, store } = createService({ live: true, input, run, owningRun: run });
    store.getInput.mockReturnValueOnce(undefined).mockReturnValue(input);

    await expect(service.admitPrompt("s1", {
      id: "live-input",
      content: "follow up",
      delivery: "steer",
    })).resolves.toMatchObject({ input, run, queue_state: "running" });
    expect(store.findRunByInput).toHaveBeenCalledWith("live-input");
  });

  it("rejects a live child receipt whose projected input belongs to another run", async () => {
    const input = {
      id: "live-input",
      sessionId: "s1",
      delivery: "steer",
      content: "follow up",
      metadata: {},
    };
    const run = { id: "live-run", sessionId: "s1", inputId: "primary-input", status: "running" };
    const owningRun = { ...run, id: "other-run" };
    const { service, store } = createService({ live: true, input, run, owningRun });
    store.getInput.mockReturnValueOnce(undefined).mockReturnValue(input);

    await expect(service.admitPrompt("s1", {
      id: "live-input",
      content: "follow up",
      delivery: "steer",
    })).rejects.toEqual(expect.objectContaining<Partial<SessionApplicationError>>({ status: 500 }));
  });

  it("creates a session, starts warming it, and publishes the store event", () => {
    const { service, agentPool, broadcastSince } = createService();

    const created = service.createSession({ cwd: "/repo", model: "gpt-test" });

    expect(created).toMatchObject({ cwd: "/repo", model: "gpt-test" });
    expect(agentPool.warm).toHaveBeenCalledWith("s1");
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("rejects runtime-setting changes while the session has run work", async () => {
    const { service, store, agentPool } = createService({ hasWork: true });

    await expect(service.updateSession("s1", {
      metadata: { runtime: { permissionMode: "plan" } },
    })).rejects.toEqual(expect.objectContaining<Partial<SessionApplicationError>>({
      status: 409,
    }));
    expect(store.updateSession).not.toHaveBeenCalled();
    expect(agentPool.close).not.toHaveBeenCalled();
  });

  it("closes the runtime after changing runtime metadata", async () => {
    const { service, store, agentPool, broadcastSince } = createService();

    await service.updateSession("s1", { metadata: { runtime: { permissionMode: "plan" } } });

    expect(store.updateSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      metadata: { runtime: { model: "gpt-test", permissionMode: "plan" } },
    }));
    expect(agentPool.close).toHaveBeenCalledWith("s1");
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("closes the runtime after changing the model", async () => {
    const { service, store, agentPool } = createService();

    await service.updateSession("s1", { metadata: { runtime: { model: "next-model" } } });

    expect(store.updateSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      model: "next-model",
      metadata: { runtime: { model: "next-model" } },
    }));
    expect(store.transaction).toHaveBeenCalledOnce();
    expect(store.createMessage).toHaveBeenCalledWith({
      sessionId: "s1",
      role: "system",
      metadata: {
        presentation: {
          kind: "model_switch",
          fromModel: "gpt-test",
          toModel: "next-model",
        },
      },
    });
    expect(store.upsertMessagePart).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s1",
      messageId: "model-switch-message",
      type: "text",
      status: "completed",
      text: "模型已切换 gpt-test → next-model",
    }));
    expect(agentPool.close).toHaveBeenCalledWith("s1");
  });

  it("does not create a presentation message when the model is unchanged", async () => {
    const { service, store } = createService();

    await service.updateSession("s1", { metadata: { runtime: { model: "gpt-test" } } });

    expect(store.createMessage).not.toHaveBeenCalled();
    expect(store.upsertMessagePart).not.toHaveBeenCalled();
  });

  it("routes attachment prompts to the durable run engine instead of a live child", async () => {
    const { service, runEngine, liveChildren } = createService({ live: true });

    await service.admitPrompt("s1", {
      id: "file-input",
      content: "inspect",
      delivery: "steer",
      attachments: [{ assetId: "att-1" }],
    });

    expect(liveChildren.send).not.toHaveBeenCalled();
    expect(runEngine.admitPromptAndMaybeRun).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        id: "file-input",
        attachments: [{ assetId: "att-1" }],
      }),
    );
  });

  it("blocks prompt admission until a runtime configuration change has closed the old agent", async () => {
    const { service, agentPool, runEngine } = createService();
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => { finishClose = resolve; });
    agentPool.close.mockReturnValue(closing);

    const updating = service.updateSession("s1", { metadata: { runtime: { model: "next-model" } } });
    await expect(service.admitPrompt("s1", { content: "too early" })).rejects.toEqual(
      expect.objectContaining<Partial<SessionApplicationError>>({ status: 409 }),
    );
    expect(runEngine.admitPromptAndMaybeRun).not.toHaveBeenCalled();

    finishClose();
    await updating;
    await expect(service.admitPrompt("s1", { content: "now" })).resolves.toBeDefined();
  });

  it("does not warm a session through an active global mutation barrier", () => {
    const { service, agentPool, operationGate } = createService();
    const lease = operationGate.tryEnterBarrier({ kind: "global" }, () => true)!;

    service.getSession("s1", { warm: true });

    expect(agentPool.warm).not.toHaveBeenCalled();
    lease.release();
  });

  it("resumes an interrupted run and records its recovery link", async () => {
    const sourceRun = {
      id: "source-run",
      sessionId: "s1",
      inputId: "source-input",
      status: "interrupted",
    };
    const sourceInput = {
      id: "source-input",
      sessionId: "s1",
      content: "retry this",
      attachments: [{ assetId: "asset-1", intent: "vision" }],
      metadata: {},
    };
    const { service, store, runEngine, broadcastSince } = createService({
      run: sourceRun,
      input: sourceInput,
    });

    const resumed = await service.resumeRun("s1", "source-run", {
      id: "recovery-run",
      metadata: { requestedBy: "test" },
      traceId: "trace-1",
    });

    expect(resumed.source_run).toBe(sourceRun);
    expect(resumed.input).toBe(sourceInput);
    expect(runEngine.replayInput).toHaveBeenCalledWith("source-input", {
      id: "recovery-run",
      metadata: {
        requestedBy: "test",
        recovery: {
          kind: "prompt_replay",
          sourceRunId: "source-run",
          sourceInputId: "source-input",
        },
      },
      traceId: "trace-1",
    });
    expect(store.appendEvent).toHaveBeenCalledWith({
      type: "session.run.recovery_requested",
      sessionId: "s1",
      payload: {
        sourceRunId: "source-run",
        sourceInputId: "source-input",
        recoveryInputId: "source-input",
        recoveryRunId: "recovery-run",
      },
    });
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("rejects a recovery run id that already belongs to another source", async () => {
    const sourceRun = {
      id: "source-run",
      sessionId: "s1",
      inputId: "source-input",
      status: "interrupted",
    };
    const sourceInput = {
      id: "source-input",
      sessionId: "s1",
      content: "retry this",
      attachments: [],
      metadata: {},
    };
    const conflictingRun = {
      id: "recovery-run",
      sessionId: "s1",
      inputId: "another-input",
      status: "pending",
      metadata: { recovery: { sourceRunId: "another-run" } },
    };
    const { service, store, runEngine } = createService({
      run: sourceRun,
      input: sourceInput,
    });
    store.getRun.mockImplementation((id) =>
      id === sourceRun.id ? sourceRun : id === conflictingRun.id ? conflictingRun : undefined,
    );

    await expect(service.resumeRun("s1", sourceRun.id, {
      id: conflictingRun.id,
      traceId: "trace-conflict",
    })).rejects.toMatchObject({ status: 409 });

    expect(runEngine.replayInput).not.toHaveBeenCalled();
  });

  it("forks a session through the store's atomic history copy", () => {
    const { service, store } = createService();

    service.forkSession("s1", { afterMessageId: "message-2" });

    expect(store.forkSessionWithHistory).toHaveBeenCalledWith({
      sourceSessionId: "s1",
      afterMessageId: "message-2",
      session: expect.objectContaining({
        parentId: "s1",
        cwd: "/repo",
        title: "Session fork",
        model: "gpt-test",
      }),
    });
  });

  it("closes child admission before taking the archive descendant snapshot", async () => {
    const { service, store } = createService();
    let closing = false;
    store.beginArchive.mockImplementation(() => {
      closing = true;
      return { ...session, status: "closing" };
    });
    store.listChildSessions.mockImplementation(() => {
      expect(closing).toBe(true);
      return [];
    });

    await service.archiveSessionTree("s1");

    expect(store.beginArchive.mock.invocationCallOrder[0])
      .toBeLessThan(store.listChildSessions.mock.invocationCallOrder[0]!);
  });

  describe("lifecycle characterization", () => {
    it("creates a session with runtime metadata and warms it", () => {
      const { service, store, agentPool, broadcastSince } = createService();

      const created = service.createSession({
        id: "s2",
        cwd: "/new-repo",
        metadata: { runtime: { model: "custom-model" } },
      });

      expect(store.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "s2",
          cwd: "/new-repo",
          model: "custom-model",
          metadata: expect.objectContaining({
            runtime: expect.objectContaining({ model: "custom-model" }),
          }),
        }),
      );
      expect(agentPool.warm).toHaveBeenCalledWith("s2");
      expect(broadcastSince).toHaveBeenCalledWith(7);
    });

    it("fails fork when source session does not exist", () => {
      const { service, store } = createService();
      store.getSession.mockReturnValue(undefined);

      expect(() => service.forkSession("missing-s")).toThrowError(
        new SessionApplicationError(404, "Session not found: missing-s"),
      );
    });

    it("maps Fork point not found error to 404", () => {
      const { service, store } = createService();
      store.forkSessionWithHistory.mockImplementation(() => {
        throw new Error("Fork point not found");
      });

      expect(() => service.forkSession("s1", { beforeMessageId: "invalid-id" })).toThrowError(
        new SessionApplicationError(404, "Fork point not found"),
      );
    });

    it("fails update when session does not exist", async () => {
      const { service, store } = createService();
      store.getSession.mockReturnValue(undefined);

      await expect(service.updateSession("missing-s", { title: "New" })).rejects.toMatchObject({
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

    it("switches model, creates system message, closes agent pool, and invalidates context usage cache", async () => {
      const { service, store, agentPool, contextUsageCache, broadcastSince } = createService();

      await service.updateSession("s1", { metadata: { runtime: { model: "gpt-4o" } } });

      expect(store.createMessage).toHaveBeenCalledWith(
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
      expect(store.upsertMessagePart).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "s1",
          text: "模型已切换 gpt-test → gpt-4o",
        }),
      );
      expect(agentPool.close).toHaveBeenCalledWith("s1");
      expect(contextUsageCache.invalidate).toHaveBeenCalledWith("s1");
      expect(broadcastSince).toHaveBeenCalledWith(7);
    });

    it("returns immediately if session is already archived", async () => {
      const { service, store } = createService();
      store.getSession.mockReturnValue({ ...session, status: "archived" });

      const result = await service.archiveSessionTree("s1");

      expect(result.status).toBe("archived");
      expect(store.archiveSession).not.toHaveBeenCalled();
    });

    it("fails archive when session does not exist", async () => {
      const { service, store } = createService();
      store.getSession.mockReturnValue(undefined);

      await expect(service.archiveSessionTree("missing")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("deduplicates concurrent archiveSessionTree calls", async () => {
      const { service, store, agentPool } = createService();
      let resolveClose!: () => void;
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      agentPool.close.mockReturnValue(closePromise);

      const p1 = service.archiveSessionTree("s1");
      const p2 = service.archiveSessionTree("s1");

      resolveClose();
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBe(r2);
      expect(store.archiveSession).toHaveBeenCalledTimes(1);
    });

    it("deletes session tree recursively and cleans up agent runtime", async () => {
      const { service, store, agentPool, runEngine, liveChildren } = createService();
      const child = { ...session, id: "child-1", parentId: "s1" };
      store.listChildSessions.mockImplementation((id) => (id === "s1" ? [child] : []));
      store.deleteSessionTree.mockImplementation((id) => (id === "s1" ? ["s1"] : [id]));

      const deletedIds = await service.deleteSessionTree("s1");

      expect(deletedIds).toEqual(["child-1", "s1"]);
      expect(liveChildren.interrupt).toHaveBeenCalledWith("s1", "Session deleted");
      expect(runEngine.interruptSession).toHaveBeenCalledWith("s1");
      expect(agentPool.close).toHaveBeenCalledWith("s1");
      expect(store.deleteSessionTree).toHaveBeenCalledWith("s1");
    });

    it("fails delete when session does not exist", async () => {
      const { service, store } = createService();
      store.getSession.mockReturnValue(undefined);

      await expect(service.deleteSessionTree("missing")).rejects.toMatchObject({
        status: 404,
      });
    });
  });
});
