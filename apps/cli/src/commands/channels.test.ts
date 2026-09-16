import { describe, it, expect, vi } from "vitest";

const channelMocks = vi.hoisted(() => ({
  health: vi.fn(),
  getStatus: vi.fn(),
  loadSettings: vi.fn(),
  readDaemonRegistry: vi.fn(),
}));

vi.mock("@openharness/core", () => ({ loadSettings: channelMocks.loadSettings }));
vi.mock("@openharness/server", () => ({ readDaemonRegistry: channelMocks.readDaemonRegistry }));
vi.mock("@openharness/client", () => ({
  OpenHarnessClient: class {
    protocol = { health: channelMocks.health };
    channels = { getStatus: channelMocks.getStatus };
  },
}));
import { assembleChannelAdapters, createChannelsCommand } from "./channels.js";

describe("assembleChannelAdapters", () => {
  it("无配置 → 空组装", async () => {
    const r = await assembleChannelAdapters(undefined);
    expect(r.adapters).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("feishu disabled → 不组装", async () => {
    const r = await assembleChannelAdapters({
      feishu: { enabled: false, appId: "a", appSecret: "s", allowFrom: { "*": "*" } },
    });
    expect(r.adapters).toEqual([]);
  });

  it("feishu enabled 但缺凭据 → 跳过并告警", async () => {
    const r = await assembleChannelAdapters({
      feishu: { enabled: true, appId: "", appSecret: "", allowFrom: { "*": "*" } },
    });
    expect(r.adapters).toEqual([]);
    expect(r.warnings.some((w) => w.includes("appId"))).toBe(true);
  });

  it("feishu enabled 且凭据齐 → 组装 adapter,allowFrom 值列表交给 manager", async () => {
    const r = await assembleChannelAdapters({
      feishu: { enabled: true, appId: "cli_x", appSecret: "sec", allowFrom: { 个人: "ou_1" } },
    });
    expect(r.adapters).toHaveLength(1);
    expect(r.adapters[0]!.name).toBe("feishu");
    expect(r.allowFrom).toEqual({ feishu: ["ou_1"] });
    expect(r.accountIds).toEqual({ feishu: "cli_x" });
  });

  it("allowFrom 缺省为空数组(fail-closed 由 manager 兜底)", async () => {
    const r = await assembleChannelAdapters({
      feishu: {
        enabled: true,
        appId: "cli_x",
        appSecret: "sec",
        allowFrom: undefined as unknown as Record<string, string>,
      },
    });
    expect(r.allowFrom).toEqual({ feishu: [] });
  });
});

describe("channels status", () => {
  it("uses protocol health and channel status resources", async () => {
    channelMocks.loadSettings.mockResolvedValueOnce({
      channels: { feishu: { enabled: true, appId: "cli_x", appSecret: "sec", allowFrom: {} } },
    });
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
