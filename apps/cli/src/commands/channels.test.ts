import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  getFeishu: vi.fn(),
  runtimeStatus: vi.fn(),
  getStatus: vi.fn(),
  readDaemonRegistry: vi.fn(),
}));

vi.mock("@openharness/server", () => ({
  readDaemonRegistry: mocks.readDaemonRegistry,
}));
vi.mock("@openharness/client", () => ({
  OpenHarnessClient: class {
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
  it("starts the runtime, prints new denials once, and stops on abort", async () => {
    const controller = new AbortController();
    const client = {
      channels: {
        startRuntime: vi.fn(async () => runningStatus),
        stopRuntime: vi.fn(async () => runningStatus),
        runtimeStatus: vi.fn(async () => {
          controller.abort();
          return runningStatus;
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ou_x"));
    expect(client.channels.stopRuntime).toHaveBeenCalledOnce();
  });

  it("does not replay denials below the high-water mark", async () => {
    const controller = new AbortController();
    const calls = { count: 0 };
    const client = {
      channels: {
        startRuntime: vi.fn(async () => runningStatus),
        stopRuntime: vi.fn(async () => runningStatus),
        runtimeStatus: vi.fn(async () => {
          calls.count += 1;
          if (calls.count >= 2) controller.abort();
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

    expect(warn).toHaveBeenCalledTimes(1);
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
