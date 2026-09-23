import { describe, expect, it, vi } from "vitest";
import type { Settings } from "@openharness/core";

import { createDaemonAutoStartController } from "../auto-start-controller.js";

function settings(autoStart: boolean): Settings {
  return {
    model: "m",
    apiFormat: "anthropic",
    maxTurns: 50,
    permission: { mode: "default" },
    daemon: { autoStart },
  };
}

function fixture(initial = false) {
  let current = settings(initial);
  let state: "not-installed" | "running" | "stopped" = initial
    ? "running"
    : "not-installed";
  const install = vi.fn(() => {
    state = "running";
  });
  const uninstall = vi.fn(() => {
    state = "not-installed";
  });
  const start = vi.fn(() => {
    state = "running";
  });
  const controller = createDaemonAutoStartController({
    invocation: { command: "ohs", args: ["serve"], cwd: "D:/app" },
    loadSettings: async () => current,
    updateSettings: async (change) => {
      current = change(current);
      return current;
    },
    createService: () => ({
      status: () => ({ platform: "win32", state }),
      statusAsync: async () => ({ platform: "win32", state }),
      install,
      uninstall,
      start,
    }),
  });
  return { controller, install, uninstall, current: () => current };
}

describe("daemon auto-start controller", () => {
  it("installs and verifies the configured service", async () => {
    const value = fixture();
    expect(await value.controller.enable()).toEqual({
      configured: true,
      serviceState: "running",
      enabled: true,
    });
    expect(value.install).toHaveBeenCalledOnce();
  });

  it("reinstalls an existing service to refresh its invocation", async () => {
    const value = fixture(true);
    await expect(value.controller.enable()).resolves.toMatchObject({
      enabled: true,
    });
    expect(value.install).toHaveBeenCalledOnce();
  });

  it("rejects an unknown final service state instead of reporting enabled", async () => {
    let current = settings(false);
    const controller = createDaemonAutoStartController({
      invocation: { command: "ohs", args: ["serve"], cwd: "D:/app" },
      loadSettings: async () => current,
      updateSettings: async (change) => {
        current = change(current);
        return current;
      },
      createService: () => ({
        status: () => ({ platform: "linux", state: "unknown" }),
        statusAsync: async () => ({ platform: "linux", state: "unknown" }),
        install: vi.fn(),
        uninstall: vi.fn(),
        start: vi.fn(),
      }),
    });

    await expect(controller.enable()).rejects.toThrow(
      "Daemon system service did not reach an enabled state",
    );
    expect(current.daemon.autoStart).toBe(false);
  });

  it("uninstalls and persists the disabled preference", async () => {
    const value = fixture(true);
    expect(await value.controller.disable()).toEqual({
      configured: false,
      serviceState: "not-installed",
      enabled: false,
    });
    expect(value.uninstall).toHaveBeenCalledOnce();
    expect(value.current().daemon.autoStart).toBe(false);
  });

  it("restores configuration even when service compensation also fails", async () => {
    let current = settings(false);
    const controller = createDaemonAutoStartController({
      invocation: { command: "ohs", args: ["serve"], cwd: "D:/app" },
      loadSettings: async () => current,
      updateSettings: async (change) => {
        current = change(current);
        return current;
      },
      createService: () => ({
        status: () => {
          throw new Error("status recovery failed");
        },
        statusAsync: async () => ({ platform: "win32", state: "not-installed" }),
        install: () => {
          throw new Error("install failed");
        },
        uninstall: vi.fn(),
        start: vi.fn(),
      }),
    });

    await expect(controller.enable()).rejects.toBeInstanceOf(AggregateError);
    expect(current.daemon.autoStart).toBe(false);
  });

  it("restores the previous enabled preference when final disable verification fails", async () => {
    let current = settings(true);
    const controller = createDaemonAutoStartController({
      invocation: { command: "ohs", args: ["serve"], cwd: "D:/app" },
      loadSettings: async () => current,
      updateSettings: async (change) => {
        current = change(current);
        return current;
      },
      createService: () => ({
        status: () => ({ platform: "win32", state: "running" }),
        statusAsync: async () => ({ platform: "win32", state: "running" }),
        install: vi.fn(),
        uninstall: vi.fn(),
        start: vi.fn(),
      }),
    });

    await expect(controller.disable()).rejects.toThrow(
      "Daemon system service did not reach a disabled state",
    );
    expect(current.daemon.autoStart).toBe(true);
  });

  it("reads snapshots through the asynchronous service status path", async () => {
    const synchronousStatus = vi.fn(() => {
      throw new Error("synchronous status must not run");
    });
    const controller = createDaemonAutoStartController({
      invocation: { command: "ohs", args: ["serve"], cwd: "D:/app" },
      loadSettings: async () => settings(false),
      updateSettings: vi.fn(async (change) => change(settings(false))),
      createService: () => ({
        status: synchronousStatus,
        statusAsync: async () => ({ platform: "win32", state: "not-installed" }),
        install: vi.fn(),
        uninstall: vi.fn(),
        start: vi.fn(),
      }),
    });

    await expect(controller.snapshot()).resolves.toEqual({
      configured: false,
      serviceState: "not-installed",
      enabled: false,
    });
    expect(synchronousStatus).not.toHaveBeenCalled();
  });
});
