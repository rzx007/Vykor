import { describe, expect, it, vi } from "vitest";

import {
  SessionApplicationError,
  SessionInteractionService,
} from "../session-interaction-service.js";

describe("SessionInteractionService editLatestPrompt", () => {
  it("revalidates the selected source message after entering the session operation", async () => {
    let messages = [userMessage("message-1", 1)];
    const context = editContext({
      enter: () => {
        messages = [userMessage("message-2", 2)];
        return { release: vi.fn() };
      },
      listMessages: () => messages,
    });
    const service = new SessionInteractionService(context as any);

    await expect(
      service.editLatestPrompt("session-1", {
        id: "edit-1",
        content: "replacement",
        sourceMessageId: "message-1",
        traceId: "trace-edit",
      }),
    ).rejects.toBeInstanceOf(SessionApplicationError);

    expect(context.agentPool.close).not.toHaveBeenCalled();
    expect(
      context.runEngine.replaceLatestPrompt,
    ).not.toHaveBeenCalled();
  });

  it("does not mutate the transcript when closing the old agent fails", async () => {
    const context = editContext({
      close: vi.fn(async () => {
        throw new Error("close failed");
      }),
    });
    const service = new SessionInteractionService(context as any);

    await expect(
      service.editLatestPrompt("session-1", {
        id: "edit-1",
        content: "replacement",
        sourceMessageId: "message-1",
        traceId: "trace-edit",
      }),
    ).rejects.toThrow("close failed");

    expect(
      context.runEngine.replaceLatestPrompt,
    ).not.toHaveBeenCalled();
  });

  it("closes the old agent before atomically replacing and admitting", async () => {
    const context = editContext();
    const service = new SessionInteractionService(context as any);

    await service.editLatestPrompt("session-1", {
      id: "edit-1",
      content: "replacement",
      attachments: [{ assetId: "asset-new", intent: "ocr" }],
      sourceMessageId: "message-1",
      traceId: "trace-edit",
      metadata: { origin: { component: "latest-message-editor" } },
    });

    expect(context.agentPool.close).toHaveBeenCalledWith("session-1");
    expect(
      context.runEngine.replaceLatestPrompt,
    ).toHaveBeenCalledWith("session-1", "message-1", {
      id: "edit-1",
      items: [{ type: "text", text: "replacement" }],
      attachments: [{ assetId: "asset-new", intent: "ocr" }],
      traceId: "trace-edit",
      metadata: {
        origin: { component: "latest-message-editor" },
        edit: { kind: "latest_prompt", sourceMessageId: "message-1" },
      },
    });
    expect(context.agentPool.close.mock.invocationCallOrder[0]).toBeLessThan(
      context.runEngine.replaceLatestPrompt.mock
        .invocationCallOrder[0]!,
    );
  });

  it("returns the first edit result when the same edit request is retried", async () => {
    const existingInput = {
      id: "edit-1",
      sessionId: "session-1",
      content: "replacement",
      delivery: "queue",
      attachments: [{
        assetId: "asset-new",
        intent: "ocr",
        metadata: {},
      }],
      metadata: {
        edit: { kind: "latest_prompt", sourceMessageId: "message-1" },
      },
    };
    const context = editContext({
      getInput: vi.fn(() => existingInput),
      hasWork: vi.fn(() => true),
    });
    context.store.findRunByInput.mockReturnValue({
      id: "replacement-run",
      status: "running",
    });
    const service = new SessionInteractionService(context as any);

    const result = await service.editLatestPrompt("session-1", {
      id: "edit-1",
      content: "replacement",
      attachments: [{ assetId: "asset-new", intent: "ocr" }],
      sourceMessageId: "message-1",
      traceId: "trace-retry",
    });

    expect(result).toMatchObject({
      input: existingInput,
      run: { id: "replacement-run" },
      queue_state: "running",
    });
    expect(context.agentPool.close).not.toHaveBeenCalled();
    expect(
      context.runEngine.replaceLatestPrompt,
    ).not.toHaveBeenCalled();
  });

  it("rejects reusing an edit id for different content", async () => {
    const context = editContext({
      getInput: vi.fn(() => ({
        id: "edit-1",
        sessionId: "session-1",
        content: "first replacement",
        delivery: "queue",
        metadata: {
          edit: { kind: "latest_prompt", sourceMessageId: "message-1" },
        },
      })),
    });
    const service = new SessionInteractionService(context as any);

    await expect(
      service.editLatestPrompt("session-1", {
        id: "edit-1",
        content: "different replacement",
        sourceMessageId: "message-1",
        traceId: "trace-collision",
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(context.agentPool.close).not.toHaveBeenCalled();
  });

  it("rejects reusing an edit id with attachments in a different order", async () => {
    const context = editContext({
      getInput: vi.fn(() => ({
        id: "edit-1",
        sessionId: "session-1",
        content: "replacement",
        delivery: "queue",
        attachments: [
          { assetId: "asset-a", intent: "vision", metadata: {} },
          { assetId: "asset-b", intent: "ocr", metadata: {} },
        ],
        metadata: {
          edit: { kind: "latest_prompt", sourceMessageId: "message-1" },
        },
      })),
    });
    const service = new SessionInteractionService(context as any);

    await expect(service.editLatestPrompt("session-1", {
      id: "edit-1",
      content: "replacement",
      attachments: [
        { assetId: "asset-b", intent: "ocr" },
        { assetId: "asset-a", intent: "vision" },
      ],
      sourceMessageId: "message-1",
      traceId: "trace-collision",
    })).rejects.toMatchObject({ status: 409 });

    expect(context.agentPool.close).not.toHaveBeenCalled();
  });
});

function editContext(
  overrides: {
    enter?: () => { release: ReturnType<typeof vi.fn> };
    listMessages?: () => ReturnType<typeof userMessage>[];
    close?: ReturnType<typeof vi.fn>;
    getInput?: ReturnType<typeof vi.fn>;
    hasWork?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const replaceLatestPrompt = vi.fn(() => ({
    input: { id: "replacement-input" },
    run: { id: "replacement-run" },
    queue_state: "running" as const,
  }));
  const store = {
    getSession: vi.fn(() => ({ id: "session-1", cwd: "D:/repo" })),
    getInput: overrides.getInput ?? vi.fn(() => undefined),
    findRunByInput: vi.fn(() => undefined),
    listMessages: vi.fn(
      overrides.listMessages ?? (() => [userMessage("message-1", 1)]),
    ),
    listMessageParts: vi.fn(() => []),
  };
  const runEngine = {
    hasWork: overrides.hasWork ?? vi.fn(() => false),
    replaceLatestPrompt,
  };
  const operationGate = {
    enter: vi.fn(overrides.enter ?? (() => ({ release: vi.fn() }))),
  };
  const events = { checkpoint: vi.fn(() => 1), publishSince: vi.fn() };
  return {
    store,
    runEngine,
    sessions: { get: store.getSession, listChildren: vi.fn(() => []) },
    conversations: store,
    runs: store,
    admission: runEngine,
    control: runEngine,
    operationRunner: {
      run: async (_sessionId: string, work: () => Promise<unknown>) => {
        const lease = operationGate.enter();
        try {
          const checkpoint = events.checkpoint();
          const result = await work();
          events.publishSince(checkpoint);
          return result;
        } finally {
          lease.release();
        }
      },
    },
    agentPool: {
      close: overrides.close ?? vi.fn(async () => undefined),
    },
    liveChildren: {
      has: vi.fn(() => false),
      send: vi.fn(),
      interrupt: vi.fn(),
    },
    operationGate,
    events,
  };
}

function userMessage(id: string, seq: number) {
  return {
    id,
    sessionId: "session-1",
    seq,
    role: "user" as const,
    metadata: {},
    createdAt: seq,
    updatedAt: seq,
  };
}
