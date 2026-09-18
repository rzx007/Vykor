import { describe, expect, it, vi } from "vitest";

import type {
  ChannelDeliveryRecord,
  DurableChannelMessageResult,
} from "@openharness/protocol";

import { MessageBus } from "../bus/queue.js";
import { DurableChannelBridge, type DurableChannelPort } from "../core/durable-bridge.js";

function delivery(
  patch: Partial<ChannelDeliveryRecord> = {},
): ChannelDeliveryRecord {
  return {
    id: "delivery-1",
    conversationId: "conversation-1",
    connector: "feishu",
    accountId: "app-1",
    chatId: "chat-1",
    sessionId: "session-1",
    inputId: "input-1",
    runId: "run-1",
    externalMessageId: "message-1",
    content: "reply",
    status: "pending",
    attemptCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function port(overrides: Partial<DurableChannelPort> = {}): DurableChannelPort {
  return {
    handleChannelMessage: vi.fn(async (): Promise<DurableChannelMessageResult> => ({
      conversation: {
        id: "conversation-1",
        connector: "feishu",
        accountId: "app-1",
        chatId: "chat-1",
        sessionId: "session-1",
        createdAt: 1,
        updatedAt: 1,
      },
      delivery: delivery(),
      duplicate: false,
    })),
    listPendingChannelDeliveries: vi.fn(async () => []),
    recordChannelDelivery: vi.fn(async (id, input) =>
      delivery({ id, status: input.status }),
    ),
    ...overrides,
  };
}

describe("DurableChannelBridge", () => {
  it("把平台 message id 和账号交给 durable application，再发布已保存回复", async () => {
    const bus = new MessageBus();
    const application = port();
    const bridge = new DurableChannelBridge({
      application,
      bus,
      cwd: "D:/project",
      model: "model-1",
    });
    bridge.start();
    bus.publishInbound({
      channel: "feishu",
      accountId: "app-1",
      externalMessageId: "message-1",
      senderId: "user-1",
      chatId: "chat-1",
      content: "question",
      timestamp: new Date(0),
      media: [],
      metadata: {},
    });

    const outbound = await bus.consumeOutbound();
    expect(application.handleChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        connector: "feishu",
        accountId: "app-1",
        externalMessageId: "message-1",
        chatId: "chat-1",
        content: "question",
      }),
    );
    expect(outbound).toMatchObject({
      channel: "feishu",
      chatId: "chat-1",
      content: "reply",
      metadata: { _delivery_id: "delivery-1", _run_id: "run-1" },
    });
    await bridge.stop();
  });

  it("启动时只补发 daemon 返回的未确认回复，不重新执行 Agent", async () => {
    const bus = new MessageBus();
    const application = port({
      listPendingChannelDeliveries: vi.fn(async () => [
        delivery({ id: "delivery-recovered", content: "saved reply" }),
      ]),
    });
    const bridge = new DurableChannelBridge({
      application,
      bus,
      cwd: "D:/project",
      model: "model-1",
      connectors: ["feishu"],
    });
    bridge.start();

    await expect(bus.consumeOutbound()).resolves.toMatchObject({
      content: "saved reply",
      metadata: { _delivery_id: "delivery-recovered" },
    });
    expect(application.handleChannelMessage).not.toHaveBeenCalled();
    await bridge.stop();
  });

  it("结果为 unknown 时不自动重发，避免平台已经收到却发出第二条", async () => {
    const bus = new MessageBus();
    const application = port({
      handleChannelMessage: vi.fn(async () => ({
        conversation: {
          id: "conversation-1",
          connector: "feishu",
          accountId: "app-1",
          chatId: "chat-1",
          sessionId: "session-1",
          createdAt: 1,
          updatedAt: 1,
        },
        delivery: delivery({ status: "unknown" }),
        duplicate: true,
      })),
    });
    const bridge = new DurableChannelBridge({
      application,
      bus,
      cwd: "D:/project",
      model: "model-1",
    });
    bridge.start();
    bus.publishInbound({
      channel: "feishu",
      accountId: "app-1",
      externalMessageId: "message-1",
      senderId: "user-1",
      chatId: "chat-1",
      content: "question",
      timestamp: new Date(0),
      media: [],
      metadata: {},
    });

    await vi.waitFor(() => {
      expect(application.handleChannelMessage).toHaveBeenCalledOnce();
    });
    expect(bus.outboundSize).toBe(0);
    await bridge.stop();
  });

  it("preserves inbound attachments into durable application message metadata", async () => {
    const bus = new MessageBus();
    const application = port();
    const bridge = new DurableChannelBridge({
      application,
      bus,
      cwd: "D:/project",
      model: "model-1",
    });
    bridge.start();

    const attachment = {
      type: "image" as const,
      mimeType: "image/png",
      name: "test.png",
      externalId: "img-123",
      metadata: { width: 100 },
    };

    bus.publishInbound({
      channel: "feishu",
      accountId: "app-1",
      externalMessageId: "message-1",
      senderId: "user-1",
      chatId: "chat-1",
      content: "question with image",
      timestamp: new Date(0),
      media: [],
      metadata: { initial: true },
      attachments: [attachment],
    });

    await vi.waitFor(() => {
      expect(application.handleChannelMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            initial: true,
            attachments: [attachment],
          }),
        }),
      );
    });
    await bridge.stop();
  });

  it("preserves the Feishu thread identifier and root message metadata into durable input", async () => {
    const bus = new MessageBus();
    const application = port();
    const bridge = new DurableChannelBridge({
      application,
      bus,
      cwd: "D:/project",
      model: "model-1",
    });
    bridge.start();

    bus.publishInbound({
      channel: "feishu",
      accountId: "app-1",
      externalMessageId: "message-1",
      senderId: "user-1",
      chatId: "chat-1",
      threadId: "thread_1",
      content: "thread question",
      timestamp: new Date(0),
      media: [],
      metadata: { rootMessageId: "msg_root" },
    });

    await vi.waitFor(() => {
      expect(application.handleChannelMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread_1",
          metadata: expect.objectContaining({ rootMessageId: "msg_root" }),
        }),
      );
    });
    await bridge.stop();
  });

  it("forwards the delivery threadId to outbound so thread replies do not degrade to chat", async () => {
    const bus = new MessageBus();
    const application = port({
      listPendingChannelDeliveries: vi.fn(async () => [
        delivery({ id: "delivery-thread", content: "thread reply", threadId: "thread_1" }),
      ]),
    });
    const bridge = new DurableChannelBridge({
      application,
      bus,
      cwd: "D:/project",
      model: "model-1",
      connectors: ["feishu"],
    });
    bridge.start();

    await expect(bus.consumeOutbound()).resolves.toMatchObject({
      content: "thread reply",
      threadId: "thread_1",
      metadata: { _delivery_id: "delivery-thread" },
    });
    await bridge.stop();
  });
});
