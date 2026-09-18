import { describe, expect, it, vi } from "vitest";
import type { DurableChannelMessageInput, ExternalConversationRecord, ChannelDeliveryRecord } from "@openharness/protocol";
import { ChannelApplicationService } from "../channel-application-service.js";
import { ApplicationError } from "../../../shared/application-error.js";

describe("ChannelApplicationService contracts", () => {
  function createFixture() {
    const existingInputs = new Map<string, any>();
    const existingSessions = new Map<string, any>([
      ["s1", { id: "s1", status: "idle", cwd: "/repo" }],
    ]);
    const conversation: ExternalConversationRecord = {
      id: "conv-1",
      connector: "slack",
      accountId: "acc-1",
      chatId: "chat-1",
      sessionId: "s1",
      createdAt: 1,
      updatedAt: 1,
    };
    const delivery: ChannelDeliveryRecord = {
      id: "del-1",
      conversationId: "conv-1",
      connector: "slack",
      accountId: "acc-1",
      chatId: "chat-1",
      sessionId: "s1",
      inputId: "inp-1",
      status: "pending",
      content: "reply",
      createdAt: 1,
      updatedAt: 1,
    };

    const channels = {
      findConversation: vi.fn(() => conversation),
      upsertConversation: vi.fn(() => conversation),
      createDelivery: vi.fn(() => delivery),
      getDelivery: vi.fn((id: string) => (id === "del-1" ? { ...delivery } : undefined)),
      updateDelivery: vi.fn((id: string, patch: any) => ({ ...delivery, ...patch })),
      listConversations: vi.fn(() => [conversation]),
      listDeliveries: vi.fn(() => [delivery]),
    };

    const sessions = {
      admitPrompt: vi.fn(async () => ({
        input: { id: "inp-1", sessionId: "s1" },
        run: { id: "run-1", sessionId: "s1", status: "pending" },
      })),
      awaitRun: vi.fn(async () => ({
        status: "completed" as const,
        output: "Hello from agent",
      })),
      createSession: vi.fn(() => ({ id: "s1" })),
    };

    const sessionQueries = {
      getInput: vi.fn((id: string) => existingInputs.get(id)),
      getSession: vi.fn((id: string) => existingSessions.get(id)),
    };

    const log = vi.fn();

    return {
      sessionQueries,
      channels,
      sessions,
      log,
      existingInputs,
      existingSessions,
      conversation,
      delivery,
    };
  }

  function createService(fixture: ReturnType<typeof createFixture>) {
    return new ChannelApplicationService({
      sessionQueries: fixture.sessionQueries,
      channels: fixture.channels as any,
      sessionCommands: fixture.sessions as any,
      sessionInteractions: fixture.sessions as any,
      runControl: fixture.sessions as any,
      log: fixture.log,
    });
  }

  it("handles new channel message and marks duplicate false", async () => {
    const fixture = createFixture();
    const service = createService(fixture);

    const input: DurableChannelMessageInput = {
      connector: "slack",
      accountId: "acc-1",
      chatId: "chat-1",
      externalMessageId: "msg-1",
      content: "Hello",
      cwd: "/repo",
    };

    const result = await service.handleMessage(input);
    expect(result.duplicate).toBe(false);
    expect(result.conversation.id).toBe("conv-1");
    expect(result.delivery.id).toBe("del-1");
    expect(fixture.sessions.admitPrompt).toHaveBeenCalledOnce();
    expect(fixture.sessions.awaitRun).toHaveBeenCalledWith("s1", "run-1");
    expect(fixture.channels.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Hello from agent",
      }),
    );
  });

  it("detects duplicate delivery when input existed before", async () => {
    const fixture = createFixture();
    const service = createService(fixture);

    const input: DurableChannelMessageInput = {
      connector: "slack",
      accountId: "acc-1",
      chatId: "chat-1",
      externalMessageId: "msg-dup",
      content: "Duplicate message",
      cwd: "/repo",
    };

    // Simulate input already in store
    fixture.sessionQueries.getInput.mockReturnValueOnce({ id: "inp-dup" });

    const result = await service.handleMessage(input);
    expect(result.duplicate).toBe(true);
  });

  it("maps prompt id already used error to 409 ApplicationError", async () => {
    const fixture = createFixture();
    fixture.sessions.admitPrompt.mockRejectedValueOnce(
      new Error("Prompt id is already used: existing-id"),
    );
    const service = createService(fixture);

    const input: DurableChannelMessageInput = {
      connector: "slack",
      accountId: "acc-1",
      chatId: "chat-1",
      externalMessageId: "msg-conflict",
      content: "Conflict",
      cwd: "/repo",
    };

    const promise = service.handleMessage(input);
    await expect(promise).rejects.toThrow(ApplicationError);
    await expect(promise).rejects.toMatchObject({
      status: 409,
    });
  });

  it("records delivery and respects idempotency if already sent", () => {
    const fixture = createFixture();
    const service = createService(fixture);

    // Already sent
    fixture.channels.getDelivery.mockReturnValueOnce({
      ...fixture.delivery,
      status: "sent",
    });

    const result = service.recordDelivery("del-1", { status: "sent" });
    expect(result.status).toBe("sent");
    expect(fixture.channels.updateDelivery).not.toHaveBeenCalled();

    // Not found
    fixture.channels.getDelivery.mockReturnValueOnce(undefined);
    expect(() => service.recordDelivery("del-unknown", { status: "sent" })).toThrow(
      ApplicationError,
    );
  });

  it("returns status and pendingDeliveries", () => {
    const fixture = createFixture();
    const service = createService(fixture);

    const status = service.status();
    expect(status.conversations).toHaveLength(1);
    expect(status.deliveries).toHaveLength(1);

    const pending = service.pendingDeliveries();
    expect(pending).toHaveLength(1);
    expect(fixture.channels.listDeliveries).toHaveBeenCalledWith({
      statuses: ["pending", "failed"],
    });
  });

  it("forwards input.platformMeta into the channel delivery", async () => {
    const fixture = createFixture();
    const service = createService(fixture);

    const input: DurableChannelMessageInput = {
      connector: "slack",
      accountId: "acc-1",
      chatId: "chat-1",
      externalMessageId: "msg-meta",
      content: "Hello",
      cwd: "/repo",
      platformMeta: { rootMessageId: "msg_root" },
    };

    await service.handleMessage(input);

    expect(fixture.channels.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        platformMeta: { rootMessageId: "msg_root" },
      }),
    );
  });

  it("returns platformMeta on pending deliveries", () => {
    const fixture = createFixture();
    const service = createService(fixture);
    const withMeta: ChannelDeliveryRecord = {
      ...fixture.delivery,
      platformMeta: { rootMessageId: "msg_root" },
    };
    fixture.channels.listDeliveries.mockReturnValueOnce([withMeta]);

    const pending = service.pendingDeliveries();
    expect(pending).toEqual([withMeta]);
    expect(pending[0]?.platformMeta).toEqual({ rootMessageId: "msg_root" });
    expect(fixture.channels.listDeliveries).toHaveBeenCalledWith({
      statuses: ["pending", "failed"],
    });
  });

  it("classifies conversations by thread: a different thread creates a different session", async () => {
    const fixture = createFixture();
    fixture.channels.findConversation.mockReturnValue(undefined);
    let created = 0;
    fixture.sessions.createSession.mockImplementation(() => ({ id: `s-${++created}` }));
    fixture.channels.upsertConversation.mockImplementation((input: any) => ({
      ...fixture.conversation,
      id: `conv-${created}`,
      ...input,
    }));
    const service = createService(fixture);

    await service.handleMessage({
      connector: "feishu",
      accountId: "app-1",
      chatId: "chat-1",
      threadId: "thread-1",
      externalMessageId: "msg-1",
      content: "one",
      cwd: "/repo",
      model: "m",
    });
    await service.handleMessage({
      connector: "feishu",
      accountId: "app-1",
      chatId: "chat-1",
      threadId: "thread-2",
      externalMessageId: "msg-2",
      content: "two",
      cwd: "/repo",
      model: "m",
    });

    // 同一 group、同一机器人、仅 thread 不同 → 各建一个 Session。
    expect(fixture.sessions.createSession).toHaveBeenCalledTimes(2);
    expect(fixture.channels.findConversation).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", threadId: "thread-1" }),
    );
    expect(fixture.channels.findConversation).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", threadId: "thread-2" }),
    );
    expect(fixture.channels.upsertConversation).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", threadId: "thread-1" }),
    );
    expect(fixture.channels.upsertConversation).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", threadId: "thread-2" }),
    );
  });

  it("reuses the mapped session for the same conversation key", async () => {
    const fixture = createFixture();
    const service = createService(fixture);

    await service.handleMessage({
      connector: "slack",
      accountId: "acc-1",
      chatId: "chat-1",
      externalMessageId: "msg-reuse",
      content: "hello",
      cwd: "/repo",
      model: "m",
    });

    expect(fixture.channels.findConversation).toHaveBeenCalledOnce();
    expect(fixture.sessions.createSession).not.toHaveBeenCalled();
    expect(fixture.channels.upsertConversation).not.toHaveBeenCalled();
  });

  it("creates a new session when the mapped session is archived, reusing the conversation id", async () => {
    const fixture = createFixture();
    fixture.existingSessions.set("s1", { id: "s1", status: "archived", cwd: "/repo" });
    fixture.sessions.createSession.mockReturnValue({ id: "s2" });
    fixture.channels.upsertConversation.mockReturnValue({
      ...fixture.conversation,
      sessionId: "s2",
    });
    const service = createService(fixture);

    await service.handleMessage({
      connector: "slack",
      accountId: "acc-1",
      chatId: "chat-1",
      externalMessageId: "msg-archived",
      content: "hello",
      cwd: "/repo",
      model: "m",
    });

    expect(fixture.sessions.createSession).toHaveBeenCalledOnce();
    expect(fixture.channels.upsertConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: fixture.conversation.id, sessionId: "s2" }),
    );
  });
});
