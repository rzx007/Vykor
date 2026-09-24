import { beforeEach, describe, expect, it, vi } from "vitest";

const loadSettingsMock = vi.hoisted(() => vi.fn());
const saveSettingsMock = vi.hoisted(() => vi.fn());
const serviceMock = vi.hoisted(() => ({
  status: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  start: vi.fn(),
}));

vi.mock("@vykor/server/daemon-host", () => ({
  shouldStartManagedDaemon: async () =>
    (await loadSettingsMock()).daemon?.autoStart ?? false,
  saveDaemonAutoStartPreference: async (autoStart: boolean) => {
    const settings = await loadSettingsMock();
    await saveSettingsMock({
      ...settings,
      daemon: { ...settings.daemon, autoStart },
    });
  },
  reconcileDaemonSystemService: (
    service: typeof serviceMock,
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

vi.mock("./daemon-system-service.js", () => ({
  createDaemonSystemService: vi.fn(() => serviceMock),
}));

import {
  loadDaemonAutoStart,
  reconcileDaemonAutoStart,
  saveDaemonAutoStart,
} from "./daemon-auto-start.js";

describe("daemon auto-start settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadSettingsMock.mockResolvedValue({
      model: "m",
      daemon: { autoStart: false },
    });
    serviceMock.status.mockReturnValue({
      platform: "win32",
      state: "not-installed",
    });
  });

  it("loads and saves daemon.autoStart without dropping other settings", async () => {
    expect(await loadDaemonAutoStart()).toBe(false);

    await saveDaemonAutoStart(true);

    expect(saveSettingsMock).toHaveBeenCalledWith({
      model: "m",
      daemon: { autoStart: true },
    });
  });

  it("installs the system service when automatic startup is enabled", () => {
    const result = reconcileDaemonAutoStart("cli.js", true);

    expect(serviceMock.install).toHaveBeenCalledOnce();
    expect(result.action).toBe("installed");
    expect(result.state).toBe("running");
  });

  it("starts a disabled system service when automatic startup is enabled", () => {
    serviceMock.status.mockReturnValue({ platform: "win32", state: "stopped" });

    const result = reconcileDaemonAutoStart("cli.js", true);

    expect(serviceMock.start).toHaveBeenCalledOnce();
    expect(result.action).toBe("started");
  });

  it("uninstalls the system service when automatic startup is disabled", () => {
    serviceMock.status.mockReturnValue({ platform: "win32", state: "running" });

    const result = reconcileDaemonAutoStart("cli.js", false);

    expect(serviceMock.uninstall).toHaveBeenCalledOnce();
    expect(result.action).toBe("uninstalled");
    expect(result.state).toBe("not-installed");
  });
});
