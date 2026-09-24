import { describe, expect, it } from "vitest";

import { diagnoseShellDialectMismatch } from "./shell.js";
import type { HostShellLauncher } from "@vykor/sandbox";

describe("diagnoseShellDialectMismatch", () => {
  const powershell: HostShellLauncher = { kind: "powershell", bin: "powershell.exe" };
  const pwsh: HostShellLauncher = { kind: "powershell", bin: "pwsh.exe" };
  const cmd: HostShellLauncher = { kind: "cmd", bin: "cmd.exe" };
  const bash: HostShellLauncher = { kind: "bash", bin: "bash.exe" };
  const posix: HostShellLauncher = { kind: "posix-sh" };

  it("flags obvious Bash syntax when PowerShell is active", () => {
    const problems = diagnoseShellDialectMismatch(
      "ls -la /tmp/dscode 2>/dev/null && head -5 README.md",
      powershell,
    );

    expect(problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(["ls-la", "posix-temp-path", "dev-null", "head", "powershell-control-operator"]),
    );
  });

  it("flags POSIX paths when cmd.exe is active", () => {
    const problems = diagnoseShellDialectMismatch("find / -name dscode 2>/dev/null", cmd);

    expect(problems.map((problem) => problem.code)).toEqual(expect.arrayContaining(["find-root", "dev-null"]));
  });

  it("does not flag Bash syntax when bash is active", () => {
    expect(diagnoseShellDialectMismatch("ls -la /tmp 2>/dev/null", bash)).toEqual([]);
  });

  it("flags PowerShell and cmd syntax in POSIX shells", () => {
    const problems = diagnoseShellDialectMismatch(
      "Get-ChildItem -Force; echo $env:TEMP; echo hi 2>nul",
      posix,
    );

    expect(problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(["powershell-cmdlet", "powershell-env", "cmd-null-device"]),
    );
  });

  it("flags PowerShell syntax in cmd.exe", () => {
    const problems = diagnoseShellDialectMismatch("Get-ChildItem | Select-Object -First 1; echo $null", cmd);

    expect(problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(["powershell-cmdlet", "powershell-null"]),
    );
  });

  it("allows conditional operators in PowerShell 7", () => {
    expect(diagnoseShellDialectMismatch("git status && git diff", pwsh)).toEqual([]);
  });

  it("describes PowerShell 5.1 JSON and UTF-8 constraints", async () => {
    const { createShellDescription } = await import("./shell.js");
    const description = createShellDescription({
      family: "powershell", dialect: "windows-powershell", executable: "powershell.exe",
      argsPrefix: ["-NoLogo", "-NoProfile", "-Command"], displayName: "Windows PowerShell 5.1",
      version: "5.1", pathStyle: "windows", tempDir: "C:\\Temp",
      capabilities: { conditionalAndOr: false, supportsLoginShell: false },
    });
    expect(description).toContain("Get-Content -Raw -Encoding UTF8 -LiteralPath");
    expect(description).toContain("ConvertFrom-Json does not support -Depth");
  });
});
