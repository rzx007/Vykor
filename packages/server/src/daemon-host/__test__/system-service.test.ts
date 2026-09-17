import { describe, expect, it, vi } from "vitest";

import { DaemonSystemService } from "../system-service.js";

describe("DaemonSystemService asynchronous status", () => {
  it("queries Windows Task Scheduler without calling the synchronous command runner", async () => {
    const runCommand = vi.fn(() => {
      throw new Error("synchronous command runner must not run");
    });
    const runCommandAsync = vi.fn(async () => ({
      status: 0,
      stdout: "ready\r\n",
      stderr: "",
    }));
    const service = new DaemonSystemService({
      invocation: { command: "ohs.exe", args: ["--daemon-watchdog"], cwd: "D:/app" },
      platform: "win32",
      runCommand,
      runCommandAsync,
    });

    await expect(service.statusAsync()).resolves.toMatchObject({
      platform: "win32",
      state: "running",
      detail: "ready",
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(runCommandAsync).toHaveBeenCalledOnce();
  });
});
