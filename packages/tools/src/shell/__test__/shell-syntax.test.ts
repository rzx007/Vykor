import { mkdtemp, access, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@vykor/core";
import type { ShellDescriptor } from "@vykor/environment";
import { resolveSandboxPolicy } from "@vykor/sandbox";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundShellTool } from "../../background-shell/background-shell-tools.js";
import { createShellTool, shellCommandSyntaxError } from "../shell.js";

const powershell: ShellDescriptor = {
  family: "powershell", dialect: "windows-powershell", executable: "powershell.exe",
  argsPrefix: ["-NoLogo", "-NoProfile", "-Command"], displayName: "Windows PowerShell 5.1",
  pathStyle: "windows", tempDir: "C:\\Temp",
  capabilities: { conditionalAndOr: false, supportsLoginShell: false },
};

describe("PowerShell syntax probe boundaries", () => {
  it("uses the active environment once, passes source as data, and does not retain an internal output log", async () => {
    const source = "@'\n中文 && false || true; 'quoted';\n'@";
    const execShell = vi.fn(async (_command: string) => processResult('{"errors":[]}'));
    const context = environmentContext(execShell);
    const begin = vi.fn();
    context.shellOutputLogs = { begin } as unknown as ToolContext["shellOutputLogs"];

    expect(await shellCommandSyntaxError(source, powershell, context)).toBeUndefined();
    expect(execShell).toHaveBeenCalledOnce();
    const script = execShell.mock.calls[0]![0];
    expect(script).toContain(Buffer.from(source, "utf8").toString("base64"));
    expect(script).toContain("Parser]::ParseInput");
    expect(script).not.toContain(source);
    expect(script).not.toMatch(/Invoke-Expression|ScriptBlock.*(?:Create|Invoke)/);
    expect(begin).not.toHaveBeenCalled();
  });

  it("only rejects confirmed native errors, preserving their position without echoing command contents", async () => {
    const execShell = vi.fn(async () => processResult('{"errors":[{"id":"MissingEndParenthesisInExpression","line":2,"column":4}]}'));
    const result = await shellCommandSyntaxError("Write-Output 'SECRET'\n(", powershell, environmentContext(execShell));
    expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
    expect(JSON.stringify(result)).toContain("line 2, column 4");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it.each([
    ["parser unavailable", "", 1],
    ["unexpected output", "not JSON", 0],
    ["unexpected error shape", '{"errors":[{"message":"a guess"}]}', 0],
    ["truncated output", "x".repeat(13_000), 0],
  ])("falls back to the actual interpreter when the probe has %s", async (_label, output, exitCode) => {
    const source = "node -e \"console.log(true && false || true)\"";
    const execShell = vi.fn(async (command: string) => command === source
      ? processResult("actual command executed", 0)
      : processResult(output as string, exitCode as number));
    const result = await createShellTool().execute({ command: source }, environmentContext(execShell));
    expect(execShell).toHaveBeenCalledTimes(2);
    expect(execShell.mock.calls[1]![0]).toBe(source);
    expect(result).toMatchObject({ isError: false, executionState: "completed", content: [{ text: "actual command executed" }] });
  });

  it("does not probe or create a background job after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const execShell = vi.fn();
    const create = vi.fn();
    const context = { ...environmentContext(execShell), abortSignal: controller.signal,
      sessionId: "fixture", toolCallId: "fixture", backgroundShell: { create } };
    const result = await createBackgroundShellTool(powershell).execute({ command: "npm install", description: "fixture" }, context);
    expect(result).toMatchObject({ failureKind: "interrupted", executionState: "not_started" });
    expect(execShell).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not start the user command when canceled during parsing", async () => {
    const controller = new AbortController();
    const execShell = vi.fn(async () => ({ ...processResult('{"errors":[]}'), wait: async () => {
      controller.abort(); return { exitCode: 0 };
    } }));
    const result = await createShellTool().execute({ command: "Write-Output 'must not execute'" }, {
      ...environmentContext(execShell), abortSignal: controller.signal,
    });
    expect(result).toMatchObject({ failureKind: "interrupted", executionState: "not_started" });
    expect(execShell).toHaveBeenCalledOnce();
  });

  it("bounds the probe timeout and lets the real interpreter handle syntax afterwards", async () => {
    vi.useFakeTimers();
    try {
      const execShell = vi.fn(async (_command: string, options: { signal: AbortSignal }) => ({
        onOutput: () => () => {},
        wait: () => new Promise<{ exitCode: null }>(resolve => options.signal.addEventListener("abort", () => resolve({ exitCode: null }), { once: true })),
      }));
      const pending = shellCommandSyntaxError("Write-Output (", powershell, environmentContext(execShell));
      await vi.advanceTimersByTimeAsync(3_001);
      expect(await pending).toBeUndefined();
      expect(execShell).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each(["path resolution", "process startup", "process wait"])("bounds %s even when the backend does not settle after abort", async stage => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => {});
      const execShell = vi.fn(async () => stage === "process startup" ? never : {
        onOutput: () => () => {}, wait: () => never,
      });
      const context = environmentContext(execShell);
      if (stage === "path resolution") context.environment!.paths.resolve = () => never;
      let settled = false;
      const pending = shellCommandSyntaxError("Write-Output (", powershell, context).then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(3_001);
      expect(settled).toBe(true);
      expect(await pending).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it("returns promptly on user cancellation even if process startup is unresponsive", async () => {
    const controller = new AbortController();
    const execShell = vi.fn(() => new Promise<never>(() => {}));
    const pending = shellCommandSyntaxError("Write-Output 1", powershell, {
      ...environmentContext(execShell), abortSignal: controller.signal,
    });
    controller.abort();
    expect(await pending).toMatchObject({ failureKind: "interrupted", executionState: "not_started" });
  });

  it("leaves non-PowerShell environments alone", async () => {
    const execShell = vi.fn();
    expect(await shellCommandSyntaxError("Get-ChildItem $env:TEMP", { kind: "bash", bin: "bash" }, environmentContext(execShell))).toBeUndefined();
    expect(execShell).not.toHaveBeenCalled();
  });

  it("does not attach dialect guesses to success, unknown outcome, policy rejection or interruption", async () => {
    for (const [exitCode, abort] of [[0, false], [null, false], [0, true]] as const) {
      const controller = new AbortController();
      const source = "dir /B 2>nul";
      const execShell = vi.fn(async (command: string) => command !== source
        ? processResult('{"errors":[]}')
        : { ...processResult("actual output"), wait: async () => {
          if (abort) controller.abort();
          return { exitCode };
        } });
      const result = await createShellTool().execute({ command: source }, {
        ...environmentContext(execShell), abortSignal: controller.signal,
      });
      expect(JSON.stringify(result)).not.toContain("Possible shell compatibility hints");
    }
    const executor = {
      async resolve(request: { command: string }) { return {
        command: request.command, cwd: process.cwd(), timeoutMs: 3_000, maxOutputChars: 4_096,
        policy: resolveSandboxPolicy({ cwd: process.cwd(), config: { enabled: false } }),
        hostShell: { kind: "powershell", bin: "powershell.exe" } as const,
        runner: { mode: "host", fallbackToHost: false } as const,
      }; },
      async run() { return { status: "failed", failureKind: "policy", output: "denied", outputTruncated: false, exitCode: null } as const; },
    };
    const result = await createShellTool(executor).execute({ command: "dir /B 2>nul" }, { cwd: process.cwd() });
    expect(result).toMatchObject({ failureKind: "policy", executionState: "not_started", content: [{ text: "denied" }] });
  });

  it.skipIf(process.platform !== "win32")("uses real Windows PowerShell 5.1 grammar and never executes candidate file writes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vykor-shell-parse-"));
    try {
      const context = { cwd, policy: resolveSandboxPolicy({ cwd, config: { enabled: false } }) };
      const marker = join(cwd, "must-not-exist.txt");
      const command = `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value 'must not execute'`;
      expect(await shellCommandSyntaxError(command, powershell, context)).toBeUndefined();
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      const invalid = await shellCommandSyntaxError("Write-Output 1 && Write-Output 2", powershell, context);
      expect(invalid).toMatchObject({ failureKind: "invalid_input", executionState: "not_started" });
      expect(JSON.stringify(invalid)).toContain("InvalidEndOfLine");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "win32")("executes a valid JavaScript here-string with logical operators through the real Shell tool", async () => {
    const result = await createShellTool().execute({ command: "@'\nconsole.log((true && false) || 42);\n'@ | node -", timeout: 10_000 }, { cwd: process.cwd() });
    expect(result).toMatchObject({ isError: false, executionState: "completed" });
    expect(result.content[0]).toMatchObject({ text: "42" });
  });

  it.skipIf(process.platform !== "win32")("uses PowerShell 7 grammar when that is the selected interpreter", async (test) => {
    const available = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { windowsHide: true, timeout: 3_000 });
    if (available.status !== 0) { test.skip(); return; }
    expect(available.stdout.toString().trim()).toBe("7");
    const context = { cwd: process.cwd(), policy: resolveSandboxPolicy({ cwd: process.cwd(), config: { enabled: false } }) };
    const launcher = { kind: "powershell", bin: "pwsh.exe" } as const;
    expect(await shellCommandSyntaxError("Write-Output 1 && Write-Output 2", launcher, context)).toBeUndefined();
    expect(await shellCommandSyntaxError("Write-Output (", launcher, context)).toMatchObject({ failureKind: "invalid_input", executionState: "not_started" });
  });
});

function processResult(output: string, exitCode = 0) {
  return {
    onOutput(listener: (chunk: Uint8Array) => void) { listener(new TextEncoder().encode(output)); return () => {}; },
    wait: async () => ({ exitCode }),
  };
}

function environmentContext(execShell: (command: string, options: { cwd: string; signal: AbortSignal }) => Promise<unknown>): ToolContext {
  return { cwd: "/fixture", environment: {
    info: { shellDescriptor: powershell }, workspace: { executionRoot: "/fixture" },
    paths: { resolve: async (path: string) => ({ executionPath: path }) }, process: { execShell },
  } } as unknown as ToolContext;
}
