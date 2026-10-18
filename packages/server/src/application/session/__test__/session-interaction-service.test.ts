import { describe, expect, it, vi } from "vitest";

import { SessionApplicationError, SessionInteractionService } from "../session-interaction-service.js";
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
    updateRun: vi.fn((id, patch) => {
      if (id === options.run?.id) Object.assign(options.run, patch);
      return options.run;
    }),
    getInput: vi.fn(() => options.input),
    listInputs: vi.fn(() => options.inputs ?? []),
    listRunsByInput: vi.fn(() => []),
    listMessages: vi.fn((): Array<{ runId?: string }> => []),
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
    interruptRun: vi.fn((_sessionId: string, _runId: string) => ({ interrupted: false, queuedRunIds: [] as string[] })),
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
    send: vi.fn(async (_sessionId, sent) => {
      if (options.input) Object.assign(options.input, { metadata: sent.metadata, items: sent.inputItems });
      return options.live ? {
      sessionId: "s1",
      inputId: options.input?.id,
      runId: options.run?.id,
      result: Promise.resolve({ status: "completed" as const, output: "done" }),
      } : undefined;
    }),
    interrupt: vi.fn(async () => false),
  };
  const operationGate = new DaemonOperationGate();
  const contextUsageCache = { invalidate: vi.fn(), get: vi.fn(), set: vi.fn(), clear: vi.fn() };
  const service = new SessionInteractionService({
    sessions: {
      get: store.getSession,
      listChildren: store.listChildSessions,
    },
    conversations: store as any,
    runs: store as any,
    admission: runEngine as any,
    control: runEngine as any,
    operationRunner: {
      run: async (_id, work) => {
        const result = await work();
        broadcastSince(7);
        return result;
      },
    },
    agentPool: agentPool as any,
    liveChildren,
    operationGate,
    resolveSkillCatalog: options.resolveSkillCatalog,
  });
  return { service, store, runEngine, agentPool, liveChildren, operationGate, broadcastSince, contextUsageCache };
}

describe("SessionInteractionService", () => {
  it("records an explicit system stop without labelling it as a user stop", async () => {
    const run = { id: "r1", sessionId: "s1", status: "running", metadata: {} };
    const { service, runEngine } = createService({ run });
    const result = { interrupted: true, activeRunId: run.id, queuedRunIds: [] };
    runEngine.interruptRun.mockReturnValue(result);
    await service.interruptSession("s1", run.id, "system");
    expect(run.metadata).toMatchObject({ interruption: { source: "system", runId: run.id } });
  });
  it.each([true, false])("records the user source only after an accepted stop (scoped: %s)", async scoped => {
    const run = { id: "r1", sessionId: "s1", status: "running", startedAt: 1, metadata: { keep: true } };
    const { service, store, runEngine } = createService({ run });
    const result = { interrupted: true, activeRunId: run.id, queuedRunIds: [] };
    runEngine.interruptRun.mockReturnValue(result);
    runEngine.interruptSession.mockReturnValue(result);
    await service.interruptSession("s1", scoped ? run.id : undefined);
    expect(run.metadata).toMatchObject({ keep: true, interruption: {
      source: "user", runId: "r1", requestedAt: expect.any(Number), wasPending: false,
    } });
    expect(store.updateRun).toHaveBeenCalledTimes(1);
  });

  it("does not mark a rejected stop or an already completed run", async () => {
    const run = { id: "r1", sessionId: "s1", status: "running", metadata: {} };
    const { service, store, runEngine } = createService({ run });
    await service.interruptSession("s1", run.id);
    expect(store.updateRun).not.toHaveBeenCalled();
    run.status = "completed";
    const result = { interrupted: true, activeRunId: run.id, queuedRunIds: [] };
    runEngine.interruptRun.mockReturnValue(result);
    await service.interruptSession("s1", run.id);
    expect(store.updateRun).not.toHaveBeenCalled();
  });

  it("also records a user stop delivered through a live child handle", async () => {
    const run = { id: "child-run", sessionId: "s1", status: "running", startedAt: 1, metadata: {} };
    const { service, store, liveChildren } = createService({ run, live: true });
    store.listMessages.mockReturnValue([{ runId: run.id }]);
    liveChildren.interrupt.mockImplementation(async () => { run.status = "interrupted"; return true; });
    await service.interruptSession("s1");
    expect(run.metadata).toMatchObject({ interruption: { source: "user", runId: run.id } });
  });

  it("marks a cancelled queued target without attributing the active run to the user", async () => {
    const run = { id: "queued", sessionId: "s1", status: "interrupted", metadata: {} };
    const { service, store, runEngine } = createService({ run });
    const result = { interrupted: true, activeRunId: "unrelated", queuedRunIds: [run.id] };
    runEngine.interruptRun.mockReturnValue(result);
    await service.interruptSession("s1", run.id);
    expect(store.updateRun).toHaveBeenCalledTimes(1);
    expect(run.metadata).toMatchObject({ interruption: { source: "user", wasPending: true } });
    const recorded = JSON.stringify(run.metadata);
    await service.interruptSession("s1", run.id);
    expect(JSON.stringify(run.metadata)).toBe(recorded);
  });

  it.each(["metadata", "runMetadata"])("rejects reserved host names in %s before live-child delivery", async namespace => {
    for (const name of ["pluginUi", "uiAction"]) {
      const { service, liveChildren, runEngine, store } = createService({ live: true });
      await expect(service.admitPrompt("s1", { content: "hello", [namespace]: { [name]: {} } }))
        .rejects.toMatchObject({ code: "invalid_request" });
      expect(liveChildren.send).not.toHaveBeenCalled();
      expect(runEngine.admitPromptAndMaybeRun).not.toHaveBeenCalled();
      expect(store.admitPrompt).not.toHaveBeenCalled();
    }
  });
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
      store.getInput.mockReturnValue({ id: "live-input", sessionId: "s1", delivery: "queue", items: sent.inputItems ?? [{ type: "text", text: sent.content }], metadata: sent.metadata });
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

    await service.warmSession("s1");
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
      metadata: expect.objectContaining({ requestedBy: "test", pluginScope: expect.objectContaining({ scopeVersion: 2, pluginIds: [] }) }),
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

  it("does not warm a session through an active global mutation barrier", async () => {
    const { service, agentPool, operationGate } = createService();
    const lease = operationGate.tryEnterBarrier({ kind: "global" }, () => true)!;

    await service.warmSession("s1");

    expect(agentPool.warm).not.toHaveBeenCalled();
    lease.release();
  });

  it("resumes an interrupted run and records its recovery link", async () => {
    const sourceRun = {
      id: "source-run",
      sessionId: "s1",
      inputId: "source-input",
      status: "interrupted",
      metadata: {},
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

  it("explicitly rejects UI action prompt replay even if an input ID is present", async () => {
    const { service } = createService({ run: { id: "ui-run", sessionId: "s1", inputId: "source-input", status: "interrupted", metadata: {
      uiAction: { schemaVersion: 2, instanceId: "00000000-0000-0000-0000-000000000002", requestId: "00000000-0000-0000-0000-000000000001",
        requestFingerprint: "a".repeat(64), expectedRevision: 1, actionId: "apply", label: "Apply", args: {},
        pluginId: "test.ui", pluginVersion: "1.0.0", pluginDigest: "b".repeat(64), componentDigest: "c".repeat(64),
        toolName: "Apply", toolUseId: "call", executionState: "unknown" },
    } } });
    await expect(service.resumeRun("s1", "ui-run", {})).rejects.toMatchObject({ code: "plugin_ui_action_not_resumable" });
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
});
