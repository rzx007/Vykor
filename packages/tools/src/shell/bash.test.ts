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

  it.each([
    'powershell -Command "$s=1; Write-Output $s"',
    'powershell.exe -NoProfile -Command "$chars=\'abc\'; Write-Output $chars"',
    'pwsh -NoLogo -Command "$s=1; Write-Output $s"',
    '& "powershell.exe" -Command "$s=1; Write-Output $s"',
    '& \'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\' -Command "$s=1; Write-Output $s"',
    'powershell -Command "Write-Output ""hello""; $s=1; Write-Output $s"',
    'Write-Output foo#bar; powershell -Command "$s=1; Write-Output $s"',
  ])("flags variables expanded by an outer PowerShell command: %s", (command) => {
    expect(diagnoseShellDialectMismatch(command, powershell).map((problem) => problem.code))
      .toContain("powershell-nested-expansion");
  });

  it.each([
    "@'{\n  value\n'@",
    "$code = @'print('hello')\n'@\n$code | python -",
    '@"hello\n"@',
  ])("flags content on a PowerShell here-string opening line: %s", (command) => {
    expect(diagnoseShellDialectMismatch(command, powershell).map((problem) => problem.code))
      .toContain("powershell-here-string-header");
  });

  it.each([
    "$s = 'abc'; Write-Output $s.Length",
    "powershell -Command '$s=1; Write-Output $s'",
    'powershell -Command "`$s=1; Write-Output `$s"',
    "$code = @'\nprint('hello')\n'@\n$code | python -",
    "Write-Output 'Example: powershell -Command \"$s=1\"'",
    '# powershell -Command "$s=1"',
    'Write-Output "literal; powershell -Command ""$s=1"""',
    "$code = @'\npowershell -Command \"$s=1\"\n@'{\n'@\n$code | python -",
  ])("allows correctly quoted PowerShell and literal code examples: %s", (command) => {
    expect(diagnoseShellDialectMismatch(command, powershell)).toEqual([]);
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
