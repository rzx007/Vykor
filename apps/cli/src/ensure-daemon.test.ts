import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonRegistry } from "@vykor/server";

const statMock = vi.hoisted(() => vi.fn());
const readDaemonRegistryMock = vi.hoisted(() => vi.fn());
const clearDaemonRegistryMock = vi.hoisted(() => vi.fn());
const probeDaemonRegistryMock = vi.hoisted(() => vi.fn());
const terminateDaemonProcessMock = vi.hoisted(() => vi.fn());
const spawnDaemonProcessMock = vi.hoisted(() => vi.fn());
const daemonStartupErrorMock = vi.hoisted(() => vi.fn());
const systemServiceMock = vi.hoisted(() => ({
  status: vi.fn(() => ({ platform: "win32", state: "not-installed" })),
  install: vi.fn(),
  uninstall: vi.fn(),
  start: vi.fn(),
  restart: vi.fn(),
}));

vi.mock("@vykor/core", () => ({
  loadSettings: vi.fn(async () => ({ daemon: { autoStart: false } })),
}));

vi.mock("node:fs/promises", () => ({
  stat: statMock,
}));

vi.mock("@vykor/server", () => ({
  readDaemonRegistry: readDaemonRegistryMock,
  clearDaemonRegistry: clearDaemonRegistryMock,
}));

vi.mock("@vykor/server/daemon-host", () => ({
  shouldStartManagedDaemon: vi.fn(async () => false),
  saveDaemonAutoStartPreference: vi.fn(),
  reconcileDaemonSystemService: (
    service: typeof systemServiceMock,
    autoStart: boolean,
  ) => {
    const state = service.status().state;
    if (!autoStart && state !== "not-installed") {
      service.uninstall();
      return { state: "not-installed", action: "uninstalled" };
    }
    if (autoStart && state === "not-installed") {
      service.install();
      return { state: "running", action: "installed" };
    }
    if (autoStart && state === "stopped") {
      service.start();
      return { state: "running", action: "started" };
    }
    return { state, action: "none" };
  },
}));

vi.mock("./daemon-lifecycle.js", () => ({
  probeDaemonRegistry: probeDaemonRegistryMock,
  terminateDaemonProcess: terminateDaemonProcessMock,
}));

vi.mock("./daemon-process.js", () => ({
  spawnDaemonProcess: spawnDaemonProcessMock,
  daemonStartupError: daemonStartupErrorMock,
}));

vi.mock("./daemon-system-service.js", () => ({
  createDaemonSystemService: vi.fn(() => systemServiceMock),
}));

import { ensureLocalDaemon } from "./ensure-daemon.js";

function registry(overrides: Partial<DaemonRegistry> = {}): DaemonRegistry {
  return {
    url: "http://127.0.0.1:1234",
    pid: 123,
    token: "token",
    storePath: "sessions.db",
    startedAt: 200,
    version: "0.1.0",
    ...overrides,
  };
}

function spawned(failure?: string) {
  return {
    child: { pid: 456 },
    logPath: "D:/logs/daemon.log",
    failure: vi.fn(() => failure),
  };
}

describe("ensureLocalDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statMock.mockResolvedValue({ mtimeMs: 100 });
    spawnDaemonProcessMock.mockReturnValue(spawned());
    daemonStartupErrorMock.mockReturnValue(new Error("daemon startup failed"));
    terminateDaemonProcessMock.mockReturnValue(true);
    systemServiceMock.status.mockReturnValue({
      platform: "win32",
      state: "not-installed",
    });
  });

  it("returns an already-ready daemon without spawning", async () => {
    const ready = registry({ version: "0.2.0" });
    readDaemonRegistryMock.mockReturnValue(ready);
    probeDaemonRegistryMock.mockResolvedValue("ready");

    const handle = await ensureLocalDaemon({
      cliPath: "D:/repo/apps/cli/dist/index.js",
      expectedVersion: "0.2.0",
    });

    expect(handle).toEqual({
      url: ready.url,
      token: ready.token,
      pid: ready.pid,
      storePath: ready.storePath,
      version: ready.version,
    });
    expect(probeDaemonRegistryMock).toHaveBeenCalledWith(ready, {
      expectedVersion: "0.2.0",
      minimumStartedAt: 100,
    });
    expect(clearDaemonRegistryMock).not.toHaveBeenCalled();
    expect(spawnDaemonProcessMock).not.toHaveBeenCalled();
    expect(terminateDaemonProcessMock).not.toHaveBeenCalled();
  });

  it("spawns serve and waits for registry when no daemon is registered", async () => {
    const ready = registry({ pid: 456, url: "http://127.0.0.1:5678" });
    readDaemonRegistryMock.mockReturnValueOnce(null).mockReturnValueOnce(ready);
    probeDaemonRegistryMock.mockResolvedValue("ready");

    const handle = await ensureLocalDaemon({
      cliPath: "cli-entry.js",
      expectedVersion: "0.1.0",
    });

    expect(clearDaemonRegistryMock).toHaveBeenCalledOnce();
    expect(spawnDaemonProcessMock).toHaveBeenCalledWith("cli-entry.js", [
      "serve",
      "--register",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ]);
    expect(handle).toMatchObject({
      url: ready.url,
      token: ready.token,
      pid: ready.pid,
    });
    expect(terminateDaemonProcessMock).not.toHaveBeenCalled();
  });

  it("terminates a stale registered daemon before spawning a fresh one", async () => {
    const stale = registry({ pid: 111, startedAt: 50 });
    const ready = registry({ pid: 222, startedAt: 300 });
    readDaemonRegistryMock
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(ready);
    probeDaemonRegistryMock
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("ready");

    const handle = await ensureLocalDaemon({
      cliPath: "cli-entry.js",
      expectedVersion: "0.1.0",
    });

    expect(terminateDaemonProcessMock).toHaveBeenCalledWith(stale.pid);
    expect(clearDaemonRegistryMock).toHaveBeenCalledOnce();
    expect(spawnDaemonProcessMock).toHaveBeenCalledOnce();
    expect(handle.pid).toBe(ready.pid);
  });

  it("clears an unreachable registered daemon without terminating it", async () => {
    const unreachable = registry({ pid: 333 });
    const ready = registry({ pid: 444 });
    readDaemonRegistryMock
      .mockReturnValueOnce(unreachable)
      .mockReturnValueOnce(ready);
    probeDaemonRegistryMock
      .mockResolvedValueOnce("unreachable")
      .mockResolvedValueOnce("ready");

    const handle = await ensureLocalDaemon({
      cliPath: "cli-entry.js",
      expectedVersion: "0.1.0",
    });

    expect(terminateDaemonProcessMock).not.toHaveBeenCalled();
    expect(clearDaemonRegistryMock).toHaveBeenCalledOnce();
    expect(spawnDaemonProcessMock).toHaveBeenCalledOnce();
    expect(handle.pid).toBe(ready.pid);
  });

  it("reports a child process failure instead of waiting for the registry timeout", async () => {
    const failed = spawned("exited with code 1");
    readDaemonRegistryMock.mockReturnValue(null);
    spawnDaemonProcessMock.mockReturnValue(failed);

    await expect(
      ensureLocalDaemon({
        cliPath: "cli-entry.js",
        expectedVersion: "0.1.0",
      }),
    ).rejects.toThrow("daemon startup failed");

    expect(daemonStartupErrorMock).toHaveBeenCalledWith(failed);
  });

  it("restarts an installed system service instead of spawning a detached daemon", async () => {
    const ready = registry({ pid: 777 });
    systemServiceMock.status.mockReturnValue({
      platform: "win32",
      state: "running",
    });
    readDaemonRegistryMock.mockReturnValueOnce(null).mockReturnValue(ready);
    probeDaemonRegistryMock.mockResolvedValue("ready");

    const handle = await ensureLocalDaemon({
      cliPath: "cli-entry.js",
      expectedVersion: "0.1.0",
      autoStart: true,
    });

    expect(systemServiceMock.restart).toHaveBeenCalledOnce();
    expect(systemServiceMock.install).not.toHaveBeenCalled();
    expect(spawnDaemonProcessMock).not.toHaveBeenCalled();
    expect(handle.pid).toBe(777);
  });

  it("refreshes an installed system service when its daemon build is stale", async () => {
    const stale = registry({ pid: 111, startedAt: 50 });
    const ready = registry({ pid: 888, startedAt: 300 });
    systemServiceMock.status.mockReturnValue({
      platform: "win32",
      state: "running",
    });
    readDaemonRegistryMock.mockReturnValueOnce(stale).mockReturnValue(ready);
    probeDaemonRegistryMock
      .mockResolvedValueOnce("stale")
      .mockResolvedValue("ready");

    const handle = await ensureLocalDaemon({
      cliPath: "cli-entry.js",
      expectedVersion: "0.1.0",
      autoStart: true,
    });

    expect(systemServiceMock.install).toHaveBeenCalledOnce();
    expect(systemServiceMock.restart).not.toHaveBeenCalled();
    expect(terminateDaemonProcessMock).not.toHaveBeenCalled();
    expect(spawnDaemonProcessMock).not.toHaveBeenCalled();
    expect(handle.pid).toBe(888);
  });

  it("installs automatic startup when enabled and keeps an already-ready daemon", async () => {
    const ready = registry({ pid: 999 });
    readDaemonRegistryMock.mockReturnValue(ready);
    probeDaemonRegistryMock.mockResolvedValue("ready");

    const handle = await ensureLocalDaemon({
      cliPath: "cli-entry.js",
      expectedVersion: "0.1.0",
      autoStart: true,
    });

    expect(systemServiceMock.install).toHaveBeenCalledOnce();
    expect(spawnDaemonProcessMock).not.toHaveBeenCalled();
    expect(handle.pid).toBe(999);
  });

  it("removes automatic startup when disabled without stopping a ready daemon", async () => {
    const ready = registry({ pid: 1000 });
    systemServiceMock.status.mockReturnValue({
      platform: "win32",
      state: "running",
    });
    readDaemonRegistryMock.mockReturnValue(ready);
    probeDaemonRegistryMock.mockResolvedValue("ready");

    const handle = await ensureLocalDaemon({
      cliPath: "cli-entry.js",
      expectedVersion: "0.1.0",
      autoStart: false,
    });

    expect(systemServiceMock.uninstall).toHaveBeenCalledOnce();
    expect(terminateDaemonProcessMock).not.toHaveBeenCalled();
    expect(handle.pid).toBe(1000);
  });

  it("starts an on-demand daemon when removing the system service stopped the old one", async () => {
    const oldDaemon = registry({ pid: 1001 });
    const newDaemon = registry({ pid: 1002 });
    systemServiceMock.status.mockReturnValue({
      platform: "linux",
      state: "running",
    });
    readDaemonRegistryMock
      .mockReturnValueOnce(oldDaemon)
      .mockReturnValueOnce(newDaemon);
    probeDaemonRegistryMock
      .mockResolvedValueOnce("ready")
      .mockResolvedValueOnce("unreachable")
      .mockResolvedValueOnce("ready");

    const handle = await ensureLocalDaemon({
      cliPath: "cli-entry.js",
      expectedVersion: "0.1.0",
      autoStart: false,
    });

    expect(systemServiceMock.uninstall).toHaveBeenCalledOnce();
    expect(spawnDaemonProcessMock).toHaveBeenCalledOnce();
    expect(handle.pid).toBe(1002);
  });
});
