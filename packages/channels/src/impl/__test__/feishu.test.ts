import { describe, it, expect, vi } from "vitest";
import { FeishuAdapter } from "../feishu.js";
import type { ChannelMessage } from "../../index.js";

interface CreateCall {
  params: { receive_id_type: string };
  data: { receive_id: string; content: string; msg_type: string };
}

/** Build a FeishuAdapter with a mocked lark client injected. */
function makeAdapter() {
  const adapter = new FeishuAdapter({ appId: "app", appSecret: "secret" });
  const create = vi.fn<(call: CreateCall) => Promise<void>>(async () => {});
  // Inject the mocked client (private field) so send() can run without a real
  // network connection.
  (adapter as unknown as { client: unknown }).client = {
    im: { message: { create } },
  };
  return { adapter, create };
}

function baseMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "feishu_123_abcd",
    channel: "feishu",
    sender: "ou_sender_open_id",
    content: "hello",
    timestamp: new Date(0),
    chatId: "ou_sender_open_id",
    ...overrides,
  };
}

describe("FeishuAdapter.send receive_id", () => {
  it("does NOT use the synthetic message id as receive_id", async () => {
    const { adapter, create } = makeAdapter();
    await adapter.send(baseMessage({ id: "feishu_999_zzzz" }));

    const call = create.mock.calls[0]![0] as CreateCall;
    expect(call.data.receive_id).not.toBe("feishu_999_zzzz");
  });

  it("uses replyTo (chat_id) with receive_id_type=chat_id for group replies", async () => {
    const { adapter, create } = makeAdapter();
    await adapter.send(
      baseMessage({ replyTo: "oc_group_chat_123", content: "reply" }),
    );

    const call = create.mock.calls[0]![0] as CreateCall;
    expect(call.params.receive_id_type).toBe("chat_id");
    expect(call.data.receive_id).toBe("oc_group_chat_123");
    expect(call.data.msg_type).toBe("text");
    expect(JSON.parse(call.data.content)).toEqual({ text: "reply" });
  });

  it("uses replyTo (open_id) with receive_id_type=open_id for direct replies", async () => {
    const { adapter, create } = makeAdapter();
    await adapter.send(baseMessage({ replyTo: "ou_user_open_id" }));

    const call = create.mock.calls[0]![0] as CreateCall;
    expect(call.params.receive_id_type).toBe("open_id");
    expect(call.data.receive_id).toBe("ou_user_open_id");
  });

  it("rejects outbound messages without an explicit reply target", async () => {
    const { adapter, create } = makeAdapter();
    await expect(
      adapter.send(baseMessage({ replyTo: undefined, chatId: undefined })),
    ).rejects.toThrow("Feishu outbound message requires replyTo or chatId");
    expect(create).not.toHaveBeenCalled();
  });

  it("throws when the client is not connected", async () => {
    const adapter = new FeishuAdapter({ appId: "app", appSecret: "secret" });
    await expect(adapter.send(baseMessage())).rejects.toThrow(
      "Feishu client not connected",
    );
  });
});

// ---------------------------------------------------------------------------
// Inbound event handling — durable idempotency handoff + bot skip
// ---------------------------------------------------------------------------

/** Simulate FeishuAdapter receiving an im.message.receive_v1 event. */
async function simulateInbound(
  adapter: FeishuAdapter,
  overrides: {
    message_id?: string;
    sender_type?: string;
    chat_type?: string;
    content?: string;
  } = {},
): Promise<void> {
  // Access the private event handler registered during connect() via the
  // internal `_testInjectEvent` helper we'll expose, OR directly call the
  // internal handler by reaching into the closure via the test helper below.
  // Since we can't call connect() (needs real Lark SDK), we expose a
  // package-private test method on the adapter.
  const data = {
    message: {
      message_id: overrides.message_id ?? `msg_${Math.random().toString(36).slice(2)}`,
      chat_id: "oc_chat_001",
      chat_type: overrides.chat_type ?? "p2p",
      content: JSON.stringify({ text: overrides.content ?? "hello" }),
      create_time: String(Date.now()),
      sender: {
        sender_id: { open_id: "ou_sender", user_id: "u1" },
        sender_type: overrides.sender_type ?? "user",
      },
      mentions: [],
    },
  };
  await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent(data);
}

describe("FeishuAdapter capability model and richer inbound semantics", () => {
  it("declares the adapter capability set", () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    expect(adapter.capabilities).toMatchObject({
      supports: expect.arrayContaining([
        "text",
        "private-chat",
        "group-chat",
        "mentions",
        "delivery-status",
        "bot-skip-filter",
      ]),
      supportsFiles: false,
      supportsImages: false,
    });
    expect(adapter.capabilities.supports).not.toContain("image");
    expect(adapter.capabilities.supports).not.toContain("file");
  });

  it("maps Feishu events into a richer unified message contract", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: Array<{ conversationId?: string; chatId?: string; threadId?: string; senderType?: string; messageType?: string }> = [];
    adapter.onMessage((m) => received.push({
      conversationId: m.conversationId,
      chatId: m.chatId,
      threadId: m.threadId,
      senderType: m.senderType,
      messageType: m.messageType,
    }));

    await simulateInbound(adapter, {
      message_id: "msg_ctx",
      chat_type: "group",
      content: "hello",
      sender_type: "user",
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      conversationId: "oc_chat_001",
      chatId: "oc_chat_001",
      threadId: undefined,
      senderType: "user",
      messageType: "text",
    });
  });

  it("delivers a normal user message", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: string[] = [];
    adapter.onMessage((m) => received.push(m.content));
    await simulateInbound(adapter, { content: "hello" });
    expect(received).toHaveLength(1);
    expect(received[0]).toBe("hello");
  });

  it("forwards duplicate message_id so the durable application can return the saved reply", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: Array<{ id: string; content: string }> = [];
    adapter.onMessage((m) => received.push({ id: m.id, content: m.content }));
    await simulateInbound(adapter, { message_id: "msg_dup", content: "first" });
    await simulateInbound(adapter, { message_id: "msg_dup", content: "first" });
    expect(received).toEqual([
      { id: "msg_dup", content: "first" },
      { id: "msg_dup", content: "first" },
    ]);
  });

  it("skips messages with sender_type=bot", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: string[] = [];
    adapter.onMessage((m) => received.push(m.content));
    await simulateInbound(adapter, { sender_type: "bot", content: "bot msg" });
    expect(received).toHaveLength(0);
  });

  it("rejects events without stable message and sender identity", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: ChannelMessage[] = [];
    adapter.onMessage((message) => received.push(message));

    await (adapter as unknown as { _handleEvent(data: unknown): Promise<void> })._handleEvent({
      message: {
        chat_id: "oc_chat_001",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        create_time: String(Date.now()),
        sender: { sender_type: "user" },
        mentions: [],
      },
    });

    expect(received).toHaveLength(0);
  });

  it("rejects events with an invalid timestamp", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: ChannelMessage[] = [];
    adapter.onMessage((message) => received.push(message));

    await simulateInbound(adapter, { content: "hello" });
    await (adapter as unknown as { _handleEvent(data: unknown): Promise<void> })._handleEvent({
      message: {
        message_id: "msg_invalid_time",
        chat_id: "oc_chat_001",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        create_time: "not-a-timestamp",
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        mentions: [],
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.id).not.toBe("msg_invalid_time");
  });

  it("allows two different message ids", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: string[] = [];
    adapter.onMessage((m) => received.push(m.content));
    await simulateInbound(adapter, { message_id: "msg_a", content: "a" });
    await simulateInbound(adapter, { message_id: "msg_b", content: "b" });
    expect(received).toHaveLength(2);
  });
});
