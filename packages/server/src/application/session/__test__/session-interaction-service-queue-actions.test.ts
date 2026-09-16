import { describe, expect, it, vi } from "vitest";
import { AttachmentError } from "@openharness/services";

import {
  SessionApplicationError,
  SessionInteractionService,
} from "../session-interaction-service.js";
import { RunControlService } from "../run-control-service.js";

describe("SessionInteractionService queued prompt actions", () => {
  it("rejects promotion for an admitted plugin capability Input", async () => {
    const context = queueContext({ inputMetadata: { pluginId: "dev.openharness.quality" } });
    const service = new SessionInteractionService(context as any);

    await expect(
      service.promoteQueuedPrompt("session-1", "input-queued", {
        queuedRunId: "run-queued",
        expectedActiveRunId: "active-visible",
      }),
    ).rejects.toThrow("session_capability_requires_queued_run");

    expect(context.runEngine.promoteQueuedRun).not.toHaveBeenCalled();
  });

  it("rejects promotion when the active run changed", async () => {
    const context = queueContext();
    context.runEngine.activeRunId.mockReturnValue("active-new");
    const service = new SessionInteractionService(context as any);

    await expect(
      service.promoteQueuedPrompt("session-1", "input-queued", {
        queuedRunId: "run-queued",
        expectedActiveRunId: "active-visible",
      }),
    ).rejects.toBeInstanceOf(SessionApplicationError);

    expect(context.runEngine.promoteQueuedRun).not.toHaveBeenCalled();
  });

  it("keeps queued attachment prompts queued during stage two", async () => {
    const context = queueContext();
    context.store.getInput.mockReturnValue({
      id: "input-queued",
      sessionId: "session-1",
      delivery: "queue",
      content: "inspect",
      attachments: [{ assetId: "att-1" }],
      metadata: {},
    });
    const service = new SessionInteractionService(context as any);

    await expect(
      service.promoteQueuedPrompt("session-1", "input-queued", {
        queuedRunId: "run-queued",
        expectedActiveRunId: "active-visible",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AttachmentError>>({
        code: "attachment_structured_steer_unsupported",
      }),
    );
    expect(context.runEngine.promoteQueuedRun).not.toHaveBeenCalled();
  });

  it("returns the recorded promotion when the action is retried", async () => {
    const context = queueContext({
      queuedRun: {
        id: "run-queued",
        sessionId: "session-1",
        inputId: "input-queued",
        status: "interrupted",
        metadata: {
          promotion: {
            kind: "steered",
            inputId: "input-queued",
            activeRunId: "active-original",
          },
        },
      },
    });
    const service = new SessionInteractionService(context as any);

    await expect(
      service.promoteQueuedPrompt("session-1", "input-queued", {
        queuedRunId: "run-queued",
        expectedActiveRunId: "active-visible",
      }),
    ).resolves.toMatchObject({
      input: { id: "input-queued" },
      queued_run: { id: "run-queued" },
      active_run: { id: "active-original" },
    });
    expect(context.runEngine.promoteQueuedRun).not.toHaveBeenCalled();
  });

  it("cancels only the selected pending run and records the user action", async () => {
    const context = queueContext();
    context.runEngine.interruptQueuedRun.mockReturnValue({
      activeRunId: "active-visible",
      queuedRunIds: ["run-queued"],
      interrupted: true,
    });
    const service = new SessionInteractionService(context as any);

    await service.cancelQueuedPrompt("session-1", "input-queued", {
      queuedRunId: "run-queued",
    });

    expect(context.runEngine.interruptQueuedRun).toHaveBeenCalledWith(
      "session-1",
      "run-queued",
      "Queued prompt cancelled by the user",
    );
    expect(context.store.updateRun).toHaveBeenCalledWith("run-queued", {
      metadata: {
        cancellation: {
          kind: "user_cancelled_pending",
          inputId: "input-queued",
          cancelledAt: expect.any(Number),
        },
      },
    });
  });
});

function queueContext(
  options: {
    queuedRun?: Record<string, unknown>;
    inputMetadata?: Record<string, unknown>;
  } = {},
) {
  const input = {
    id: "input-queued",
    sessionId: "session-1",
    delivery: "queue",
    content: "continue",
    attachments: [],
    metadata: options.inputMetadata ?? {},
  };
  let queuedRun =
    options.queuedRun ??
    ({
      id: "run-queued",
      sessionId: "session-1",
      inputId: "input-queued",
      status: "pending",
      metadata: {},
    } as Record<string, unknown>);
  const activeRuns = new Map([
    ["active-original", { id: "active-original", sessionId: "session-1" }],
  ]);
  const updateRun = vi.fn((_id, update) => {
    queuedRun = {
      ...queuedRun,
      ...update,
      metadata: {
        ...((queuedRun.metadata as Record<string, unknown>) ?? {}),
        ...(update.metadata ?? {}),
      },
    };
    return queuedRun;
  });
  const store = {
      getSession: vi.fn(() => ({ id: "session-1", cwd: "D:/repo" })),
      getInput: vi.fn((id) => (id === input.id ? input : undefined)),
      getRun: vi.fn((id) =>
        id === "run-queued" ? queuedRun : activeRuns.get(id),
      ),
      updateRun,
      listRuns: vi.fn(() => []),
      listSessions: vi.fn(() => []),
      listMessages: vi.fn(() => []),
      listMessageParts: vi.fn(() => []),
      appendEvent: vi.fn(),
      transaction: (work: () => unknown) => work(),
    };
  const runEngine = {
      activeRunId: vi.fn(() => "active-visible"),
      promoteQueuedRun: vi.fn(),
      interruptQueuedRun: vi.fn(),
    };
  const control = new RunControlService({
    durableSessions: store as any,
    durableRuns: store as any,
    durableInputs: store as any,
    runtime: {
      activeRunId: runEngine.activeRunId,
      queuedRunIds: vi.fn(() => ["run-queued"]), hasWork: vi.fn(() => true), sessionIds: vi.fn(() => []),
      interruptSession: vi.fn(), interruptRun: vi.fn(), interruptQueuedRun: runEngine.interruptQueuedRun,
      promoteQueuedRun: runEngine.promoteQueuedRun,
      waitForRun: vi.fn(), waitForRuns: vi.fn(),
    } as any,
    events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
  });
  return {
    store,
    runEngine,
    control,
    sessions: { get: store.getSession, listChildren: vi.fn(() => []) },
    conversations: store,
    runs: store,
    admission: runEngine,
    operationRunner: { run: async (_id: string, work: () => Promise<unknown>) => work() },
    agentPool: { close: vi.fn() },
    liveChildren: { has: vi.fn(), send: vi.fn(), interrupt: vi.fn() },
    operationGate: {
      enter: vi.fn(() => ({ release: vi.fn() })),
      tryEnterBarrier: vi.fn(),
    },
    events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
  };
}
