import { describe, it, expect } from "vitest";
import { MessageBus, type InboundMessage } from "./queue.js";
import { isAllowed } from "./acl.js";

function inbound(content: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: "test",
    senderId: "u1",
    chatId: "c1",
    content,
    timestamp: new Date(0),
    media: [],
    metadata: {},
    ...overrides,
  };
}

describe("MessageBus", () => {
  it("FIFO: 先生产后消费按序出队", async () => {
    const bus = new MessageBus();
    bus.publishInbound(inbound("a"));
    bus.publishInbound(inbound("b"));
    expect(bus.inboundSize).toBe(2);
    expect((await bus.consumeInbound()).content).toBe("a");
    expect((await bus.consumeInbound()).content).toBe("b");
    expect(bus.inboundSize).toBe(0);
  });

  it("消费者先到则挂起，生产后被唤醒", async () => {
    const bus = new MessageBus();
    const pending = bus.consumeInbound();
    bus.publishInbound(inbound("late"));
    expect((await pending).content).toBe("late");
  });

  it("多个挂起消费者按到达顺序配对", async () => {
    const bus = new MessageBus();
    const p1 = bus.consumeInbound();
    const p2 = bus.consumeInbound();
    bus.publishInbound(inbound("x"));
    bus.publishInbound(inbound("y"));
    expect((await p1).content).toBe("x");
    expect((await p2).content).toBe("y");
  });

  it("入站队列满时等待空位而不是丢弃消息", async () => {
    const bus = new MessageBus();
    for (let index = 0; index < 1_000; index += 1) {
      bus.publishInbound(inbound(String(index)));
    }

    let published = false;
    const pending = Promise.resolve(bus.publishInbound(inbound("overflow"))).then(() => {
      published = true;
    });
    await Promise.resolve();
    expect(published).toBe(false);

    await bus.consumeInbound();
    await pending;
    expect(bus.inboundSize).toBe(1_000);
    expect(bus.inboundDropped).toBe(0);
  });

  it("取消等待中的出站发布后不会在稍后重新入队", async () => {
    const bus = new MessageBus();
    for (let index = 0; index < 1_000; index += 1) {
      bus.publishOutbound({ channel: "test", chatId: "c1", content: String(index) });
    }
    const controller = new AbortController();
    const pending = bus.publishOutbound(
      { channel: "test", chatId: "c1", content: "cancelled" },
      controller.signal,
    );

    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    await bus.consumeOutbound();
    expect(bus.outboundSize).toBe(999);
  });

  it("AbortSignal 取消挂起的消费", async () => {
    const bus = new MessageBus();
    const ac = new AbortController();
    const pending = bus.consumeInbound(ac.signal);
    ac.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("已 abort 的 signal 立即拒绝", async () => {
    const bus = new MessageBus();
    const ac = new AbortController();
    ac.abort();
    await expect(bus.consumeInbound(ac.signal)).rejects.toThrow(/abort/i);
  });

  it("outbound 队列独立于 inbound", async () => {
    const bus = new MessageBus();
    bus.publishOutbound({ channel: "test", chatId: "c1", content: "reply" });
    expect(bus.outboundSize).toBe(1);
    expect(bus.inboundSize).toBe(0);
    expect((await bus.consumeOutbound()).content).toBe("reply");
  });

  it("sessionKey 派生:override 优先,否则 channel:chatId", () => {
    const bus = new MessageBus();
    void bus;
    const a = inbound("a");
    const b = inbound("b", { sessionKeyOverride: "thread-9" });
    expect(MessageBus.sessionKey(a)).toBe("test:c1");
    expect(MessageBus.sessionKey(b)).toBe("thread-9");
  });

  it("inbound 与 outbound 队列均完整保留 attachments 与 messageType", async () => {
    const bus = new MessageBus();
    const attachment = {
      type: "image" as const,
      mimeType: "image/png",
      name: "diagram.png",
      externalId: "img_v2_001",
      metadata: { width: 640, height: 480 },
    };
    bus.publishInbound(
      inbound("", {
        attachments: [attachment],
        messageType: "image",
      }),
    );
    const inMsg = await bus.consumeInbound();
    expect(inMsg.attachments).toEqual([attachment]);
    expect(inMsg.messageType).toBe("image");

    bus.publishOutbound({
      channel: "test",
      chatId: "c1",
      content: "",
      messageType: "image",
      attachments: [attachment],
      threadId: "t1",
      platformMeta: { rootMessageId: "r1" },
    });
    const outMsg = await bus.consumeOutbound();
    expect(outMsg.attachments).toEqual([attachment]);
    expect(outMsg.messageType).toBe("image");
    expect(outMsg.threadId).toBe("t1");
    expect(outMsg.platformMeta).toEqual({ rootMessageId: "r1" });
  });
});

describe("isAllowed (ACL, 对齐 Python BaseChannel.is_allowed)", () => {
  it("匹配发送者", () => {
    expect(isAllowed({ sender: "ou_1" }, ["ou_1"])).toBe(true);
    expect(isAllowed({ sender: "ou_2" }, ["ou_1"])).toBe(false);
  });

  it("匹配会话（群）", () => {
    expect(isAllowed({ sender: "ou_1", chatId: "oc_g" }, ["oc_g"])).toBe(true);
    expect(isAllowed({ sender: "ou_1", chatId: "oc_other" }, ["oc_g"])).toBe(false);
  });

  it("空名单全拒（fail-closed）", () => {
    expect(isAllowed({ sender: "ou_1" }, [])).toBe(false);
    expect(isAllowed({ sender: "ou_1", chatId: "oc_g" }, undefined)).toBe(false);
  });

  it('"*" 全放', () => {
    expect(isAllowed({ sender: "anyone", chatId: "oc_g" }, ["*"])).toBe(true);
  });

  it("发送者支持复合 id 分段", () => {
    expect(isAllowed({ sender: "open|union" }, ["union"])).toBe(true);
  });
});
