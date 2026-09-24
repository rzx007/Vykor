import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  getFeishu: vi.fn(),
  runtimeStatus: vi.fn(),
  getStatus: vi.fn(),
  readDaemonRegistry: vi.fn(),
}));

vi.mock("@vykor/server", () => ({
  readDaemonRegistry: mocks.readDaemonRegistry,
}));
vi.mock("@vykor/client", () => ({
  VykorClient: class {
    protocol = { health: mocks.health };
    channels = {
      getFeishu: mocks.getFeishu,
      runtimeStatus: mocks.runtimeStatus,
      getStatus: mocks.getStatus,
    };
  },
}));

import { createChannelsCommand, followChannelRuntime } from "./channels.js";

const runningStatus = {
  bootId: "boot-1",
  connectors: [{ connector: "feishu", enabled: true, state: "running" as const }],
  recentDenials: [{ connector: "feishu", sender: "ou_x", chatId: "chat-1", at: 1, seq: 1 }],
};

describe("followChannelRuntime", () => {
  it("baselines existing denials, prints only newer ones, and stops on abort", async () => {
    const controller = new AbortController();
    const existing = runningStatus.recentDenials[0]!;
    const newer = { ...existing, seq: 2, sender: "ou_y" };
    let calls = 0;
    const client = {
      channels: {
        startRuntime: vi.fn(async () => runningStatus),
        stopRuntime: vi.fn(async () => runningStatus),
        runtimeStatus: vi.fn(async () => {
          calls += 1;
          if (calls === 1) return runningStatus;
          if (calls === 2) return { ...runningStatus, recentDenials: [existing, newer] };
          controller.abort();
          return { ...runningStatus, recentDenials: [existing, newer] };
        }),
      },
    };
    const log = vi.fn();
    const warn = vi.fn();

    await followChannelRuntime({
      client,
      signal: controller.signal,
      intervalMs: 1,
      log,
      warn,
    });

    expect(client.channels.startRuntime).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("feishu: running"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ou_y"));
    expect(client.channels.stopRuntime).toHaveBeenCalledOnce();
  });

  it("keeps polling through a transient status error", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = {
      channels: {
        startRuntime: vi.fn(async () => runningStatus),
        stopRuntime: vi.fn(async () => runningStatus),
        runtimeStatus: vi.fn(async () => {
          calls += 1;
          if (calls === 1) throw new Error("daemon restarting");
          controller.abort();
          return runningStatus;
        }),
      },
    };
    const warn = vi.fn();

    await followChannelRuntime({
      client,
      signal: controller.signal,
      intervalMs: 1,
      log: vi.fn(),
      warn,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("读取渠道状态失败"));
    expect(client.channels.stopRuntime).toHaveBeenCalledOnce();
  });
});

describe("channels status", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.readDaemonRegistry.mockReset();
    mocks.health.mockReset();
    mocks.getFeishu.mockReset();
    mocks.runtimeStatus.mockReset();
    mocks.getStatus.mockReset();
  });

  it("reports unconfigured when the daemon is not running", async () => {
    mocks.readDaemonRegistry.mockReturnValueOnce(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createChannelsCommand().parseAsync(["status"], { from: "user" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("daemon: not running"));
  });

  it("reads config and runtime state from the daemon", async () => {
    mocks.readDaemonRegistry.mockReturnValueOnce({
      url: "http://127.0.0.1:4000",
      token: "token",
    });
    mocks.health.mockResolvedValueOnce({ ok: true });
    mocks.getFeishu.mockResolvedValueOnce({
      configured: true,
      enabled: true,
      appId: "cli_x",
      allowFrom: [{ name: "me", id: "ou_1" }],
    });
    mocks.runtimeStatus.mockResolvedValueOnce(runningStatus);
    mocks.getStatus.mockResolvedValueOnce({ conversations: [], deliveries: [] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createChannelsCommand().parseAsync(["status"], { from: "user" });

    expect(mocks.health).toHaveBeenCalledOnce();
    expect(mocks.getStatus).toHaveBeenCalledWith({ connector: "feishu", limit: 10 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("runtime: running"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("daemon: ready"));
  });
});
