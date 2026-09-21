import { Readable } from "node:stream";

import { describe, it, expect, vi } from "vitest";
import { FeishuAdapter } from "../feishu.js";
import type { ChannelMessage } from "../../index.js";

interface CreateCall {
  params: { receive_id_type: string };
  data: { receive_id: string; content: string; msg_type: string };
}

interface ReplyCall {
  path: { message_id: string };
  data: { content: string; msg_type: string; reply_in_thread?: boolean };
}

/** Build a FeishuAdapter with a mocked lark client injected. */
function makeAdapter() {
  const adapter = new FeishuAdapter({ appId: "app", appSecret: "secret" });
  const create = vi.fn<(call: CreateCall) => Promise<void>>(async () => {});
  const reply = vi.fn<(call: ReplyCall) => Promise<void>>(async () => {});
  // Inject the mocked client (private field) so send() can run without a real
  // network connection.
  (adapter as unknown as { client: unknown }).client = {
    im: { message: { create, reply } },
  };
  return { adapter, create, reply };
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
    message_type?: string;
  } = {},
): Promise<void> {
  const data = {
    sender: {
      sender_id: { open_id: "ou_sender", user_id: "u1" },
      sender_type: overrides.sender_type ?? "user",
    },
    message: {
      message_id: overrides.message_id ?? `msg_${Math.random().toString(36).slice(2)}`,
      chat_id: "oc_chat_001",
      chat_type: overrides.chat_type ?? "p2p",
      message_type: overrides.message_type ?? "text",
      content: JSON.stringify({ text: overrides.content ?? "hello" }),
      create_time: String(Date.now()),
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
      supportsFiles: true,
      supportsImages: true,
    });
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
      sender: { sender_type: "user" },
      message: {
        chat_id: "oc_chat_001",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        create_time: String(Date.now()),
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
      sender: {
        sender_id: { open_id: "ou_sender" },
        sender_type: "user",
      },
      message: {
        message_id: "msg_invalid_time",
        chat_id: "oc_chat_001",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        create_time: "not-a-timestamp",
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

describe("FeishuAdapter inbound attachments (image and file)", () => {
  it("maps valid inbound image events to ChannelAttachment and messageType=image", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: ChannelMessage[] = [];
    adapter.onMessage((m) => received.push(m));

    const imageEvent = {
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: "msg_image",
        chat_id: "oc_chat_001",
        chat_type: "group",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_v2_001" }),
        create_time: "1710000000000",
        mentions: [],
      },
    };

    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent(imageEvent);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: "msg_image",
      messageType: "image",
      content: "",
      chatId: "oc_chat_001",
      attachments: [
        {
          type: "image",
          externalId: "img_v2_001",
        },
      ],
    });
  });

  it("maps valid inbound file events to ChannelAttachment with name and messageType=file", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: ChannelMessage[] = [];
    adapter.onMessage((m) => received.push(m));

    const fileEvent = {
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: "msg_file",
        chat_id: "oc_chat_001",
        chat_type: "group",
        message_type: "file",
        content: JSON.stringify({ file_key: "file_v2_001", file_name: "report.pdf" }),
        create_time: "1710000000000",
        mentions: [],
      },
    };

    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent(fileEvent);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: "msg_file",
      messageType: "file",
      content: "",
      chatId: "oc_chat_001",
      attachments: [
        {
          type: "file",
          externalId: "file_v2_001",
          name: "report.pdf",
        },
      ],
    });
  });

  it("rejects image events missing image_key", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: ChannelMessage[] = [];
    adapter.onMessage((m) => received.push(m));

    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent({
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: "msg_img_missing",
        chat_id: "oc_chat_001",
        chat_type: "group",
        message_type: "image",
        content: JSON.stringify({}),
        create_time: "1710000000000",
        mentions: [],
      },
    });

    expect(received).toHaveLength(0);
  });

  it("rejects file events missing file_key", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: ChannelMessage[] = [];
    adapter.onMessage((m) => received.push(m));

    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent({
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: "msg_file_missing",
        chat_id: "oc_chat_001",
        chat_type: "group",
        message_type: "file",
        content: JSON.stringify({ file_name: "only_name.pdf" }),
        create_time: "1710000000000",
        mentions: [],
      },
    });

    expect(received).toHaveLength(0);
  });

  it("rejects unknown message_type and malformed attachment JSON", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: ChannelMessage[] = [];
    adapter.onMessage((m) => received.push(m));

    // Unknown message_type
    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent({
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: "msg_unknown_type",
        chat_id: "oc_chat_001",
        chat_type: "group",
        message_type: "audio",
        content: JSON.stringify({ audio_key: "aud_1" }),
        create_time: "1710000000000",
        mentions: [],
      },
    });

    // Malformed JSON
    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent({
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: "msg_bad_json",
        chat_id: "oc_chat_001",
        chat_type: "group",
        message_type: "image",
        content: "not a json",
        create_time: "1710000000000",
        mentions: [],
      },
    });

    expect(received).toHaveLength(0);
  });

  it("rejects text-like content when message_type is missing instead of defaulting to text", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: ChannelMessage[] = [];
    adapter.onMessage((m) => received.push(m));

    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent({
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: "msg_no_type",
        chat_id: "oc_chat_001",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hello" }),
        create_time: "1710000000000",
        mentions: [],
      },
    });

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Inbound attachment download (im.messageResource.get)
// ---------------------------------------------------------------------------

interface MessageResourceCall {
  params: { type: string };
  path: { message_id: string; file_key: string };
}

/** Build a FeishuAdapter with a mocked client exposing messageResource.get. */
function makeDownloadAdapter(result?: {
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
  reject?: Error;
}) {
  const adapter = new FeishuAdapter({ appId: "app", appSecret: "secret" });
  const get = vi.fn(async (_call: MessageResourceCall) => {
    if (result?.reject) throw result.reject;
    return {
      writeFile: vi.fn(async () => undefined),
      getReadableStream: () =>
        Readable.from(result?.chunks ?? [new Uint8Array([1, 2, 3])]) as unknown as NodeJS.ReadableStream,
      headers: result?.headers ?? {},
    };
  });
  (adapter as unknown as { client: unknown }).client = {
    im: { message: { create: vi.fn(), reply: vi.fn() }, messageResource: { get } },
  };
  return { adapter, get };
}

describe("FeishuAdapter.downloadAttachment (inbound attachment download)", () => {
  it("destroys a download stream that arrives after cancellation", async () => {
    const { adapter, get } = makeDownloadAdapter();
    const source = new Readable({ read() {} });
    let respond!: (value: unknown) => void;
    get.mockImplementation(() => new Promise((resolve) => { respond = resolve; }) as never);
    const controller = new AbortController();
    const download = adapter.downloadAttachment({ messageId: "m", fileKey: "k", type: "file", signal: controller.signal });
    controller.abort(new Error("cancelled"));
    respond({ getReadableStream: () => source, headers: {} });
    await expect(download).rejects.toThrow("cancelled");
    expect(source.destroyed).toBe(true);
  });

  it("downloads an image via im.messageResource.get with type=image", async () => {
    const { adapter, get } = makeDownloadAdapter({
      headers: { "content-type": "image/png", "content-length": "3" },
      chunks: [new Uint8Array([9, 9])],
    });

    const result = await adapter.downloadAttachment({
      messageId: "msg_image",
      fileKey: "img_v2_001",
      type: "image",
    });

    expect(get).toHaveBeenCalledOnce();
    expect(get.mock.calls[0]![0]).toEqual({
      params: { type: "image" },
      path: { message_id: "msg_image", file_key: "img_v2_001" },
    });
    expect(result.mimeType).toBe("image/png");
    expect(result.sizeBytes).toBe(3);
    const reader = result.stream.getReader();
    const first = await reader.read();
    expect(first.value).toEqual(new Uint8Array([9, 9]));
  });

  it("downloads a file via im.messageResource.get with type=file", async () => {
    const { adapter, get } = makeDownloadAdapter();
    await adapter.downloadAttachment({ messageId: "msg_file", fileKey: "file_v2_1", type: "file" });
    expect(get.mock.calls[0]![0].params.type).toBe("file");
    expect(get).not.toHaveBeenCalledWith(expect.objectContaining({ params: { type: "image" } }));
  });

  it("does not use the bot-only im.image.get/im.file.get endpoints", async () => {
    const { adapter } = makeDownloadAdapter();
    const imageGet = vi.fn();
    const fileGet = vi.fn();
    (adapter as unknown as { client: { im: Record<string, unknown> } }).client.im["image"] = { get: imageGet };
    (adapter as unknown as { client: { im: Record<string, unknown> } }).client.im["file"] = { get: fileGet };
    await adapter.downloadAttachment({ messageId: "m", fileKey: "k", type: "image" });
    expect(imageGet).not.toHaveBeenCalled();
    expect(fileGet).not.toHaveBeenCalled();
  });

  it("throws when the client is not connected", async () => {
    const adapter = new FeishuAdapter({ appId: "app", appSecret: "secret" });
    await expect(
      adapter.downloadAttachment({ messageId: "m", fileKey: "k", type: "image" }),
    ).rejects.toThrow("Feishu client not connected");
  });

  it("propagates download failures", async () => {
    const { adapter } = makeDownloadAdapter({ reject: new Error("feishu 403") });
    await expect(
      adapter.downloadAttachment({ messageId: "m", fileKey: "k", type: "file" }),
    ).rejects.toThrow("feishu 403");
  });
});

// ---------------------------------------------------------------------------
// Task 3: Outbound image/file payload
// ---------------------------------------------------------------------------

describe("FeishuAdapter.send attachment payload (Task 3)", () => {
  it("sends image attachment using externalId as image_key with msg_type=image", async () => {
    const { adapter, create } = makeAdapter();
    await adapter.send(
      baseMessage({
        replyTo: "oc_chat_001",
        messageType: "image",
        content: "",
        attachments: [{ type: "image", externalId: "img_v2_abc" }],
      }),
    );

    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0]![0] as CreateCall;
    expect(call.params.receive_id_type).toBe("chat_id");
    expect(call.data.receive_id).toBe("oc_chat_001");
    expect(call.data.msg_type).toBe("image");
    expect(JSON.parse(call.data.content)).toEqual({ image_key: "img_v2_abc" });
  });

  it("sends file attachment using externalId as file_key with msg_type=file", async () => {
    const { adapter, create } = makeAdapter();
    await adapter.send(
      baseMessage({
        replyTo: "oc_chat_001",
        messageType: "file",
        content: "",
        attachments: [{ type: "file", externalId: "file_v2_xyz", name: "doc.pdf" }],
      }),
    );

    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0]![0] as CreateCall;
    expect(call.params.receive_id_type).toBe("chat_id");
    expect(call.data.receive_id).toBe("oc_chat_001");
    expect(call.data.msg_type).toBe("file");
    expect(JSON.parse(call.data.content)).toEqual({ file_key: "file_v2_xyz" });
  });

  it("rejects image send when attachment has no externalId (only data/url)", async () => {
    const { adapter, create } = makeAdapter();
    await expect(
      adapter.send(
        baseMessage({
          replyTo: "oc_chat_001",
          messageType: "image",
          content: "",
          attachments: [{ type: "image", url: "https://example.com/img.png" }],
        }),
      ),
    ).rejects.toThrow(/image_key/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects file send when attachment has no externalId", async () => {
    const { adapter, create } = makeAdapter();
    await expect(
      adapter.send(
        baseMessage({
          replyTo: "oc_chat_001",
          messageType: "file",
          content: "",
          attachments: [{ type: "file", data: new Uint8Array([1, 2]) }],
        }),
      ),
    ).rejects.toThrow(/file_key/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects image send when attachments array is empty", async () => {
    const { adapter, create } = makeAdapter();
    await expect(
      adapter.send(
        baseMessage({
          replyTo: "oc_chat_001",
          messageType: "image",
          content: "",
          attachments: [],
        }),
      ),
    ).rejects.toThrow(/attachment/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects image send when attachment type does not match messageType", async () => {
    const { adapter, create } = makeAdapter();
    await expect(
      adapter.send(
        baseMessage({
          replyTo: "oc_chat_001",
          messageType: "image",
          content: "",
          attachments: [{ type: "file", externalId: "file_key_123" }],
        }),
      ),
    ).rejects.toThrow(/type mismatch/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects text send that carries attachments instead of falling back", async () => {
    const { adapter, create } = makeAdapter();
    await expect(
      adapter.send(
        baseMessage({
          replyTo: "oc_chat_001",
          messageType: "text",
          content: "hello",
          attachments: [{ type: "image", externalId: "img_key_999" }],
        }),
      ),
    ).rejects.toThrow(/attachment/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not send text request when messageType is image", async () => {
    const { adapter, create } = makeAdapter();
    await adapter.send(
      baseMessage({
        replyTo: "oc_chat_001",
        messageType: "image",
        content: "ignored text",
        attachments: [{ type: "image", externalId: "img_key_999" }],
      }),
    );
    const call = create.mock.calls[0]![0] as CreateCall;
    // Must NOT fall back to text
    expect(call.data.msg_type).not.toBe("text");
    expect(call.data.msg_type).toBe("image");
  });
});

// ---------------------------------------------------------------------------
// Task 4: thread/topic routing (inbound and outbound)
// ---------------------------------------------------------------------------

describe("FeishuAdapter thread routing (Task 4)", () => {
  it("inbound: stores thread_id as threadId, root_id as platformMeta.rootMessageId — NOT mixed", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: ChannelMessage[] = [];
    adapter.onMessage((m) => received.push(m));

    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent({
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: "msg_thread_001",
        chat_id: "oc_chat_001",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: "1710000000000",
        thread_id: "thread_1",
        root_id: "msg_root",
        mentions: [],
      },
    });

    expect(received).toHaveLength(1);
    const msg = received[0]!;
    // threadId must be thread_id (NOT root_id)
    expect(msg.threadId).toBe("thread_1");
    // rootMessageId must be in platformMeta
    expect(msg.platformMeta?.rootMessageId).toBe("msg_root");
    // threadId must NOT be root_id
    expect(msg.threadId).not.toBe("msg_root");
  });

  it("outbound: sends to thread reply API when platformMeta.rootMessageId is present", async () => {
    const { adapter, create, reply } = makeAdapter();
    await adapter.send(
      baseMessage({
        replyTo: "oc_chat_001",
        chatId: "oc_chat_001",
        threadId: "thread_1",
        platformMeta: { rootMessageId: "msg_root" },
        messageType: "text",
        content: "thread reply",
      }),
    );

    expect(create).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const call = reply.mock.calls[0]![0] as ReplyCall;
    expect(call.path.message_id).toBe("msg_root");
    expect(call.data.msg_type).toBe("text");
    expect(JSON.parse(call.data.content)).toEqual({ text: "thread reply" });
    expect(call.data.reply_in_thread).toBe(true);
  });

  it("outbound: sends to regular chat API when no platformMeta.rootMessageId", async () => {
    const { adapter, create, reply } = makeAdapter();
    await adapter.send(
      baseMessage({
        replyTo: "oc_chat_001",
        messageType: "text",
        content: "normal reply",
      }),
    );

    expect(reply).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0]![0] as CreateCall;
    // Should NOT include root_id for regular messages
    expect((call.data as Record<string, unknown>).root_id).toBeUndefined();
  });

  it("outbound: rejects when threadId is set but platformMeta.rootMessageId is missing", async () => {
    const { adapter, create, reply } = makeAdapter();
    await expect(
      adapter.send(
        baseMessage({
          replyTo: "oc_chat_001",
          threadId: "thread_1",
          // No platformMeta.rootMessageId
          messageType: "text",
          content: "orphan thread",
        }),
      ),
    ).rejects.toThrow(/rootMessageId|root_id/i);
    expect(create).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 5: mention/bot boundary and capability gate
// ---------------------------------------------------------------------------

describe("FeishuAdapter mention and bot boundary (Task 5)", () => {
  it("group chat without matching @mention does not trigger handler when replyAtBotNames is set", async () => {
    const adapter = new FeishuAdapter({
      appId: "a",
      appSecret: "s",
      replyAtBotNames: ["Harness"],
    });
    const received: ChannelMessage[] = [];
    adapter.onMessage((m) => received.push(m));

    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent({
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: "msg_no_mention",
        chat_id: "oc_chat_001",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        create_time: "1710000000000",
        mentions: [], // no mention
      },
    });

    expect(received).toHaveLength(0);
  });

  it("group chat @mention is case-insensitive (harness matches Harness config)", async () => {
    const adapter = new FeishuAdapter({
      appId: "a",
      appSecret: "s",
      replyAtBotNames: ["Harness"],
    });
    const received: ChannelMessage[] = [];
    adapter.onMessage((m) => received.push(m));

    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent({
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: "msg_case_mention",
        chat_id: "oc_chat_001",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@harness hello" }),
        create_time: "1710000000000",
        mentions: [{ key: "@harness", name: "harness" }],
      },
    });

    expect(received).toHaveLength(1);
  });

  it("empty text after stripping mention key does not trigger handler", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: ChannelMessage[] = [];
    adapter.onMessage((m) => received.push(m));

    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent({
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: "msg_empty_after_strip",
        chat_id: "oc_chat_001",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@bot_key" }),
        create_time: "1710000000000",
        mentions: [{ key: "@bot_key", name: "bot" }],
      },
    });

    expect(received).toHaveLength(0);
  });

  it("strips every occurrence of the mention key, not just the first", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: ChannelMessage[] = [];
    adapter.onMessage((m) => received.push(m));

    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent({
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
      message: {
        message_id: "msg_repeat_mention",
        chat_id: "oc_chat_001",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@bot_key hi @bot_key" }),
        create_time: "1710000000000",
        mentions: [{ key: "@bot_key", name: "bot" }],
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content).toBe("hi");
  });

  it("bot sender never triggers handler even with image/file/thread fields", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: ChannelMessage[] = [];
    adapter.onMessage((m) => received.push(m));

    await (adapter as unknown as { _handleEvent(d: unknown): Promise<void> })._handleEvent({
      sender: { sender_id: { open_id: "ou_bot" }, sender_type: "bot" },
      message: {
        message_id: "msg_bot_image",
        chat_id: "oc_chat_001",
        chat_type: "group",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_key_001" }),
        create_time: "1710000000000",
        thread_id: "thread_1",
        root_id: "msg_root",
        mentions: [],
      },
    });

    expect(received).toHaveLength(0);
  });
});

describe("FeishuAdapter capability declaration (Task 5)", () => {
  it("declares image, file, threaded-conversation, mentions, bot-skip-filter after implementation", () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    expect(adapter.capabilities.supports).toContain("image");
    expect(adapter.capabilities.supports).toContain("file");
    expect(adapter.capabilities.supports).toContain("threaded-conversation");
    expect(adapter.capabilities.supports).toContain("mentions");
    expect(adapter.capabilities.supports).toContain("bot-skip-filter");
    expect(adapter.capabilities.supportsImages).toBe(true);
    expect(adapter.capabilities.supportsFiles).toBe(true);
  });
});
