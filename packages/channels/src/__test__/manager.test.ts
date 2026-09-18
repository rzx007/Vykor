import { describe, it, expect } from "vitest";
import { MessageBus } from "../bus/queue.js";
import { ChannelManager } from "../core/manager.js";
import type { ChannelAdapter, ChannelAdapterCapabilities, ChannelAttachment, ChannelMessage } from "../index.js";

/** 可注入收发的假 adapter。 */
function makeAdapter(
  name: string,
  opts: {
    failConnect?: boolean;
    failSend?: boolean;
    capabilities?: ChannelAdapterCapabilities;
  } = {},
) {
  let handler: ((m: ChannelMessage) => void) | undefined;
  const sent: ChannelMessage[] = [];
  const adapter: ChannelAdapter = {
    name,
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    async connect() {
      if (opts.failConnect) throw new Error(`${name} boom`);
    },
    async disconnect() {},
    async send(m) {
      sent.push(m);
      if (opts.failSend) throw new Error(`${name} send boom`);
    },
    onMessage(h) {
      handler = h;
    },
  };
  return {
    adapter,
    sent,
    emit(m: Partial<ChannelMessage>) {
      handler?.({
        id: "m1",
        channel: name,
        sender: "u1",
        content: "hi",
        timestamp: new Date(0),
        ...m,
      });
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ChannelManager", () => {
  it("入站经 ACL 进 bus(允许的 sender)", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["u1"] },
    });
    await mgr.startAll();
    fake.emit({ sender: "u1", content: "hello", chatId: "chat9" });
    const msg = await bus.consumeInbound();
    expect(msg.channel).toBe("t");
    expect(msg.accountId).toBe("default");
    expect(msg.externalMessageId).toBe("m1");
    expect(msg.senderId).toBe("u1");
    expect(msg.chatId).toBe("chat9");
    expect(msg.content).toBe("hello");
    await mgr.stopAll();
  });

  it("preserves conversation context and uses a system sender for outbound messages", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
    });
    await mgr.startAll();

    fake.emit({
      sender: "u1",
      chatId: "chat9",
      conversationId: "conversation9",
      workspaceId: "workspace9",
      threadId: "thread9",
      metadata: { source: "test" },
    });
    const inbound = await bus.consumeInbound();
    expect(inbound).toMatchObject({
      conversationId: "conversation9",
      workspaceId: "workspace9",
      threadId: "thread9",
      metadata: {
        _message_id: "m1",
        conversationId: "conversation9",
        source: "test",
      },
    });

    bus.publishOutbound({ channel: "t", chatId: "chat9", content: "reply" });
    await tick();
    expect(fake.sent[0]).toMatchObject({
      sender: "system",
      senderType: "system",
      chatId: "chat9",
      replyTo: "chat9",
    });
    await mgr.stopAll();
  });

  it("rejects inbound messages without an explicit chatId", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["u1"] },
    });
    await mgr.startAll();
    fake.emit({ sender: "u1", replyTo: "legacy-chat" });
    await tick();
    expect(bus.inboundSize).toBe(0);
    await mgr.stopAll();
  });

  it("ACL 拒绝:不在 allowFrom 或列表为空都不进 bus", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: [] },
    });
    await mgr.startAll();
    fake.emit({ sender: "u1" });
    fake.emit({ sender: "stranger" });
    await tick();
    expect(bus.inboundSize).toBe(0);
    await mgr.stopAll();
  });

  it("出站按 channel 路由到对应 adapter", async () => {
    const bus = new MessageBus();
    const a = makeAdapter("a");
    const b = makeAdapter("b");
    const mgr = new ChannelManager([a.adapter, b.adapter], bus, {
      allowFrom: { a: ["*"], b: ["*"] },
    });
    await mgr.startAll();
    bus.publishOutbound({ channel: "b", chatId: "c2", content: "reply" });
    await tick();
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0]!.content).toBe("reply");
    expect(b.sent[0]!.replyTo).toBe("c2"); // chatId 映射回 replyTo
    await mgr.stopAll();
  });

  it("发送 durable 回复前记 unknown，成功后再记 sent", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const results: Array<{ deliveryId: string; status: string }> = [];
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
      onDeliveryResult: async (result) => {
        results.push(result);
      },
    });
    await mgr.startAll();
    bus.publishOutbound({
      channel: "t",
      chatId: "c2",
      content: "reply",
      metadata: { _delivery_id: "delivery-1" },
    });
    await tick();
    await tick();
    expect(results).toEqual([
      { deliveryId: "delivery-1", status: "unknown" },
      { deliveryId: "delivery-1", status: "sent" },
    ]);
    await mgr.stopAll();
  });

  it("平台明确发送失败时记 failed，回复内容仍留在 durable delivery", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t", { failSend: true });
    const results: Array<{ deliveryId: string; status: string; error?: string }> = [];
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
      onDeliveryResult: async (result) => {
        results.push(result);
      },
    });
    await mgr.startAll();
    bus.publishOutbound({
      channel: "t",
      chatId: "c2",
      content: "saved reply",
      metadata: { _delivery_id: "delivery-2" },
    });
    await tick();
    await tick();
    expect(results).toEqual([
      { deliveryId: "delivery-2", status: "unknown" },
      {
        deliveryId: "delivery-2",
        status: "failed",
        error: "t send boom",
      },
    ]);
    expect(fake.sent[0]?.content).toBe("saved reply");
    await mgr.stopAll();
  });

  it("单 adapter connect 失败不拖垮整体,状态带 lastError", async () => {
    const bus = new MessageBus();
    const ok = makeAdapter("ok");
    const bad = makeAdapter("bad", { failConnect: true });
    const mgr = new ChannelManager([ok.adapter, bad.adapter], bus, {
      allowFrom: { ok: ["*"], bad: ["*"] },
    });
    await mgr.startAll();
    const status = mgr.getStatus();
    expect(status.ok!.running).toBe(true);
    expect(status.bad!.running).toBe(false);
    expect(status.bad!.lastError).toMatch(/boom/);
    await mgr.stopAll();
  });

  it("progress 元数据门控:sendProgress=false 时丢弃 _progress 消息", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
      sendProgress: false,
    });
    await mgr.startAll();
    bus.publishOutbound({
      channel: "t",
      chatId: "c",
      content: "thinking…",
      metadata: { _progress: true },
    });
    bus.publishOutbound({ channel: "t", chatId: "c", content: "real" });
    await tick();
    expect(fake.sent.map((m) => m.content)).toEqual(["real"]);
    await mgr.stopAll();
  });

  it("tool_hint 门控独立于 progress 门控(四象限)", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    // sendToolHints=false 但 sendProgress 默认 true:
    // 丢 hint 类 progress,放普通 progress。
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
      sendToolHints: false,
    });
    await mgr.startAll();
    bus.publishOutbound({
      channel: "t",
      chatId: "c",
      content: "using Bash…",
      metadata: { _progress: true, _tool_hint: true },
    });
    bus.publishOutbound({
      channel: "t",
      chatId: "c",
      content: "thinking…",
      metadata: { _progress: true },
    });
    await tick();
    expect(fake.sent.map((m) => m.content)).toEqual(["thinking…"]);
    await mgr.stopAll();
  });

  it("startAll 重入保护:二次调用不另起分发循环", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, { allowFrom: { t: ["*"] } });
    await mgr.startAll();
    await mgr.startAll(); // 不应泄漏旧循环
    bus.publishOutbound({ channel: "t", chatId: "c", content: "once" });
    await tick();
    expect(fake.sent).toHaveLength(1);
    await mgr.stopAll();
  });

  it("空 allowFrom 在启动时给告警", async () => {
    const warnings: string[] = [];
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: {},
      onWarning: (w) => warnings.push(w),
    });
    await mgr.startAll();
    expect(warnings.some((w) => w.includes("allowFrom"))).toBe(true);
    await mgr.stopAll();
  });

  it("preserves inbound attachments through manager and durable metadata", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
    });
    await mgr.startAll();

    const attachment: ChannelAttachment = {
      type: "image",
      mimeType: "image/png",
      name: "diagram.png",
      externalId: "img_v2_001",
      metadata: { width: 640, height: 480 },
    };

    fake.emit({ chatId: "chat-1", attachments: [attachment], messageType: "image" });
    const inbound = await bus.consumeInbound();

    expect(inbound.attachments).toEqual([attachment]);
    expect(inbound.messageType).toBe("image");
    expect(inbound.metadata.attachments).toEqual([attachment]);
    await mgr.stopAll();
  });

  it("dispatches outbound attachments and routing context to adapter", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("feishu");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { feishu: ["*"] },
    });
    await mgr.startAll();

    const attachment: ChannelAttachment = {
      type: "image",
      externalId: "img_v2_001",
    };

    bus.publishOutbound({
      channel: "feishu",
      chatId: "chat-1",
      content: "",
      messageType: "image",
      attachments: [attachment],
      threadId: "thread-1",
      platformMeta: { rootMessageId: "root-1" },
    });
    await tick();

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      messageType: "image",
      attachments: [attachment],
      chatId: "chat-1",
      threadId: "thread-1",
      platformMeta: { rootMessageId: "root-1" },
    });
    await mgr.stopAll();
  });

  it("capability gate: 声明只支持 text 的 adapter 收到 image 时拒绝并回写 failed", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t", {
      capabilities: {
        supports: ["text"],
        supportsImages: false,
        supportsFiles: false,
      },
    });
    const warnings: string[] = [];
    const results: Array<{ deliveryId: string; status: string; error?: string }> = [];
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
      onWarning: (w) => warnings.push(w),
      onDeliveryResult: (r) => {
        results.push(r);
      },
    });
    await mgr.startAll();

    bus.publishOutbound({
      channel: "t",
      chatId: "c1",
      content: "",
      messageType: "image",
      attachments: [{ type: "image", externalId: "img-1" }],
      metadata: { _delivery_id: "del-img" },
    });
    await tick();
    await tick();

    expect(fake.sent).toHaveLength(0);
    expect(results).toContainEqual(
      expect.objectContaining({
        deliveryId: "del-img",
        status: "failed",
        error: expect.stringMatching(/image/i),
      }),
    );
    expect(warnings.some((w) => w.includes("t") && w.includes("image"))).toBe(true);
    await mgr.stopAll();
  });

  it("capability gate: 声明未包含 threaded-conversation 的 adapter 收到带 threadId 的消息时拒绝", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t", {
      capabilities: {
        supports: ["text"],
      },
    });
    const warnings: string[] = [];
    const results: Array<{ deliveryId: string; status: string; error?: string }> = [];
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
      onWarning: (w) => warnings.push(w),
      onDeliveryResult: (r) => {
        results.push(r);
      },
    });
    await mgr.startAll();

    bus.publishOutbound({
      channel: "t",
      chatId: "c1",
      content: "in thread",
      messageType: "text",
      threadId: "th-1",
      metadata: { _delivery_id: "del-thread" },
    });
    await tick();
    await tick();

    expect(fake.sent).toHaveLength(0);
    expect(results).toContainEqual(
      expect.objectContaining({
        deliveryId: "del-thread",
        status: "failed",
        error: expect.stringMatching(/threaded-conversation/i),
      }),
    );
    expect(warnings.some((w) => w.includes("threaded-conversation"))).toBe(true);
    await mgr.stopAll();
  });

  it("capability gate: 只有 platformMeta.rootMessageId（没有 threadId）也要走 threaded-conversation 校验", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t", {
      capabilities: {
        supports: ["text"],
      },
    });
    const warnings: string[] = [];
    const results: Array<{ deliveryId: string; status: string; error?: string }> = [];
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
      onWarning: (w) => warnings.push(w),
      onDeliveryResult: (r) => {
        results.push(r);
      },
    });
    await mgr.startAll();

    bus.publishOutbound({
      channel: "t",
      chatId: "c1",
      content: "root only",
      messageType: "text",
      platformMeta: { rootMessageId: "msg_root" },
      metadata: { _delivery_id: "del-root" },
    });
    await tick();
    await tick();

    expect(fake.sent).toHaveLength(0);
    expect(results).toContainEqual(
      expect.objectContaining({
        deliveryId: "del-root",
        status: "failed",
        error: expect.stringMatching(/threaded-conversation/i),
      }),
    );
    expect(warnings.some((w) => w.includes("threaded-conversation"))).toBe(true);
    await mgr.stopAll();
  });

  it("preserves platformMeta.rootMessageId into inbound metadata", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
    });
    await mgr.startAll();

    fake.emit({
      chatId: "chat-1",
      threadId: "thread-1",
      platformMeta: { rootMessageId: "msg_root" },
    });
    const inbound = await bus.consumeInbound();

    expect(inbound.threadId).toBe("thread-1");
    expect(inbound.metadata.rootMessageId).toBe("msg_root");
    await mgr.stopAll();
  });

  it("preserves platformMeta on the inbound message", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
    });
    await mgr.startAll();

    fake.emit({
      chatId: "chat-1",
      platformMeta: { rootMessageId: "msg_root", chatType: "group" },
    });
    const inbound = await bus.consumeInbound();

    expect(inbound.platformMeta).toEqual({
      rootMessageId: "msg_root",
      chatType: "group",
    });
    await mgr.stopAll();
  });
});
