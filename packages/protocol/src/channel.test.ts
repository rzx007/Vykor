import { describe, expect, it } from "vitest";

import { parseDurableChannelMessageInput } from "./channel.js";

const base = {
  connector: "feishu",
  accountId: "app-1",
  chatId: "chat-1",
  externalMessageId: "msg-1",
  senderId: "ou-1",
  content: "hello",
  cwd: "/repo",
  model: "model-1",
};

describe("parseDurableChannelMessageInput platformMeta", () => {
  it("keeps a non-empty plain object platformMeta", () => {
    const parsed = parseDurableChannelMessageInput({
      ...base,
      platformMeta: { rootMessageId: "msg_root", chatType: "group" },
    });
    expect(parsed.platformMeta).toEqual({
      rootMessageId: "msg_root",
      chatType: "group",
    });
  });

  it("omits platformMeta when absent or empty", () => {
    expect(parseDurableChannelMessageInput({ ...base })).not.toHaveProperty(
      "platformMeta",
    );
    expect(
      parseDurableChannelMessageInput({ ...base, platformMeta: {} }),
    ).not.toHaveProperty("platformMeta");
  });

  it.each([
    ["array", []],
    ["string", "root"],
    ["number", 1],
    ["boolean", true],
    ["null", null],
  ])("rejects %s platformMeta", (_label, value) => {
    expect(() =>
      parseDurableChannelMessageInput({ ...base, platformMeta: value }),
    ).toThrow(/ must be /);
  });
});
