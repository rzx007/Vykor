import { describe, expect, it, vi } from "vitest";

import type { FeishuChannelConfig } from "@openharness/auth";
import { runChannelsAddFeishu, runChannelsAllow } from "./channels-onboarding.js";

const configuredFeishu: FeishuChannelConfig = {
  enabled: true,
  appId: "cli_x",
  appSecret: "old-secret",
  domain: "feishu",
  allowFrom: {},
};

function deps() {
  let config: FeishuChannelConfig | undefined;
  const store = {
    getFeishu: vi.fn(async () => config),
    setFeishu: vi.fn(async (next: FeishuChannelConfig) => {
      config = next;
    }),
    updateFeishu: vi.fn(
      async (
        mutate: (current: FeishuChannelConfig | undefined) => FeishuChannelConfig | undefined,
      ) => {
        config = mutate(config);
        return config;
      },
    ),
  };
  return {
    store,
    get config() {
      return config;
    },
    set config(value: FeishuChannelConfig | undefined) {
      config = value;
    },
    verify: vi.fn(async () => ({ appId: "cli_x", name: "机器人" })),
    createChannels: vi.fn(async () => store),
    renderQr: vi.fn(),
  };
}

describe("runChannelsAddFeishu", () => {
  it("scan path writes the config and scanner whitelist", async () => {
    const d = deps();
    const log = vi.fn();
    const result = await runChannelsAddFeishu({
      createRegistration: (onCredentials: (c: unknown) => Promise<void>) => {
        void onCredentials({ appId: "cli_x", appSecret: "sec", userId: "ou_me", domain: "feishu" });
        return {
          start: () => ({
            state: "qr_ready",
            attempt: 1,
            domain: "feishu",
            qrUrl: "https://open.feishu.cn/x",
          }),
          status: () => ({ state: "succeeded", attempt: 1, domain: "feishu" }),
          cancel: () => undefined,
        } as never;
      },
      createChannels: () => d.store as never,
      promptSelect: async () => "scan",
      verify: d.verify as never,
      renderQr: d.renderQr,
      log,
    } as never);

    expect(d.store.setFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        appId: "cli_x",
        appSecret: "sec",
        domain: "feishu",
        allowFrom: expect.objectContaining({ ou_me: "ou_me" }),
      }),
    );
    const logs = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logs).toContain("ohs channels serve");
    expect(logs).toContain("使用长连接接收事件");
    expect(result.ok).toBe(true);
  });

  it("manual path writes the config without a scanner whitelist entry", async () => {
    const d = deps();
    const result = await runChannelsAddFeishu({
      createChannels: () => d.store as never,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_m" : ""),
      promptSecret: async () => "sec_m",
      verify: d.verify as never,
      log: vi.fn(),
    } as never);

    const saved = d.store.setFeishu.mock.calls[0]?.[0] as FeishuChannelConfig;
    expect(saved).toEqual(
      expect.objectContaining({ enabled: true, appId: "cli_m", appSecret: "sec_m", domain: "feishu" }),
    );
    expect(saved.allowFrom).toEqual({});
    expect(saved.allowFrom).not.toHaveProperty("ou_me");
    expect(result.ok).toBe(true);
  });

  it("writes nothing when overwrite is declined", async () => {
    const d = deps();
    d.config = {
      ...configuredFeishu,
      allowFrom: {},
    };
    const result = await runChannelsAddFeishu({
      createChannels: () => d.store as never,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_x" : ""),
      promptSecret: async () => "sec_m",
      promptConfirm: async () => false,
      verify: d.verify as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(false);
    expect(d.store.setFeishu).not.toHaveBeenCalled();
  });

  it("overwrites the single stored config without prompting about per-appId credentials", async () => {
    const d = deps();
    d.config = configuredFeishu;
    const promptConfirm = vi.fn(async () => true);
    const result = await runChannelsAddFeishu({
      createChannels: () => d.store as never,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_m" : ""),
      promptSecret: async () => "sec_m",
      promptConfirm,
      verify: d.verify as never,
      log: vi.fn(),
    } as never);

    expect(promptConfirm).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(d.store.setFeishu).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "cli_m", appSecret: "sec_m" }),
    );
  });

  it("does not write anything when verification fails", async () => {
    const d = deps();
    const result = await runChannelsAddFeishu({
      createChannels: () => d.store as never,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_bad" : ""),
      promptSecret: async () => "bad",
      verify: vi.fn(async () => {
        throw new Error("凭据校验失败");
      }) as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(false);
    expect(d.store.setFeishu).not.toHaveBeenCalled();
  });

  it("passes the secret through without logging it", async () => {
    const d = deps();
    const log = vi.fn();
    const secret = "sec_m_secret";
    const result = await runChannelsAddFeishu({
      createChannels: () => d.store as never,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_m" : ""),
      promptSecret: async () => secret,
      verify: d.verify as never,
      log,
    } as never);

    expect(result.ok).toBe(true);
    expect(d.store.setFeishu).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "cli_m", appSecret: secret }),
    );
    const logs = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logs).not.toContain(secret);
  });

  it("re-prompts when the region is unrecognized", async () => {
    const d = deps();
    const regionAnswers = ["moon", "lark"];
    const promptText = vi.fn(async (q: string) => {
      if (q.includes("App ID")) return "cli_m";
      return regionAnswers.shift() ?? "";
    });
    const log = vi.fn();
    const result = await runChannelsAddFeishu({
      createChannels: () => d.store as never,
      promptSelect: async () => "manual",
      promptText,
      promptSecret: async () => "sec_m",
      verify: d.verify as never,
      log,
    } as never);

    expect(result.ok).toBe(true);
    expect(promptText).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("无法识别的地区"));
    expect(d.store.setFeishu).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "lark" }),
    );
  });

  it("defaults an empty region to feishu", async () => {
    const d = deps();
    const result = await runChannelsAddFeishu({
      createChannels: () => d.store as never,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_m" : ""),
      promptSecret: async () => "sec_m",
      verify: d.verify as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(true);
    expect(d.store.setFeishu).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "feishu" }),
    );
  });
});

describe("runChannelsAllow", () => {
  it("rejects ids that are not open_id/chat_id", async () => {
    const d = deps();
    const result = await runChannelsAllow("bad_id", undefined, {
      createChannels: () => d.store as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(false);
    expect(d.store.updateFeishu).not.toHaveBeenCalled();
  });

  it("requires feishu to be configured first", async () => {
    const d = deps();
    const result = await runChannelsAllow("ou_me", undefined, {
      createChannels: () => d.store as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(false);
    expect(d.store.updateFeishu).not.toHaveBeenCalled();
  });

  it("merges the id into allowFrom keyed by name", async () => {
    const d = deps();
    d.config = configuredFeishu;
    const result = await runChannelsAllow("ou_me", "小明", {
      createChannels: () => d.store as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(true);
    expect(d.store.updateFeishu).toHaveBeenCalledOnce();
    expect(d.config?.allowFrom).toEqual({ 小明: "ou_me" });
  });

  it("returns ok:false when updateFeishu throws", async () => {
    const d = deps();
    d.config = configuredFeishu;
    d.store.updateFeishu.mockRejectedValueOnce(new Error("disk full"));
    const log = vi.fn();
    const result = await runChannelsAllow("ou_me", undefined, {
      createChannels: () => d.store as never,
      log,
    } as never);

    expect(result.ok).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("保存配置失败"));
  });
});
