import { afterEach, describe, expect, it, vi } from "vitest";

import { daemonPidAlive, stopDaemonProcess } from "../lifecycle.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("daemon lifecycle", () => {
  it("treats EPERM as a live process", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    expect(daemonPidAlive(42)).toBe(true);
  });

  it("returns false when the process is gone", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("no such process");
    });
    expect(daemonPidAlive(42)).toBe(false);
  });

  it("throws when the process survives SIGTERM and force kill", async () => {
    vi.spyOn(process, "kill").mockReturnValue(true);
    await expect(
      stopDaemonProcess(42, { graceMs: 20, forceKillMs: 20 }),
    ).rejects.toThrow(/did not stop/i);
  });
});
