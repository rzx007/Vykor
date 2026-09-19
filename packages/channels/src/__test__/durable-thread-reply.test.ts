import { describe, expect, it, vi } from "vitest";

import type { ChannelDeliveryRecord } from "@openharness/protocol";

import { MessageBus } from "../bus/queue.js";
import { DurableChannelBridge, type DurableChannelPort } from "../core/durable-bridge.js";
import { ChannelManager } from "../core/manager.js";
import { FeishuAdapter } from "../impl/feishu.js";

interface ReplyCall {
  path: { message_id: string };
  data: { content: string; msg_type: string; reply_in_thread?: boolean };
}
interface CreateCall {
  params: { receive_id_type: string };
  data: { receive_id: string; content: string; msg_type: string };
}

function makeFeishu() {
  const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
  const create = vi.fn<(call: CreateCall) => Promise<void>>(async () => {});
  const reply = vi.fn<(call: ReplyCall) => Promise<void>>(async () => {});
  (adapter as unknown as { client: unknown }).client = {
    im: { message: { create, reply } },
  };
  // manager.startAll() 会调用 connect()，这里 stub 掉真实 SDK / WS。
  (adapter as unknown as { connect: () => Promise<void> }).connect = vi.fn(
    async () => {},
  );
  return { adapter, create, reply };
}

describe("durable Feishu thread reply", () => {
  it("routes a durable delivery back into the Feishu thread via reply API", async () => {
    const bus = new MessageBus();
    const { adapter, create, reply } = makeFeishu();
    const threadId = "thread_1";
    const rootMessageId = "msg_root";

    const baseDelivery: ChannelDeliveryRecord = {
      id: "delivery-1",
      conversationId: "conv-1",
      connector: "feishu",
      accountId: "app-1",
      chatId: "chat-1",
      threadId,
      sessionId: "session-1",
      inputId: "input-1",
      runId: "run-1",
      externalMessageId: "message-1",
      content: "thread answer",
      status: "pending",
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };

    const application: DurableChannelPort = {
      handleChannelMessage: vi.fn(async (input) => ({
        conversation: {
          id: "conv-1",
          connector: "feishu",
          accountId: "app-1",
          chatId: "chat-1",
          threadId,
          sessionId: "session-1",
          createdAt: 1,
          updatedAt: 1,
        },
        delivery: { ...baseDelivery, platformMeta: input.platformMeta },
        duplicate: false,
      })),
      listPendingChannelDeliveries: vi.fn(async () => []),
      recordChannelDelivery: vi.fn(async (id, input) => ({
        ...baseDelivery,
        id,
        status: input.status,
      })),
    };

    const manager = new ChannelManager([adapter], bus, {
      allowFrom: { feishu: ["*"] },
    });
    const bridge = new DurableChannelBridge({
      application,
      bus,
      cwd: "D:/project",
      model: "model-1",
    });
    await manager.startAll();
    bridge.start();

    try {
      await (
        adapter as unknown as { _handleEvent(d: unknown): Promise<void> }
      )._handleEvent({
        sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
        message: {
          message_id: "message-1",
          chat_id: "chat-1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "question" }),
          create_time: "1710000000000",
          thread_id: threadId,
          root_id: rootMessageId,
          mentions: [],
        },
      });

      await vi.waitFor(() => {
        expect(reply).toHaveBeenCalledOnce();
      });
      const call = reply.mock.calls[0]![0] as ReplyCall;
      expect(call.path.message_id).toBe(rootMessageId);
      expect(call.data.reply_in_thread).toBe(true);
      expect(call.data.msg_type).toBe("text");
      expect(call.data.content).toBe(JSON.stringify({ text: "thread answer" }));
      expect(create).not.toHaveBeenCalled();
    } finally {
      await bridge.stop();
      await manager.stopAll();
    }
  });
});
