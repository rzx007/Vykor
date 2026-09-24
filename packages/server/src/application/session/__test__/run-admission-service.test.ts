import { describe, expect, it, vi } from "vitest";
import type {
  AdmitPromptAttachmentInput,
  SessionInputRecord,
  SessionRunRecord,
  SessionUserInputItem,
} from "@vykor/protocol";
import { AttachmentError } from "@vykor/services";
import { RunInterruptedError } from "../../../runtime/run-coordinator.js";
import {
  RunAdmissionService,
  type RunAdmissionServiceOptions,
} from "../run-admission-service.js";

function createMockOptions() {
  const inputs = new Map<string, SessionInputRecord>();
  const runs = new Map<string, SessionRunRecord>();
  const inputOwners = new Map<string, string>();
  let inputCount = 0;
  let runCount = 0;

  const admitPrompt = vi.fn((input: any) => {
    const row: SessionInputRecord = {
      ...input,
      id: input.id ?? `i${++inputCount}`,
      delivery: input.delivery ?? "queue",
      attachments: input.attachments ?? [],
      createdAt: 1,
    } as any;
    inputs.set(row.id, row);
    return row;
  });

  const createRun = vi.fn((input: any) => {
    const row: SessionRunRecord = {
      ...input,
      id: input.id ?? `r${++runCount}`,
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
    } as any;
    runs.set(row.id, row);
    return row;
  });

  const steerFn = vi.fn((_sessionId: string, _input: any) => ({
    merged: false,
    delivery: Promise.resolve({ sessionId: "s1", inputId: "i1", runId: "r1" }),
  }));

  const enqueueRunFn = vi.fn((_run: SessionRunRecord, _inputId: string) => "running" as const);

  const options: RunAdmissionServiceOptions = {
    sessionQueries: {
      getSession: vi.fn((id: string) => ({ id, cwd: "/test", status: "open" } as any)),
    },
    conversationTransactions: {
      admitPrompt,
      admitPromptWithRun: vi.fn((input: any) => {
        const admitted = admitPrompt({ ...input.prompt, delivery: "queue" });
        const run = createRun({
          id: input.run?.id,
          sessionId: admitted.sessionId,
          inputId: admitted.id,
          metadata: input.run?.metadata,
        });
        return { input: admitted, run };
      }),
      replaceTranscriptAndAdmitPrompt: vi.fn((input: any) => {
        const admitted = admitPrompt({ ...input.admission.prompt, delivery: "queue" });
        const run = createRun({
          id: input.admission.run?.id,
          sessionId: admitted.sessionId,
          inputId: admitted.id,
          metadata: input.admission.run?.metadata,
        });
        return { transcript: { messages: [], parts: [] }, input: admitted, run };
      }),
      replaceLatestPromptWithAdmission: vi.fn((input: any) => {
        const admitted = admitPrompt({ ...input.admission.prompt, delivery: "queue" });
        const run = createRun({
          id: input.admission.run?.id,
          sessionId: admitted.sessionId,
          inputId: admitted.id,
          metadata: input.admission.run?.metadata,
        });
        return { transcript: { messages: [], parts: [] }, input: admitted, run };
      }),
      getInput: vi.fn((id: string) => inputs.get(id)),
    },
    runOperations: {
      createRun,
      getRun: vi.fn((id: string) => runs.get(id)),
      findRunByInput: vi.fn((id: string) => {
        const direct = [...runs.values()].find((r) => r.inputId === id);
        return direct ?? runs.get(inputOwners.get(id)!);
      }),
      createReplayRun: vi.fn((inputId: string, input: any) => {
        const source = inputs.get(inputId)!;
        const existing = input.id ? runs.get(input.id) : undefined;
        if (existing) return existing;
        return createRun({
          id: input.id,
          sessionId: source.sessionId,
          inputId,
          metadata: input.metadata,
        });
      }),
      updateRun: vi.fn((id: string, update: any) => {
        const run = Object.assign(runs.get(id) ?? {}, update);
        runs.set(id, run);
        return run;
      }),
      appendEvent: vi.fn(),
      transaction: (work) => work(),
    },
    runtimeQueue: {
      enqueueRun: enqueueRunFn,
      steer: steerFn,
      hasRuntime: true,
    },
    events: {
      checkpoint: vi.fn(() => 1),
      publishSince: vi.fn(),
    },
  };

  return {
    options,
    inputs,
    runs,
    inputOwners,
    admitPrompt,
    createRun,
    steerFn,
    enqueueRunFn,
    conversationTransactions: options.conversationTransactions,
    runOperations: options.runOperations,
  };
}

describe("RunAdmissionService", () => {
  it("dispatches a persisted pending run once", () => {
    const { options, inputs, runs, enqueueRunFn } = createMockOptions();
    inputs.set("i1", { id: "i1", sessionId: "s1", items: [], delivery: "queue", attachments: [], metadata: {}, createdAt: 1 } as any);
    runs.set("r1", { id: "r1", sessionId: "s1", inputId: "i1", status: "pending", metadata: {}, createdAt: 1, updatedAt: 1 });
    options.runtimeQueue.runState = vi.fn(() => undefined);
    const service = new RunAdmissionService(options);

    expect(service.dispatchPersistedRun("r1")).toBe("running");
    expect(enqueueRunFn).toHaveBeenCalledOnce();

    (options.runtimeQueue.runState as any).mockReturnValue("running");
    expect(service.dispatchPersistedRun("r1")).toBe("running");
    expect(enqueueRunFn).toHaveBeenCalledOnce();
  });

  it("recovers a rejected steer with one durable replacement run", () => {
    const { options, inputs, runs, createRun, enqueueRunFn } = createMockOptions();
    inputs.set("i1", { id: "i1", sessionId: "s1", items: [], delivery: "steer", attachments: [], metadata: { traceId: "trace-1" }, createdAt: 1 } as any);
    const service = new RunAdmissionService(options);

    const runId = service.recoverRejectedSteer("s1", { id: "i1" });
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s1",
      inputId: "i1",
      metadata: { traceId: "trace-1", recoveredFromSteer: true },
    }));
    expect(enqueueRunFn).toHaveBeenCalledOnce();

    expect(service.recoverRejectedSteer("s1", { id: "i1" })).toBe(runId);
    expect(createRun).toHaveBeenCalledOnce();
  });

  it("rejects stale goal revisions before execution", () => {
    const { options, runs, runOperations } = createMockOptions();
    runs.set("r1", { id: "r1", sessionId: "s1", inputId: "i1", status: "pending", metadata: { goalId: "g1", goalRevision: 1, goalRunKind: "continuation" }, createdAt: 1, updatedAt: 1 });
    options.goals = {
      getGoal: vi.fn(() => ({ id: "g1", sessionId: "s1", status: "active", revision: 2 } as any)),
      startGoalRun: vi.fn(() => false),
    };

    expect(new RunAdmissionService(options).prepareRunExecution("r1")).toBe(false);
    expect(runOperations.updateRun).toHaveBeenCalledWith("r1", expect.objectContaining({
      status: "interrupted",
      error: "目标已暂停或版本已变化",
    }));
  });

  it("admits prompt and enqueues run when runtime is idle", async () => {
    const { options, createRun, enqueueRunFn } = createMockOptions();
    const service = new RunAdmissionService(options);

    const result = await service.admitPromptAndMaybeRun("s1", {
      items: [{ type: "text", text: "hello" }],
    });

    expect(result.input).toBeDefined();
    expect(result.run).toBeDefined();
    expect(result.queue_state).toBe("running");
    expect(createRun).toHaveBeenCalledOnce();
    expect(enqueueRunFn).toHaveBeenCalledWith(result.run, result.input.id);
  });

  it("returns queue_state 'queued' when runtime queue reports busy", async () => {
    const { options, enqueueRunFn } = createMockOptions();
    enqueueRunFn.mockReturnValue("queued");
    const service = new RunAdmissionService(options);

    const result = await service.admitPromptAndMaybeRun("s1", {
      items: [{ type: "text", text: "hello queue" }],
    });

    expect(result.queue_state).toBe("queued");
  });

  it("steers active run directly when delivery is steer and handle is active", async () => {
    const { options, runs, steerFn } = createMockOptions();
    const activeRun: SessionRunRecord = {
      id: "active-r1",
      sessionId: "s1",
      inputId: "i-active",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
    };
    runs.set("active-r1", activeRun);
    steerFn.mockReturnValue({
      merged: true,
      activeRunId: "active-r1",
      delivery: Promise.resolve({ sessionId: "s1", inputId: "i1", runId: "active-r1" }),
    });
    const service = new RunAdmissionService(options);

    const result = await service.admitPromptAndMaybeRun("s1", {
      delivery: "steer",
      items: [{ type: "text", text: "steer msg" }],
    });

    expect(result.run?.id).toBe("active-r1");
    expect(result.queue_state).toBe("running");
  });

  it("downgrades steer to queue when attachments are present", async () => {
    const { options, conversationTransactions } = createMockOptions();
    const service = new RunAdmissionService(options);

    const result = await service.admitPromptAndMaybeRun("s1", {
      delivery: "steer",
      items: [{ type: "text", text: "steer with attachment" }],
      attachments: [{ assetId: "ast-1" } as AdmitPromptAttachmentInput],
    });

    expect(result.input.delivery).toBe("queue");
    expect(conversationTransactions.admitPromptWithRun).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.objectContaining({ delivery: "queue" }),
      }),
    );
  });

  it("rejects capability steer without admitting prompt", async () => {
    const { options, conversationTransactions } = createMockOptions();
    const service = new RunAdmissionService(options);

    await expect(
      service.admitPromptAndMaybeRun("s1", {
        delivery: "steer",
        items: [
          {
            type: "capability",
            kind: "plugin",
            pluginId: "dev.plugin",
            displayName: "Plugin",
          },
        ],
      }),
    ).rejects.toThrow("session_capability_requires_queued_run");

    expect(conversationTransactions.admitPrompt).not.toHaveBeenCalled();
    expect(conversationTransactions.admitPromptWithRun).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent requests with the same input id", async () => {
    const { options } = createMockOptions();
    const service = new RunAdmissionService(options);

    const p1 = service.admitPromptAndMaybeRun("s1", {
      id: "shared-id",
      items: [{ type: "text", text: "hello" }],
    });
    const p2 = service.admitPromptAndMaybeRun("s1", {
      id: "shared-id",
      items: [{ type: "text", text: "hello" }],
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.input.id).toBe("shared-id");
    expect(r2.input.id).toBe("shared-id");
    expect(r1.run?.id).toBe(r2.run?.id);
  });

  it("throws AttachmentError prompt_id_conflict on concurrent input id conflict", async () => {
    const { options } = createMockOptions();
    const service = new RunAdmissionService(options);

    const p1 = service.admitPromptAndMaybeRun("s1", {
      id: "conflicting-id",
      items: [{ type: "text", text: "first text" }],
    });

    expect(() =>
      service.admitPromptAndMaybeRun("s1", {
        id: "conflicting-id",
        items: [{ type: "text", text: "different text" }],
      }),
    ).toThrow(AttachmentError);

    await p1;
  });

  it("recovers missing owning run for existing input", async () => {
    const { options, inputs, createRun } = createMockOptions();
    const existingInput: SessionInputRecord = {
      id: "existing-input-1",
      sessionId: "s1",
      items: [{ type: "text", text: "existing text" }],
      delivery: "queue",
      attachments: [],
      metadata: {},
      createdAt: 1,
    } as any;
    inputs.set("existing-input-1", existingInput);
    const service = new RunAdmissionService(options);

    const result = await service.admitPromptAndMaybeRun("s1", {
      id: "existing-input-1",
      items: [{ type: "text", text: "existing text" }],
    });

    expect(result.input.id).toBe("existing-input-1");
    expect(result.run).toBeDefined();
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        inputId: "existing-input-1",
        metadata: expect.objectContaining({ recoveredAdmission: true }),
      }),
    );
  });

  it("terminalizes undelivered steer when steer delivery fails", async () => {
    const { options, steerFn, runOperations } = createMockOptions();
    steerFn.mockReturnValue({
      merged: true,
      activeRunId: "r-active",
      delivery: Promise.reject(new RunInterruptedError("Interrupted steer")),
    });
    const service = new RunAdmissionService(options);

    await expect(
      service.admitPromptAndMaybeRun("s1", {
        delivery: "steer",
        items: [{ type: "text", text: "failing steer" }],
      }),
    ).rejects.toThrow(RunInterruptedError);

    expect(runOperations.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ steerDeliveryFailed: true }),
      }),
    );
  });

  it("cancels active goal continuation runs with '用户消息优先' when admitting user prompt", async () => {
    const { options } = createMockOptions();
    const cancelGoalRuns = vi.fn(() => ["gr1"]);
    options.goals = {
      getCurrentGoal: vi.fn(() => ({ id: "g1", status: "active", revision: 1 })),
      cancelGoalRuns,
    };
    const service = new RunAdmissionService(options);

    await service.admitPromptAndMaybeRun("s1", {
      items: [{ type: "text", text: "user message" }],
    });

    expect(cancelGoalRuns).toHaveBeenCalledWith("s1", "g1", "用户消息优先", true);
  });

  it("persists goal run without canceling goal runs", async () => {
    const { options, conversationTransactions } = createMockOptions();
    const cancelGoalRuns = vi.fn();
    options.goals = {
      getCurrentGoal: vi.fn(() => ({ id: "g1", status: "active", revision: 1 })),
      cancelGoalRuns,
    };
    const service = new RunAdmissionService(options);

    const result = service.persistGoalRun("s1", {
      items: [{ type: "text", text: "goal task" }],
      runMetadata: { goalId: "g1", goalRunKind: "continuation" },
    });

    expect(result.input).toBeDefined();
    expect(result.run).toBeDefined();
    expect(conversationTransactions.admitPromptWithRun).toHaveBeenCalled();
    expect(cancelGoalRuns).not.toHaveBeenCalled();
  });

  it("replaces transcript and admits prompt", () => {
    const { options, conversationTransactions, enqueueRunFn } = createMockOptions();
    const service = new RunAdmissionService(options);

    const result = service.replaceTranscriptAndAdmitPrompt(
      "s1",
      [],
      { items: [{ type: "text", text: "edited prompt" }] },
    );

    expect(conversationTransactions.replaceTranscriptAndAdmitPrompt).toHaveBeenCalled();
    expect(result.input).toBeDefined();
    expect(result.run).toBeDefined();
    expect(enqueueRunFn).toHaveBeenCalledWith(result.run, result.input.id);
  });

  it("replaces latest prompt and admits prompt", () => {
    const { options, conversationTransactions, enqueueRunFn } = createMockOptions();
    const service = new RunAdmissionService(options);

    const result = service.replaceLatestPrompt(
      "s1",
      "msg-1",
      { items: [{ type: "text", text: "new latest prompt" }] },
    );

    expect(conversationTransactions.replaceLatestPromptWithAdmission).toHaveBeenCalled();
    expect(result.input).toBeDefined();
    expect(result.run).toBeDefined();
    expect(enqueueRunFn).toHaveBeenCalledWith(result.run, result.input.id);
  });

  it("replays input and creates a replay run", () => {
    const { options, inputs, runOperations, enqueueRunFn } = createMockOptions();
    inputs.set("i-source", {
      id: "i-source",
      sessionId: "s1",
      items: [{ type: "text", text: "source prompt" }],
      delivery: "queue",
      attachments: [],
      metadata: {},
      createdAt: 1,
    } as any);
    const service = new RunAdmissionService(options);

    const result = service.replayInput("i-source", {
      metadata: { recovery: { kind: "prompt_replay" } },
    });

    expect(runOperations.createReplayRun).toHaveBeenCalled();
    expect(result.input.id).toBe("i-source");
    expect(result.run).toBeDefined();
    expect(enqueueRunFn).toHaveBeenCalled();
  });
});
