import type { ToolContext } from "@vykor/core";
import type { ShellDescriptor } from "@vykor/environment";
import { createProcess, resolveSandboxPolicy } from "@vykor/sandbox";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundShellTool } from "../../background-shell/background-shell-tools.js";
import { createShellTool } from "../shell.js";
import { DefaultShellExecutor } from "../executor.js";

const powershell: ShellDescriptor = {
  family: "powershell", dialect: "windows-powershell", executable: "powershell.exe",
  argsPrefix: ["-NoLogo", "-NoProfile", "-Command"], displayName: "Windows PowerShell 5.1",
  pathStyle: "windows", tempDir: "C:\\Temp",
  capabilities: { conditionalAndOr: false, supportsLoginShell: false },
};

const windowsPowerShellExecutor = new DefaultShellExecutor({
  resolveHostShell: () => ({ kind: "powershell", bin: powershell.executable }),
  createProcess: (command, options) => createProcess([powershell.executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], options),
});

describe("Shell interpreter and startup boundaries", () => {
  it("sends a legal PowerShell command to the active executor exactly once", async () => {
    const source = "@'\nconsole.log((true && false) || 42);\n'@ | node -";
    const executedCommands: string[] = [];
    const execShell = async (command: string) => {
      executedCommands.push(command);
      return processResult(command === source ? "42" : '{"errors":[]}');
    };
    const result = await createShellTool().execute({ command: source }, environmentContext(execShell));
    expect(executedCommands).toEqual([source]);
    expect(result).toMatchObject({ isError: false, executionState: "completed", content: [{ text: "42" }] });
  });

  it.each(["foreground", "converted background", "explicit background"])("does not launch an already canceled %s call", async mode => {
    const controller = new AbortController();
    controller.abort();
    const execShell = vi.fn();
    const create = vi.fn();
    const tool = mode === "explicit background" ? createBackgroundShellTool(powershell) : createShellTool();
    const result = await tool.execute({ command: mode === "foreground" ? "Write-Output 1" : "npm install", description: "fixture" }, {
      ...environmentContext(execShell), abortSignal: controller.signal,
      sessionId: "fixture", toolCallId: "fixture", backgroundShell: { create },
    });
    expect(result).toMatchObject({ failureKind: "interrupted", executionState: "not_started" });
    expect(execShell).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not launch after cancellation during environment workdir resolution", async () => {
    const controller = new AbortController();
    const execShell = vi.fn();
    const context = environmentContext(execShell);
    context.abortSignal = controller.signal;
    context.environment!.paths.resolve = async () => {
      controller.abort();
      return { executionPath: "/fixture" } as any;
    };
    const result = await createShellTool().execute({ command: "Write-Output 1" }, context);
    expect(result).toMatchObject({ failureKind: "interrupted", executionState: "not_started" });
    expect(execShell).not.toHaveBeenCalled();
  });

  it("does not launch after cancellation during legacy executor resolution", async () => {
    const controller = new AbortController();
    const run = vi.fn();
    const tool = createShellTool({
      async resolve(request) {
        controller.abort();
        return {
          command: request.command, cwd: process.cwd(), timeoutMs: 3_000, maxOutputChars: 4_096,
          policy: resolveSandboxPolicy({ cwd: process.cwd(), config: { enabled: false } }),
          hostShell: { kind: "powershell", bin: "powershell.exe" } as const,
          runner: { mode: "host", fallbackToHost: false } as const,
        };
      }, run,
    });
    const result = await tool.execute({ command: "Write-Output 1" }, { cwd: process.cwd(), abortSignal: controller.signal });
    expect(result).toMatchObject({ failureKind: "interrupted", executionState: "not_started" });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not attach dialect guesses to success, unknown outcome, policy rejection or interruption", async () => {
    for (const [exitCode, abort] of [[0, false], [null, false], [0, true]] as const) {
      const controller = new AbortController();
      const result = await createShellTool().execute({ command: "dir /B 2>nul" }, {
        ...environmentContext(async () => ({ ...processResult("actual output"), wait: async () => {
          if (abort) controller.abort();
          return { exitCode };
        } })), abortSignal: controller.signal,
      });
      expect(JSON.stringify(result)).not.toContain("Possible shell compatibility hints");
    }
    const result = await createShellTool({
      async resolve(request) { return {
        command: request.command, cwd: process.cwd(), timeoutMs: 3_000, maxOutputChars: 4_096,
        policy: resolveSandboxPolicy({ cwd: process.cwd(), config: { enabled: false } }),
        hostShell: { kind: "powershell", bin: "powershell.exe" } as const,
        runner: { mode: "host", fallbackToHost: false } as const,
      }; },
      async run() { return { status: "failed", failureKind: "policy", output: "denied", outputTruncated: false, exitCode: null } as const; },
    }).execute({ command: "dir /B 2>nul" }, { cwd: process.cwd() });
    expect(result).toMatchObject({ failureKind: "policy", executionState: "not_started", content: [{ text: "denied" }] });
    expect(JSON.stringify(result)).not.toContain("Possible shell compatibility hints");
  });

  it.skipIf(process.platform !== "win32")("reports an actual Windows PowerShell syntax failure as a completed command failure", async () => {
    const result = await createShellTool(windowsPowerShellExecutor).execute({ command: "Write-Output (", timeout: 10_000 }, { cwd: process.cwd() });
    expect(result).toMatchObject({ isError: true, failureKind: "command", executionState: "completed" });
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/MissingEndParenthesis|ParserError/) });
    expect(result.recoveryHint).toContain("1");
  });

  it.skipIf(process.platform !== "win32")("executes a valid JavaScript here-string through the real Shell tool", async () => {
    const result = await createShellTool(windowsPowerShellExecutor).execute({ command: "@'\nconsole.log((true && false) || 42);\n'@ | node -", timeout: 10_000 }, { cwd: process.cwd() });
    expect(result).toMatchObject({ isError: false, executionState: "completed" });
    expect(result.content[0]).toMatchObject({ text: "42" });
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
