import { describe, it, expect } from "vitest";
import { EventBus } from "../bus/index.js";
import { FeishuAdapter } from "../impl/feishu.js";
import type { ChannelAdapterCapabilities, ChannelMessage } from "../index.js";

describe("ChannelMessage contract", () => {
  it("carries conversation and platform context", () => {
    const message: ChannelMessage = {
      id: "message-1",
      channel: "feishu",
      sender: "ou-user",
      content: "hello",
      timestamp: new Date(0),
      conversationId: "conversation-1",
      chatId: "oc-chat-1",
      replyTo: "oc-chat-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      senderType: "user",
      messageType: "text",
      metadata: { source: "test" },
      platformMeta: { chatType: "group" },
    };

    expect(message).toMatchObject({
      conversationId: "conversation-1",
      chatId: "oc-chat-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      messageType: "text",
    });
  });

  it("declares capabilities explicitly", () => {
    const capabilities: ChannelAdapterCapabilities = {
      supports: ["text", "group-chat", "private-chat", "delivery-status"],
      supportsFiles: false,
      supportsImages: false,
    };

    expect(capabilities.supports).toEqual([
      "text",
      "group-chat",
      "private-chat",
      "delivery-status",
    ]);
    expect(capabilities.supportsFiles).toBe(false);
    expect(capabilities.supportsImages).toBe(false);
  });
});

describe("FeishuAdapter capability release gate", () => {
  it("declares only the media and thread capabilities that are implemented", () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    expect(adapter.capabilities.supports).toEqual(
      expect.arrayContaining([
        "text",
        "image",
        "file",
        "mentions",
        "threaded-conversation",
        "bot-skip-filter",
      ]),
    );
    expect(adapter.capabilities.supportsImages).toBe(true);
    expect(adapter.capabilities.supportsFiles).toBe(true);
    expect(adapter.capabilities.supports).not.toContain("stream");
    expect(adapter.capabilities.supports).not.toContain("rich-card");
    expect(adapter.capabilities.supports).not.toContain("acknowledgement");
  });
});

describe("EventBus", () => {
  it("emits events to registered handlers", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.on("test", (data) => received.push(data));
    bus.emit("test", "hello");
    expect(received).toEqual(["hello"]);
  });

  it("supports multiple handlers for same event", () => {
    const bus = new EventBus();
    let count = 0;
    bus.on("evt", () => count++);
    bus.on("evt", () => count++);
    bus.emit("evt", null);
    expect(count).toBe(2);
  });

  it("unsubscribe removes handler", () => {
    const bus = new EventBus();
    let called = false;
    const unsub = bus.on("evt", () => { called = true; });
    unsub();
    bus.emit("evt", null);
    expect(called).toBe(false);
  });

  it("does not call handlers for different events", () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on("a", () => received.push("a"));
    bus.on("b", () => received.push("b"));
    bus.emit("a", null);
    expect(received).toEqual(["a"]);
  });

  it("removeAll with event removes only that event", () => {
    const bus = new EventBus();
    let a = false, b = false;
    bus.on("a", () => { a = true; });
    bus.on("b", () => { b = true; });
    bus.removeAll("a");
    bus.emit("a", null);
    bus.emit("b", null);
    expect(a).toBe(false);
    expect(b).toBe(true);
  });

  it("removeAll without arg removes all", () => {
    const bus = new EventBus();
    let a = false, b = false;
    bus.on("a", () => { a = true; });
    bus.on("b", () => { b = true; });
    bus.removeAll();
    bus.emit("a", null);
    bus.emit("b", null);
    expect(a).toBe(false);
    expect(b).toBe(false);
  });

  it("emit with no handlers is no-op", () => {
    const bus = new EventBus();
    expect(() => bus.emit("nope", null)).not.toThrow();
  });
});
