import { afterEach, describe, it, expect, vi } from "vitest";

const channelMocks = vi.hoisted(() => ({
  health: vi.fn(),
  getStatus: vi.fn(),
  readDaemonRegistry: vi.fn(),
}));

const configured = vi.hoisted(() => ({ feishu: undefined as unknown }));

vi.mock("@openharness/core", () => ({}));
vi.mock("@openharness/server", () => ({ readDaemonRegistry: channelMocks.readDaemonRegistry }));
vi.mock("@openharness/client", () => ({
  OpenHarnessClient: class {
    protocol = { health: channelMocks.health };
    channels = { getStatus: channelMocks.getStatus };
  },
}));
vi.mock("@openharness/auth", () => ({
  ChannelConfigStore: class {
    async getFeishu() {
      return configured.feishu;
    }
    async setFeishu() {}
    async updateFeishu() {
      return configured.feishu;
    }
    async deleteFeishu() {
      return false;
    }
  },
}));
import { assembleChannelAdapters, createChannelsCommand } from "./channels.js";

const baseFeishu = {
  enabled: true,
  appId: "cli_x",
  appSecret: "sec",
  domain: "feishu" as const,
  allowFrom: { 个人: "ou_1" } as Record<string, string>,
};

describe("assembleChannelAdapters", () => {
  afterEach(() => {
    configured.feishu = undefined;
  });

  it("无配置 → 空组装", async () => {
    const r = await assembleChannelAdapters();
    expect(r.adapters).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.policies).toEqual({});
  });

  it("feishu disabled → 不组装", async () => {
    configured.feishu = { ...baseFeishu, enabled: false };
    const r = await assembleChannelAdapters();
    expect(r.adapters).toEqual([]);
  });

  it("feishu enabled → 组装 adapter, allowFrom/accountIds/policies 一并组装", async () => {
    configured.feishu = { ...baseFeishu, sendProgress: false, sendToolHints: true };
    const r = await assembleChannelAdapters();
    expect(r.adapters).toHaveLength(1);
    expect(r.adapters[0]!.name).toBe("feishu");
    expect(r.allowFrom).toEqual({ feishu: ["ou_1"] });
    expect(r.accountIds).toEqual({ feishu: "cli_x" });
    expect(r.policies).toEqual({ feishu: { sendProgress: false, sendToolHints: true } });
  });

  it("feishu enabled 但缺 appSecret → 跳过并告警", async () => {
    configured.feishu = { ...baseFeishu, appSecret: "" };
    const r = await assembleChannelAdapters();
    expect(r.adapters).toEqual([]);
    expect(r.warnings.some((w) => w.includes("凭据"))).toBe(true);
  });

  it("allowFrom 缺省为空数组(fail-closed 由 manager 兜底)", async () => {
    configured.feishu = {
      ...baseFeishu,
      allowFrom: undefined as unknown as Record<string, string>,
    };
    const r = await assembleChannelAdapters();
    expect(r.allowFrom).toEqual({ feishu: [] });
  });
});

describe("channels status", () => {
  it("uses protocol health and channel status resources", async () => {
    configured.feishu = { ...baseFeishu, allowFrom: {} };
    channelMocks.readDaemonRegistry.mockReturnValueOnce({ url: "http://127.0.0.1:4000", token: "token" });
    channelMocks.health.mockResolvedValueOnce({ ok: true });
    channelMocks.getStatus.mockResolvedValueOnce({ conversations: [], deliveries: [] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await createChannelsCommand().parseAsync(["status"], { from: "user" });
      expect(channelMocks.health).toHaveBeenCalledOnce();
      expect(channelMocks.getStatus).toHaveBeenCalledWith({ connector: "feishu", limit: 10 });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("daemon: ready"));
    } finally {
      log.mockRestore();
    }
  });
});
