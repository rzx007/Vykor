import { describe, expect, it, vi } from "vitest";

import { runChannelsAddFeishu, runChannelsAllow } from "./channels-onboarding.js";

function deps() {
  const secrets = new Map<string, string>();
  return {
    secrets,
    verify: vi.fn(async () => ({ appId: "cli_x", name: "机器人" })),
    credentials: {
      get: vi.fn(async (id: string) => secrets.get(id)),
      set: vi.fn(async (id: string, secret: string) => {
        secrets.set(id, secret);
      }),
      delete: vi.fn(async (id: string) => secrets.delete(id)),
    },
    loadSettings: vi.fn(async () => ({ model: "m" })),
    saveSettings: vi.fn(async () => undefined),
    renderQr: vi.fn(),
  };
}

describe("runChannelsAddFeishu", () => {
  it("scan path writes credentials, config, and scanner whitelist", async () => {
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
      createCredentials: () => d.credentials as never,
      promptSelect: async () => "scan",
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      verify: d.verify as never,
      renderQr: d.renderQr,
      log,
    } as never);

    expect(d.credentials.set).toHaveBeenCalledWith("cli_x", "sec");
    expect(d.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.objectContaining({
          feishu: expect.objectContaining({
            enabled: true,
            appId: "cli_x",
            domain: "feishu",
            allowFrom: expect.objectContaining({ ou_me: "ou_me" }),
          }),
        }),
      }),
    );
    const logs = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logs).toContain("ohs channels serve");
    expect(logs).toContain("使用长连接接收事件");
    expect(result.ok).toBe(true);
  });

  it("manual path writes config without a scanner whitelist entry", async () => {
    const d = deps();
    const result = await runChannelsAddFeishu({
      createCredentials: () => d.credentials as any,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_m" : ""),
      promptSecret: async () => "sec_m",
      loadSettings: d.loadSettings as any,
      saveSettings: d.saveSettings as any,
      verify: d.verify as any,
      log: vi.fn(),
    } as never);

    expect(d.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: { feishu: expect.objectContaining({ enabled: true, appId: "cli_m" }) },
      }),
    );
    const saved = d.saveSettings.mock.calls[0]?.[0] as {
      channels?: { feishu?: { allowFrom?: Record<string, string> } };
    };
    expect(saved.channels?.feishu?.allowFrom).toEqual({});
    expect(saved.channels?.feishu?.allowFrom).not.toHaveProperty("ou_me");
    expect(result.ok).toBe(true);
  });

  it("writes nothing when overwrite is declined", async () => {
    const d = deps();
    d.secrets.set("cli_x", "old-secret");
    d.loadSettings.mockResolvedValueOnce({
      model: "m",
      channels: { feishu: { enabled: true, appId: "cli_x", allowFrom: {} } },
    } as never);
    const result = await runChannelsAddFeishu({
      createCredentials: () => d.credentials as never,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_x" : ""),
      promptSecret: async () => "sec_m",
      promptConfirm: async () => false,
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      verify: d.verify as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(false);
    expect(d.credentials.set).not.toHaveBeenCalled();
    expect(d.saveSettings).not.toHaveBeenCalled();
  });

  it("does not prompt when a different existing appId has a credential but the new appId has none", async () => {
    const d = deps();
    d.secrets.set("cli_x", "old-secret");
    d.loadSettings.mockResolvedValueOnce({
      model: "m",
      channels: { feishu: { enabled: true, appId: "cli_x", allowFrom: {} } },
    } as never);
    const promptConfirm = vi.fn(async () => false);
    const result = await runChannelsAddFeishu({
      createCredentials: () => d.credentials as never,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_m" : ""),
      promptSecret: async () => "sec_m",
      promptConfirm,
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      verify: d.verify as never,
      log: vi.fn(),
    } as never);

    expect(promptConfirm).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(d.credentials.set).toHaveBeenCalledWith("cli_m", "sec_m");
    expect(d.saveSettings).toHaveBeenCalled();
  });

  it("restores the previous secret when saveSettings fails", async () => {
    const d = deps();
    d.secrets.set("cli_x", "old-secret");
    d.saveSettings.mockRejectedValueOnce(new Error("disk full"));
    const result = await runChannelsAddFeishu({
      createCredentials: () => d.credentials as never,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_x" : ""),
      promptSecret: async () => "new-secret",
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      verify: d.verify as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(false);
    expect(d.credentials.set).toHaveBeenCalledWith("cli_x", "new-secret");
    expect(d.credentials.set).toHaveBeenCalledWith("cli_x", "old-secret");
    expect(d.credentials.delete).not.toHaveBeenCalled();
  });

  it("removes the new credential when saveSettings fails and none existed", async () => {
    const d = deps();
    d.saveSettings.mockRejectedValueOnce(new Error("disk full"));
    const result = await runChannelsAddFeishu({
      createCredentials: () => d.credentials as never,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_x" : ""),
      promptSecret: async () => "new-secret",
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      verify: d.verify as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(false);
    expect(d.credentials.delete).toHaveBeenCalledWith("cli_x");
  });

  it("does not write anything when verification fails", async () => {
    const d = deps();
    const result = await runChannelsAddFeishu({
      createCredentials: () => d.credentials as any,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_bad" : ""),
      promptSecret: async () => "bad",
      loadSettings: d.loadSettings as any,
      saveSettings: d.saveSettings as any,
      verify: vi.fn(async () => {
        throw new Error("凭据校验失败");
      }) as any,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(false);
    expect(d.credentials.set).not.toHaveBeenCalled();
    expect(d.saveSettings).not.toHaveBeenCalled();
  });

  it("passes the secret through without logging it", async () => {
    const d = deps();
    const log = vi.fn();
    const secret = "sec_m_secret";
    const result = await runChannelsAddFeishu({
      createCredentials: () => d.credentials as never,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_m" : ""),
      promptSecret: async () => secret,
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      verify: d.verify as never,
      log,
    } as never);

    expect(result.ok).toBe(true);
    expect(d.credentials.set).toHaveBeenCalledWith("cli_m", secret);
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
      createCredentials: () => d.credentials as never,
      promptSelect: async () => "manual",
      promptText,
      promptSecret: async () => "sec_m",
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      verify: d.verify as never,
      log,
    } as never);

    expect(result.ok).toBe(true);
    expect(promptText).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("无法识别的地区"));
    expect(d.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.objectContaining({
          feishu: expect.objectContaining({ domain: "lark" }),
        }),
      }),
    );
  });

  it("defaults an empty region to feishu", async () => {
    const d = deps();
    const result = await runChannelsAddFeishu({
      createCredentials: () => d.credentials as never,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_m" : ""),
      promptSecret: async () => "sec_m",
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      verify: d.verify as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(true);
    expect(d.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.objectContaining({
          feishu: expect.objectContaining({ domain: "feishu" }),
        }),
      }),
    );
  });
});

describe("runChannelsAllow", () => {
  it("rejects ids that are not open_id/chat_id", async () => {
    const d = deps();
    const result = await runChannelsAllow("bad_id", undefined, {
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(false);
    expect(d.saveSettings).not.toHaveBeenCalled();
  });

  it("requires feishu to be configured first", async () => {
    const d = deps();
    const result = await runChannelsAllow("ou_me", undefined, {
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(false);
    expect(d.saveSettings).not.toHaveBeenCalled();
  });

  it("merges the id into allowFrom keyed by name", async () => {
    const d = deps();
    d.loadSettings.mockResolvedValueOnce({
      model: "m",
      channels: { feishu: { enabled: true, appId: "cli_x", domain: "feishu", allowFrom: {} } },
    } as never);
    const result = await runChannelsAllow("ou_me", "小明", {
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(true);
    expect(d.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.objectContaining({
          feishu: expect.objectContaining({ allowFrom: { 小明: "ou_me" } }),
        }),
      }),
    );
  });

  it("returns ok:false when saveSettings throws", async () => {
    const d = deps();
    d.loadSettings.mockResolvedValueOnce({
      model: "m",
      channels: { feishu: { enabled: true, appId: "cli_x", domain: "feishu", allowFrom: {} } },
    } as never);
    d.saveSettings.mockRejectedValueOnce(new Error("disk full"));
    const log = vi.fn();
    const result = await runChannelsAllow("ou_me", undefined, {
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      log,
    } as never);

    expect(result.ok).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("保存配置失败"));
  });
});
