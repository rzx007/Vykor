import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDefaultShell } from "../shell";

describe("resolveDefaultShell", () => {
  it("uses the first Windows shell that actually exists on PATH", () => {
    const powershell = join("C:\\WindowsPowerShell", "powershell.exe");
    const shell = resolveDefaultShell(
      "win32",
      { Path: "C:\\PowerShell7;C:\\WindowsPowerShell" },
      (path) => path === powershell,
    );

    expect(shell.command).toBe(powershell);
  });

  it("falls back to ComSpec when PowerShell is unavailable", () => {
    const commandPrompt = "C:\\Windows\\System32\\cmd.exe";
    const shell = resolveDefaultShell(
      "win32",
      { Path: "", ComSpec: commandPrompt },
      (path) => path === commandPrompt,
    );

    expect(shell.command).toBe(commandPrompt);
  });
});
