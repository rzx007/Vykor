import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AdmitPromptAttachmentInput,
  SessionInputRecord,
  SessionRunRecord,
  SessionUserInputItem,
} from "@vykor/protocol";
import { DEFAULT_ATTACHMENT_LIMITS } from "@vykor/protocol";
import { AttachmentError, SessionStore } from "@vykor/services";
import { RunInterruptedError } from "../../../runtime/run-coordinator.js";
import {
  RunAdmissionService,
  type AdmitPromptInput,
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

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function createStoredAdmission() {
  const directory = mkdtempSync(join(tmpdir(), "vk-queued-admission-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.sessions.create({ id: "s1", cwd: directory, model: "test-model" });
  const { options, enqueueRunFn, steerFn } = createMockOptions();
  options.conversationTransactions = {
    admitPrompt: (input, config) => store.conversationTransactions.admitPrompt(input, config),
    admitPromptWithRun: (input, config) => store.conversationTransactions.admitPromptWithRun(input, config),
    replaceTranscriptAndAdmitPrompt: (input) => store.conversationTransactions.replaceTranscriptAndAdmitPrompt({ ...input, createRun: input.createRun ?? false }),
    replaceLatestPromptWithAdmission: (input) => store.conversationTransactions.replaceLatestPromptWithAdmission({ ...input, createRun: input.createRun ?? false }),
    getInput: (id) => store.conversations.getInput(id),
  };
  options.runOperations = store.runs;
  return { store, options, enqueueRunFn, steerFn, service: new RunAdmissionService(options) };
}

describe("RunAdmissionService synchronous queued persistence", () => {
  it("starts an active Goal directly with its normal Run binding", () => {
    const { store, options, service } = createStoredAdmission();
    const goal = store.goals.createGoal({ sessionId: "s1", objective: "finish", maxAutoTurns: 0 });
    const saved = service.persistGoalRun("s1", { id: "initial-goal", items: [{ type: "text", text: "finish" }],
      runMetadata: { goalId: goal.id, goalObjectiveVersion: 1, goalRunKind: "initial" } });
    options.goals = {
      getGoal: id => store.goals.getGoal(id),
      startGoalRun: (id, version, runId, automatic) => store.goals.startGoalRun(id, version, runId, automatic),
    };
    expect(service.prepareRunExecution(saved.run.id)).toBe(true);
    expect(store.goals.getGoal(goal.id)).toMatchObject({ status: "active", currentRunId: saved.run.id, autoTurnsUsed: 0, maxAutoTurns: 0 });
    expect(store.runs.getRun(saved.run.id)?.metadata).toMatchObject({ goalId: goal.id, goalObjectiveVersion: 1, goalRunKind: "initial" });
  });

  it("turns a queued Goal into an approval wait if permission arrived after admission", () => {
    const { store, options, service } = createStoredAdmission();
    const goal = store.goals.createGoal({ sessionId: "s1", objective: "finish", maxAutoTurns: 2 });
    const saved = service.persistGoalRun("s1", { id: "wait-result", items: [{ type: "text", text: "continue" }],
      runMetadata: { goalId: goal.id, goalObjectiveVersion: goal.objectiveVersion, goalRunKind: "continuation" } });
    const permission = store.permissions.create({ sessionId: "s1", toolName: "Bash", payload: {} });
    options.goals = { getGoal: id => store.goals.getGoal(id), pendingPermissionId: () => permission.id,
      waitForApproval: (id, version, permissionRequestId) => {
        const current = store.goals.getGoal(id)!;
        if (current.status === "active" && current.objectiveVersion === version) store.goals.updateGoal(id, {
          expectedRevision: current.revision, status: "waiting_user", wait: { kind: "approval", permissionRequestId },
        });
      } };
    expect(service.prepareRunExecution(saved.run.id)).toBe(false);
    expect(store.goals.getGoal(goal.id)).toMatchObject({ status: "waiting_user", wait: { kind: "approval", permissionRequestId: permission.id } });
    expect(store.goals.getGoal(goal.id)?.currentRunId).toBeUndefined();
    expect(store.goals.getGoal(goal.id)?.autoTurnsUsed).toBe(0);
  });
  it("saves corresponding ordinary Input/Run synchronously without dispatch or publication", () => {
    const { store, service, options, enqueueRunFn, steerFn } = createStoredAdmission();
    const cancelGoalRuns = vi.fn();
    options.goals = { getCurrentGoal: () => ({ id: "g1", status: "active", objectiveVersion: 1 }), cancelGoalRuns };

    const saved = service.persistQueuedPrompt("s1", {
      id: "confirmed-input",
      items: [{ type: "text", text: "用户确认的消息" }],
      content: "caller content must not override items",
      traceId: "confirmed.trace-1",
      metadata: { source: "confirmation" },
      runMetadata: { source: "confirmation-run", traceId: "conflicting-trace" },
    });

    expect(saved).not.toBeInstanceOf(Promise);
    expect(saved.run.inputId).toBe(saved.input.id);
    expect(store.conversations.getInput("confirmed-input")).toEqual(saved.input);
    expect(store.runs.getRun(saved.run.id)).toEqual(saved.run);
    expect(saved.input).toMatchObject({ delivery: "queue", content: "用户确认的消息", metadata: { source: "confirmation", traceId: "confirmed.trace-1" } });
    expect(saved.run).toMatchObject({ status: "pending", metadata: { source: "confirmation-run", traceId: "confirmed.trace-1" } });
    expect(enqueueRunFn).not.toHaveBeenCalled();
    expect(steerFn).not.toHaveBeenCalled();
    expect(options.events.checkpoint).not.toHaveBeenCalled();
    expect(options.events.publishSince).not.toHaveBeenCalled();
    expect(cancelGoalRuns).not.toHaveBeenCalled();
  });

  it.each([
    { traceId: "invalid trace", metadata: { traceId: "fallback.trace-2" }, want: "fallback.trace-2" },
    { traceId: "explicit.trace-3", metadata: { traceId: "other.trace" }, want: "explicit.trace-3" },
  ])("normalizes trace before saving Input and Run ($want)", ({ traceId, metadata, want }) => {
    const { service } = createStoredAdmission();
    const saved = service.persistQueuedPrompt("s1", { items: [{ type: "text", text: "hello" }], traceId, metadata });
    expect(saved.input.metadata.traceId).toBe(want);
    expect(saved.run.metadata.traceId).toBe(want);
  });

  it("generates a shared valid trace when both trace candidates are invalid", () => {
    const { service } = createStoredAdmission();
    const saved = service.persistQueuedPrompt("s1", {
      items: [{ type: "text", text: "hello" }], traceId: "invalid trace", metadata: { traceId: "also invalid" },
    });
    expect(saved.input.metadata.traceId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(saved.run.metadata.traceId).toBe(saved.input.metadata.traceId);
  });

  it("uses inputItems for content-only callers", () => {
    const { service } = createStoredAdmission();
    const saved = service.persistQueuedPrompt("s1", { content: "legacy content" } as AdmitPromptInput);
    expect(saved.input.items).toEqual([{ type: "text", text: "legacy content" }]);
  });

  it("rolls back Input and Run together when the real outer transaction fails", () => {
    const { store, service } = createStoredAdmission();
    let runId: string | undefined;
    expect(() => store.transaction(() => {
      const saved = service.persistQueuedPrompt("s1", {
        id: "rolled-back-input", items: [{ type: "text", text: "用户确认的消息" }],
      });
      runId = saved.run.id;
      expect(store.conversations.getInput(saved.input.id)).toBeDefined();
      expect(store.runs.getRun(saved.run.id)).toBeDefined();
      throw new Error("outer transaction rollback");
    })).toThrow("outer transaction rollback");
    expect(runId).toBeDefined();
    expect(store.conversations.getInput("rolled-back-input")).toBeUndefined();
    expect(store.runs.getRun(runId!)).toBeUndefined();
    expect(store.runs.listRuns("s1")).toEqual([]);
    const reopened = new SessionStore({ path: store.path });
    try {
      expect(reopened.conversations.getInput("rolled-back-input")).toBeUndefined();
      expect(reopened.runs.getRun(runId!)).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it.each([
    { condition: "steer", message: "Steered prompts cannot create their owning run during admission" },
    { condition: "no-model", message: "请先配置模型，再发送消息" },
    { condition: "not-ready", message: "not ready" },
    { condition: "stopped", message: "Session run engine is stopping" },
  ])("rejects $condition before writing Input or Run", ({ condition, message }) => {
    const { store, options, service, enqueueRunFn } = createStoredAdmission();
    const input: AdmitPromptInput = { id: "rejected-input", items: [{ type: "text", text: "hello" }] };
    if (condition === "steer") input.delivery = "steer";
    if (condition === "no-model") options.runtimeQueue.hasRuntime = false;
    if (condition === "not-ready") options.assertReady = () => { throw new Error("not ready"); };
    if (condition === "stopped") service.stop();
    expect(() => service.persistQueuedPrompt("s1", input)).toThrow(message);
    expect(store.conversations.getInput(input.id!)).toBeUndefined();
    expect(store.runs.listRuns("s1")).toEqual([]);
    expect(enqueueRunFn).not.toHaveBeenCalled();
    expect(options.events.publishSince).not.toHaveBeenCalled();
  });

  it.each(["metadata", "runMetadata"] as const)("rejects host-reserved %s before storage", (namespace) => {
    const { store, service } = createStoredAdmission();
    for (const name of ["pluginUi", "uiAction", "pluginUiSubmission"]) {
      expect(() => service.persistQueuedPrompt("s1", {
        id: "reserved-input", items: [{ type: "text", text: "hello" }], [namespace]: { [name]: {} },
      })).toThrow(expect.objectContaining({ code: "invalid_request" }));
    }
    expect(store.conversations.getInput("reserved-input")).toBeUndefined();
    expect(store.runs.listRuns("s1")).toEqual([]);
  });

  it("normalizes attachment intent and applies real attachment limits", () => {
    const { store, service, options } = createStoredAdmission();
    store.attachments.createImportingAttachment({ id: "asset-1", displayName: "asset.png", declaredMediaType: "image/png", stagingName: "asset.part", createdAt: 1 });
    store.attachments.markAttachmentReady("asset-1", { sha256: "a".repeat(64), sizeBytes: 100, mediaType: "image/png", updatedAt: 2 });
    const saved = service.persistQueuedPrompt("s1", { items: [{ type: "text", text: "attachment" }], attachments: [{ assetId: "asset-1" }] });
    expect(saved.input.attachments[0]).toMatchObject({ assetId: "asset-1", intent: "auto" });
    options.attachmentLimits = { ...DEFAULT_ATTACHMENT_LIMITS, maxBytesPerFile: 99, resumableThresholdBytes: 99 };
    expect(() => service.persistQueuedPrompt("s1", { id: "too-many", items: [], attachments: [{ assetId: "asset-1" }] })).toThrow(expect.objectContaining({ code: "attachment_too_large" }));
    expect(store.conversations.getInput("too-many")).toBeUndefined();
    expect(store.runs.listRuns("s1")).toHaveLength(1);
  });

  it("preserves Goal persistence readiness and trace behavior", () => {
    const { store, service, options } = createStoredAdmission();
    options.assertReady = () => { throw new Error("not ready"); };
    const saved = service.persistGoalRun("s1", {
      items: [{ type: "text", text: "goal task" }], traceId: "ignored-trace",
      metadata: { traceId: "legacy input trace" }, runMetadata: { goalId: "g1", traceId: "legacy run trace" },
    });
    expect(store.conversations.getInput(saved.input.id)?.metadata.traceId).toBe("legacy input trace");
    expect(store.runs.getRun(saved.run.id)?.metadata.traceId).toBe("legacy run trace");
    const withoutTrace = service.persistGoalRun("s1", { items: [{ type: "text", text: "goal without trace" }] });
    expect(withoutTrace.input.metadata).not.toHaveProperty("traceId");
    expect(withoutTrace.run.metadata).not.toHaveProperty("traceId");
  });
});

describe("RunAdmissionService user priority", () => {
  it.each(["active", "paused", undefined] as const)("only cancels queued continuation for an active Goal (%s)", (status) => {
    const { options } = createMockOptions();
    const cancelGoalRuns = vi.fn();
    options.goals = { getCurrentGoal: () => status ? { id: "g1", status, objectiveVersion: 1 } : undefined, cancelGoalRuns };
    new RunAdmissionService(options).prioritizeUserInput("s1");
    if (status === "active") expect(cancelGoalRuns).toHaveBeenCalledExactlyOnceWith("s1", "g1", "用户消息优先", true);
    else expect(cancelGoalRuns).not.toHaveBeenCalled();
  });

  it("preserves priority before duplicate-ID lookup and steer delivery", async () => {
    const { options, steerFn, runs } = createMockOptions();
    const actions: string[] = [];
    options.goals = {
      getCurrentGoal: () => ({ id: "g1", status: "active", objectiveVersion: 1 }),
      cancelGoalRuns: () => { actions.push("priority"); return []; },
    };
    const getInput = options.conversationTransactions.getInput;
    options.conversationTransactions.getInput = (id) => { actions.push("lookup"); return getInput(id); };
    runs.set("active-run", { id: "active-run", sessionId: "s1", inputId: "active-input", status: "running", metadata: {}, createdAt: 1, updatedAt: 1 });
    steerFn.mockImplementation(() => {
      actions.push("steer");
      return { merged: true, activeRunId: "active-run", delivery: Promise.resolve({ sessionId: "s1", inputId: "steered-input", runId: "active-run" }) };
    });
    await new RunAdmissionService(options).admitPromptAndMaybeRun("s1", {
      id: "steered-input", delivery: "steer", items: [{ type: "text", text: "steer" }],
    });
    expect(actions).toEqual(["priority", "lookup", "steer"]);
  });

  it("preserves user priority for repeated IDs without a second Run", async () => {
    const { options, runs } = createMockOptions();
    const cancelGoalRuns = vi.fn(() => []);
    options.goals = { getCurrentGoal: () => ({ id: "g1", status: "active", objectiveVersion: 1 }), cancelGoalRuns };
    const service = new RunAdmissionService(options);
    const input: AdmitPromptInput = { id: "shared-user-id", items: [{ type: "text", text: "hello" }] };
    const first = service.admitPromptAndMaybeRun("s1", input);
    const repeated = service.admitPromptAndMaybeRun("s1", input);
    expect((await first).run?.id).toBe((await repeated).run?.id);
    expect(runs.size).toBe(1);
    expect(cancelGoalRuns).toHaveBeenCalledTimes(2);
  });

  it("keeps Goal admission and replay outside user priority", async () => {
    const { options } = createMockOptions();
    const cancelGoalRuns = vi.fn(() => []);
    options.goals = { getCurrentGoal: () => ({ id: "g1", status: "active", objectiveVersion: 1 }), cancelGoalRuns };
    const service = new RunAdmissionService(options);
    const admitted = await service.admitPromptAndMaybeRun("s1", {
      items: [{ type: "text", text: "goal" }], runMetadata: { goalId: "g1", goalRunKind: "continuation" },
    });
    service.replayInput(admitted.input.id, {});
    expect(cancelGoalRuns).not.toHaveBeenCalled();
  });
});

describe("RunAdmissionService", () => {
  it.each(["metadata", "runMetadata"] as const)("rejects host UI %s before Prompt persistence or goal cancellation", async namespace => {
    for (const name of ["pluginUi", "uiAction", "pluginUiSubmission"]) {
      const { options, inputs, runs } = createMockOptions();
      const cancelGoalRuns = vi.fn(() => []);
      options.goals = { getCurrentGoal: () => ({ id: "g1", status: "active", objectiveVersion: 1 }), cancelGoalRuns };
      const service = new RunAdmissionService(options);
      await expect(Promise.resolve().then(() => service.admitPromptAndMaybeRun("s1", {
        items: [{ type: "text", text: "hello" }], [namespace]: { [name]: {} },
      }))).rejects.toMatchObject({ code: "invalid_request" });
      expect(inputs.size).toBe(0);
      expect(runs.size).toBe(0);
      expect(cancelGoalRuns).not.toHaveBeenCalled();
    }
  });

  it.each(["metadata", "runMetadata"] as const)("rejects host UI %s for transcript replacement, latest edits and goals", namespace => {
    const { options, inputs, runs } = createMockOptions();
    const service = new RunAdmissionService(options);
    const input = { items: [{ type: "text" as const, text: "hello" }], [namespace]: { uiAction: {} } };
    expect(() => service.replaceTranscriptAndAdmitPrompt("s1", [], input)).toThrow();
    expect(() => service.replaceLatestPrompt("s1", "m1", input)).toThrow();
    expect(() => service.persistGoalRun("s1", input)).toThrow();
    expect(inputs.size).toBe(0);
    expect(runs.size).toBe(0);
  });

  it("rejects host UI replay metadata before creating a Run", () => {
    const { options, inputs, runs } = createMockOptions();
    inputs.set("i1", { id: "i1", sessionId: "s1", items: [], delivery: "queue", attachments: [], metadata: {}, createdAt: 1 });
    const service = new RunAdmissionService(options);
    expect(() => service.replayInput("i1", { metadata: { pluginUi: {} } })).toThrow();
    expect(runs.size).toBe(0);
  });
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

  it("keeps the admitted plugin when a rejected steer becomes a separate run", () => {
    const { options, inputs, runs } = createMockOptions();
    inputs.set("plugin-steer", { id: "plugin-steer", sessionId: "s1", items: [{ type: "text", text: "continue" }],
      delivery: "steer", attachments: [], metadata: { pluginId: "P" }, createdAt: 1 } as any);
    const runId = new RunAdmissionService(options).recoverRejectedSteer("s1", { id: "plugin-steer" });
    expect(runs.get(runId)?.metadata.pluginId).toBe("P");
  });

  it("rejects a stale goal objective version before execution", () => {
    const { options, runs, runOperations } = createMockOptions();
    runs.set("r1", { id: "r1", sessionId: "s1", inputId: "i1", status: "pending", metadata: { goalId: "g1", goalObjectiveVersion: 1, goalRunKind: "continuation" }, createdAt: 1, updatedAt: 1 });
    options.goals = {
      getGoal: vi.fn(() => ({ id: "g1", status: "active", objectiveVersion: 2 })),
      startGoalRun: vi.fn(() => false),
    };

    expect(new RunAdmissionService(options).prepareRunExecution("r1")).toBe(false);
    expect(options.goals.startGoalRun).toHaveBeenCalledWith("g1", 1, "r1", true);
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
      getCurrentGoal: vi.fn(() => ({ id: "g1", status: "active", objectiveVersion: 1 })),
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
      getCurrentGoal: vi.fn(() => ({ id: "g1", status: "active", objectiveVersion: 1 })),
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
