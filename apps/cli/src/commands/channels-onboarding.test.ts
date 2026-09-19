import { describe, expect, it, vi } from "vitest";

import {
  runChannelsAddFeishu,
  runChannelsAllow,
  type ChannelsClientLike,
} from "./channels-onboarding.js";

function fakeClient(overrides: Partial<Record<string, unknown>> = {}) {
  const channels = {
    startFeishuRegistration: vi.fn(async () => ({
      state: "qr_ready",
      attempt: 1,
      domain: "feishu",
      qrUrl: "https://open.feishu.cn/x",
    })),
    feishuRegistrationStatus: vi.fn(async () => ({
      state: "succeeded",
      attempt: 1,
      domain: "feishu",
    })),
    cancelFeishuRegistration: vi.fn(async () => ({
      state: "cancelled",
      attempt: 1,
      domain: "feishu",
    })),
    getFeishu: vi.fn(async () => ({
      configured: false,
      enabled: false,
      allowFrom: [],
    })),
    connectFeishu: vi.fn(async (input: { appId: string }) => ({
      feishu: { configured: true, enabled: true, appId: input.appId, allowFrom: [] },
    })),
    addFeishuAllow: vi.fn(async () => ({
      configured: true,
      enabled: true,
      allowFrom: [],
    })),
    ...overrides,
  };
  return { channels } as unknown as ChannelsClientLike;
}

describe("runChannelsAddFeishu", () => {
  it("scan path delegates to the daemon and reports the appId", async () => {
    const client = fakeClient({
      getFeishu: vi.fn(async () => ({
        configured: true,
        enabled: true,
        appId: "cli_scanned",
        allowFrom: [{ name: "ou_me", id: "ou_me" }],
      })),
    });
    const log = vi.fn();
    const result = await runChannelsAddFeishu({
      createClient: async () => client,
      promptSelect: async () => "scan",
      renderQr: vi.fn(),
      log,
    } as never);

    expect(result).toMatchObject({ ok: true, appId: "cli_scanned", domain: "feishu" });
    expect(client.channels.startFeishuRegistration).toHaveBeenCalledWith({ domain: "feishu" });
    const logs = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logs).toContain("ohs channels serve");
    expect(logs).toContain("使用长连接接收事件");
  });

  it("scan path surfaces a missing-open-id warning", async () => {
    const client = fakeClient({
      feishuRegistrationStatus: vi.fn(async () => ({
        state: "succeeded",
        attempt: 1,
        domain: "feishu",
        warning: "未获取到扫码者 open_id，白名单为空，所有消息都会被拒绝",
      })),
      getFeishu: vi.fn(async () => ({
        configured: true,
        enabled: true,
        appId: "cli_scanned",
        allowFrom: [],
      })),
    });
    const log = vi.fn();
    await runChannelsAddFeishu({
      createClient: async () => client,
      promptSelect: async () => "scan",
      renderQr: vi.fn(),
      log,
    } as never);
    const logs = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logs).toContain("白名单为空");
  });

  it("reports a lost registration when the daemon forgets an active scan", async () => {
    const client = fakeClient({
      feishuRegistrationStatus: vi.fn(async () => ({
        state: "idle",
        attempt: 1,
        domain: "feishu",
      })),
    });
    const log = vi.fn();
    const result = await runChannelsAddFeishu({
      createClient: async () => client,
      promptSelect: async () => "scan",
      renderQr: vi.fn(),
      log,
    } as never);
    expect(result.ok).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("注册状态已丢失"));
  });

  it("manual path connects through the daemon", async () => {
    const client = fakeClient();
    const result = await runChannelsAddFeishu({
      createClient: async () => client,
      promptSelect: async () => "manual",
      promptText: async (question: string) => (question.includes("App ID") ? "cli_m" : ""),
      promptSecret: async () => "sec_m",
      log: vi.fn(),
    } as never);

    expect(result).toMatchObject({ ok: true, appId: "cli_m", domain: "feishu" });
    expect(client.channels.connectFeishu).toHaveBeenCalledWith({
      appId: "cli_m",
      appSecret: "sec_m",
      domain: "feishu",
    });
  });

  it("does not connect and never logs the secret when verification fails", async () => {
    const secret = "sec_m_secret";
    const client = fakeClient({
      connectFeishu: vi.fn(async () => {
        throw new Error("飞书凭据校验失败");
      }),
    });
    const log = vi.fn();
    const result = await runChannelsAddFeishu({
      createClient: async () => client,
      promptSelect: async () => "manual",
      promptText: async (question: string) => (question.includes("App ID") ? "cli_m" : ""),
      promptSecret: async () => secret,
      log,
    } as never);

    expect(result.ok).toBe(false);
    const logs = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logs).toContain("凭据校验失败");
    expect(logs).not.toContain(secret);
  });

  it("re-prompts on an unrecognized region and defaults to feishu", async () => {
    const client = fakeClient();
    const regionAnswers = ["moon", "lark"];
    const promptText = vi.fn(async (question: string) => {
      if (question.includes("App ID")) return "cli_m";
      return regionAnswers.shift() ?? "";
    });
    const log = vi.fn();
    const result = await runChannelsAddFeishu({
      createClient: async () => client,
      promptSelect: async () => "manual",
      promptText,
      promptSecret: async () => "sec_m",
      log,
    } as never);

    expect(result.ok).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("无法识别的地区"));
    expect(client.channels.connectFeishu).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "lark" }),
    );
  });

  it("asks before overwriting an existing configuration", async () => {
    const client = fakeClient({
      getFeishu: vi.fn(async () => ({
        configured: true,
        enabled: true,
        appId: "cli_old",
        allowFrom: [],
      })),
    });
    const result = await runChannelsAddFeishu({
      createClient: async () => client,
      promptSelect: async () => "manual",
      promptText: async (question: string) => (question.includes("App ID") ? "cli_new" : ""),
      promptSecret: async () => "sec",
      promptConfirm: async () => false,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(false);
    expect(client.channels.connectFeishu).not.toHaveBeenCalled();
  });
});

describe("runChannelsAllow", () => {
  it("rejects ids that are not open_id/chat_id", async () => {
    const client = fakeClient();
    const result = await runChannelsAllow("bad_id", undefined, {
      createClient: async () => client,
      log: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(client.channels.addFeishuAllow).not.toHaveBeenCalled();
  });

  it("requires the channel to be configured first", async () => {
    const client = fakeClient();
    const result = await runChannelsAllow("ou_me", undefined, {
      createClient: async () => client,
      log: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(client.channels.addFeishuAllow).not.toHaveBeenCalled();
  });

  it("adds the id through the daemon with the display name", async () => {
    const client = fakeClient({
      getFeishu: vi.fn(async () => ({
        configured: true,
        enabled: true,
        appId: "cli_x",
        allowFrom: [],
      })),
    });
    const result = await runChannelsAllow("ou_me", "小明", {
      createClient: async () => client,
      log: vi.fn(),
    });
    expect(result.ok).toBe(true);
    expect(client.channels.addFeishuAllow).toHaveBeenCalledWith({ id: "ou_me", name: "小明" });
  });
});
