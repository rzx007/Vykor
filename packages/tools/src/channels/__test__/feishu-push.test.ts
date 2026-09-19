import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getFeishu = vi.hoisted(() => vi.fn());

vi.mock("@openharness/auth", () => ({
  ChannelConfigStore: class {
    getFeishu = getFeishu;
  },
}));

import { feishuApiBase, feishuPushTool, getTenantToken } from "../feishu-push.js";

import type { ToolContext } from "@openharness/core";

const context: ToolContext = {
  cwd: process.cwd(),
  abortSignal: new AbortController().signal,
};

function jsonResponse(body: unknown) {
  return { json: async () => body };
}

describe("feishu-push api base", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the Lark API base for the lark domain", () => {
    expect(feishuApiBase("lark")).toBe("https://open.larksuite.com");
  });

  it("defaults to the Feishu API base", () => {
    expect(feishuApiBase("feishu")).toBe("https://open.feishu.cn");
    expect(feishuApiBase(undefined)).toBe("https://open.feishu.cn");
  });

  it("sends the tenant token request to the passed base", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      json: async () => ({ tenant_access_token: "t-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const token = await getTenantToken(
      "cli_x",
      "sec",
      new AbortController().signal,
      feishuApiBase("lark"),
    );

    expect(token).toBe("t-1");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    );
  });
});

describe("FeishuPush tool", () => {
  beforeEach(() => {
    getFeishu.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an isError result with setup guidance when no channel is configured", async () => {
    getFeishu.mockResolvedValue(undefined);

    const result = await feishuPushTool.execute({ target: "个人", message: "hi" }, context);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("ohs channels add feishu");
  });

  it("surfaces a corrupt channel store as a tool error instead of throwing", async () => {
    getFeishu.mockRejectedValue(new Error("Channel config file is invalid (json)"));

    const result = await feishuPushTool.execute({ target: "个人", message: "hi" }, context);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("invalid");
  });

  it("uses the Lark API base when the configured domain is lark", async () => {
    getFeishu.mockResolvedValue({
      enabled: true,
      appId: "cli_x",
      appSecret: "sec",
      domain: "lark",
      allowFrom: { 个人: "ou_1" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ tenant_access_token: "t-1" }))
      .mockResolvedValueOnce(jsonResponse({ code: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await feishuPushTool.execute({ target: "个人", message: "hi" }, context);

    expect(result.isError).toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toContain("open.larksuite.com");
    expect(fetchMock.mock.calls[1]![0]).toContain("open.larksuite.com");
  });

  it("sends the message to the chat id mapped to the target", async () => {
    getFeishu.mockResolvedValue({
      enabled: true,
      appId: "cli_x",
      appSecret: "sec",
      domain: "feishu",
      allowFrom: { 工作群: "oc_42" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ tenant_access_token: "t-2" }))
      .mockResolvedValueOnce(jsonResponse({ code: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await feishuPushTool.execute({ target: "工作群", message: "hello" }, context);

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("工作群");
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    );
    const body = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(body).toEqual({
      receive_id: "oc_42",
      msg_type: "text",
      content: JSON.stringify({ text: "hello" }),
    });
  });

  it("treats a disabled channel as not configured", async () => {
    getFeishu.mockResolvedValue({
      enabled: false,
      appId: "cli_x",
      appSecret: "sec",
      domain: "feishu",
      allowFrom: { 个人: "ou_1" },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await feishuPushTool.execute({ target: "个人", message: "hi" }, context);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("ohs channels add feishu");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not treat prototype names as configured targets", async () => {
    getFeishu.mockResolvedValue({
      enabled: true,
      appId: "cli_x",
      appSecret: "sec",
      domain: "feishu",
      allowFrom: {},
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await feishuPushTool.execute({ target: "toString", message: "hi" }, context);

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
