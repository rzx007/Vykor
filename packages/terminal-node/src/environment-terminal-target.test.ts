import { describe, expect, it } from "vitest";

import { createHostTerminalTarget } from "./environment-terminal-target.js";

describe("createHostTerminalTarget", () => {
  it("keeps startup arguments separate and limits environment overrides to the returned target", () => {
    const original = process.env.VYKOR_TERMINAL_ONLY
    const target = createHostTerminalTarget({ cwd: "D:\\repo", shell: "shell.exe", shellArgs: ["--profile", "two words", "$(echo untouched)"], env: { VYKOR_TERMINAL_ONLY: "terminal" } })
    expect(target.args).toEqual(["--profile", "two words", "$(echo untouched)"])
    expect(target.env).toEqual({ VYKOR_TERMINAL_ONLY: "terminal" })
    expect(process.env.VYKOR_TERMINAL_ONLY).toBe(original)
  })
  it("keeps host and execution cwd identical for an explicit local terminal", async () => {
    const target = createHostTerminalTarget({
      cwd: "D:\\repo",
      shell: "powershell.exe",
    });

    expect(target).toMatchObject({
      command: "powershell.exe",
      args: [],
      hostCwd: "D:\\repo",
      executionCwd: "D:\\repo",
      shell: "powershell.exe",
    });
    await expect(target.signal("terminate")).resolves.toBeUndefined();
    await expect(target.close()).resolves.toBeUndefined();
  });
});
