import { resolveSandboxPolicy, type HostShellLauncher } from "@vykor/sandbox";
import { describe, expect, it, vi } from "vitest";
import { createShellTool as createBashTool } from "../shell.js";
import type {
  ShellExecContext,
  ShellExecRequest,
  ShellExecSpec,
  ShellExecutor,
  ShellRunResult,
} from "../types.js";

const posixShell: HostShellLauncher = { kind: "posix-sh" };

describe("createBashTool", () => {
  it("keeps a legacy failed command with null exit code unknown", async () => {
    const tool = createBashTool(fakeExecutor(result({ status: "failed", failureKind: "command", exitCode: null, output: "partial diagnostic" })));
    const feedback = await tool.execute({ command: "inspect" }, { cwd: process.cwd() });
    expect(feedback).toMatchObject({ isError: true, failureKind: "unknown_outcome", executionState: "unknown", content: [{ text: "partial diagnostic" }] });
    expect(feedback.recoveryHint ?? "").not.toContain("null");
    expect(feedback.compactSummary ?? "").not.toContain("null");
  });

  it("keeps an environment process with null exit code unknown", async () => {
    const tool = createBashTool();
    const feedback = await tool.execute({ command: "inspect" }, {
      cwd: "/work",
      environment: {
        info: { shellDescriptor: { family: "posix", dialect: "posix-sh", executable: "/bin/sh", argsPrefix: [], displayName: "POSIX Shell", pathStyle: "posix", tempDir: "/tmp", capabilities: { conditionalAndOr: true, supportsLoginShell: true } } },
        workspace: { executionRoot: "/work" },
        paths: { resolve: async () => ({ executionPath: "/work" }) },
        process: { execShell: async () => ({
          onOutput: (listener: (chunk: Uint8Array) => void) => { listener(new TextEncoder().encode("partial diagnostic")); return () => {}; },
          wait: async () => ({ exitCode: null }),
        }) },
      },
    } as any);
    expect(feedback).toMatchObject({ isError: true, failureKind: "unknown_outcome", executionState: "unknown", content: [{ text: "partial diagnostic" }] });
    expect(feedback.recoveryHint ?? "").not.toContain("null");
    expect(feedback.compactSummary ?? "").not.toContain("null");
  });

  it("uses the actual exit code for a failed command without copying its command into the summary", async () => {
    const tool = createBashTool(fakeExecutor(result({ status: "failed", failureKind: "command", exitCode: 7, output: "diagnostic" })));
    const feedback = await tool.execute({ command: "echo SECRET_VALUE" }, { cwd: process.cwd() });
    expect(feedback).toMatchObject({ isError: true, failureKind: "command", executionState: "completed" });
    expect(feedback.recoveryHint).toContain("7");
    expect(feedback.content[0]).toMatchObject({ text: "diagnostic" });
    expect(feedback.compactSummary ?? "").not.toContain("SECRET_VALUE");
  });

  it("executes through the active environment instead of the legacy shell runner", async () => {
    const legacy = fakeExecutor(result({ output: "host" }));
    legacy.resolve = vi.fn(legacy.resolve);
    const execShell = vi.fn(async () => ({
      onOutput(listener: (chunk: Uint8Array) => void) {
        listener(new TextEncoder().encode("/workspace\n"));
        return () => {};
      },
      wait: async () => ({ exitCode: 0 }),
      write: vi.fn(),
      end: vi.fn(),
      signal: vi.fn(async () => {}),
    }));
    const tool = createBashTool(legacy);

    const toolResult = await tool.execute({ command: "pwd" }, {
      cwd: "/workspace",
      environment: {
        info: {
          kind: "wsl",
          shell: "/bin/sh",
          shellDialect: "posix",
          pathStyle: "posix",
          shellDescriptor: {
            family: "posix", dialect: "posix-sh", executable: "/bin/sh", argsPrefix: [],
            displayName: "POSIX Shell", pathStyle: "posix", tempDir: "/tmp",
            capabilities: { conditionalAndOr: true, supportsLoginShell: true },
          },
        },
        workspace: { hostRoot: "D:\\repo", executionRoot: "/workspace" },
        process: { execShell },
        paths: {
          resolve: async (path: string) => ({
            executionPath: path,
            mountPurpose: "workspace",
            mountMode: "rw",
          }),
        },
      },
    } as any);

    expect(execShell).toHaveBeenCalledWith("pwd", expect.objectContaining({ cwd: "/workspace" }));
    expect(legacy.resolve).not.toHaveBeenCalled();
    expect(toolResult).toEqual({
      content: [{ type: "text", text: "/workspace" }],
      isError: false,
      executionState: "completed",
      compactSummary: "Shell completed: exitCode=0",
      metadata: {
        shellFamily: "posix",
        shellDialect: "posix-sh",
        shellExecutable: "/bin/sh",
        shellDisplayName: "POSIX Shell",
        pathStyle: "posix",
        exitCode: 0,
        status: "completed",
      },
    });
  });

  it("rejects cmd.exe syntax before executing in a PowerShell environment", async () => {
    const legacy = fakeExecutor(result({ output: "host" }));
    const execShell = vi.fn();
    const tool = createBashTool(legacy);

    const toolResult = await tool.execute({ command: "dir /B 2>nul" }, {
      cwd: "D:\\repo",
      environment: {
        info: {
          kind: "local",
          hostOs: "Windows",
          executionOs: "Windows",
          shell: "Windows PowerShell (powershell.exe)",
          shellDialect: "powershell",
          pathStyle: "windows",
          cwd: "D:\\repo",
          homeDir: "C:\\Users\\test",
          tempDir: "C:\\Temp",
          mounts: [],
          networkMode: "host",
          limitations: [],
          shellDescriptor: {
            family: "powershell", dialect: "windows-powershell", executable: "powershell.exe",
            argsPrefix: ["-NoLogo", "-NoProfile", "-Command"], displayName: "PowerShell",
            pathStyle: "windows", tempDir: "C:\\Temp",
            capabilities: { conditionalAndOr: false, supportsLoginShell: false },
          },
        },
        workspace: { hostRoot: "D:\\repo", executionRoot: "D:\\repo" },
        process: { execShell },
        paths: {
          resolve: async (path: string) => ({
            executionPath: path,
            mountPurpose: "workspace",
            mountMode: "rw",
          }),
        },
      },
    } as any);

    expect(execShell).not.toHaveBeenCalled();
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Shell dialect mismatch"),
    });
    expect(toolResult.metadata).toMatchObject({
      shellFamily: "powershell",
      shellDialect: "windows-powershell",
      shellDisplayName: "PowerShell",
      pathStyle: "windows",
      status: "failed",
    });
  });

  it("returns the environment shell and exit status as metadata", async () => {
    const execShell = vi.fn(async () => ({
      onOutput(listener: (chunk: Uint8Array) => void) {
        listener(new TextEncoder().encode("ok\n"));
        return () => {};
      },
      wait: async () => ({ exitCode: 0 }),
      write: vi.fn(),
      end: vi.fn(),
      signal: vi.fn(async () => {}),
    }));
    const tool = createBashTool(fakeExecutor(result()));

    const toolResult = await tool.execute({ command: "printf ok" }, {
      cwd: "/repo",
      environment: {
        info: {
          kind: "local",
          hostOs: "Linux",
          executionOs: "Linux",
          shell: "/bin/bash",
          shellDialect: "posix",
          pathStyle: "posix",
          cwd: "/repo",
          homeDir: "/home/test",
          tempDir: "/tmp",
          mounts: [],
          networkMode: "host",
          limitations: [],
          shellDescriptor: {
            family: "posix", dialect: "bash", executable: "/bin/bash", argsPrefix: [],
            displayName: "Bash", pathStyle: "posix", tempDir: "/tmp",
            capabilities: { conditionalAndOr: true, supportsLoginShell: true },
          },
        },
        workspace: { hostRoot: "/repo", executionRoot: "/repo" },
        process: { execShell },
        paths: {
          resolve: async (path: string) => ({
            executionPath: path,
            mountPurpose: "workspace",
            mountMode: "rw",
          }),
        },
      },
    } as any);

    expect(toolResult.metadata).toEqual({
      shellFamily: "posix",
      shellDialect: "bash",
      shellExecutable: "/bin/bash",
      shellDisplayName: "Bash",
      pathStyle: "posix",
      exitCode: 0,
      status: "completed",
    });
  });

  it("steers long-running commands toward background jobs instead of blocking Bash", () => {
    const tool = createBashTool(fakeExecutor(result()));

    expect(tool.description).toContain("short-lived");
    expect(tool.description).toContain("BackgroundShellCreate");
    expect(tool.description).toContain("JobWait");
  });

  it("resolves raw input before running the command", async () => {
    const resolve = vi.fn(async (request: ShellExecRequest, context: ShellExecContext) => {
      expect(request).toEqual({
        command: "echo hello",
        timeoutMs: 2_000,
        workdir: "D:\\project",
      });
      expect(context).toMatchObject({ cwd: "D:\\workspace", sessionId: "session-1" });
      return spec({ command: request.command, cwd: request.workdir, timeoutMs: request.timeoutMs });
    });
    const run = vi.fn(async () => result({ output: "hello" }));
    const tool = createBashTool({ resolve, run });

    const toolResult = await tool.execute({
      command: "echo hello",
      timeout: 2_000,
      workdir: "D:\\project",
    }, {
      cwd: "D:\\workspace",
      sessionId: "session-1",
    });

    expect(run).toHaveBeenCalledOnce();
    expect(toolResult).toEqual({
      content: [{ type: "text", text: "hello" }],
      isError: false,
      executionState: "completed",
      compactSummary: "Shell completed: exitCode=0",
    });
  });

  it("creates a background job for obvious long-running commands when Bash is misused", async () => {
    const resolve = vi.fn(async (request: ShellExecRequest) => spec({ command: request.command }));
    const run = vi.fn(async () => result({ output: "should not run inline" }));
    const create = vi.fn(async () => ({ jobId: "job-dev", label: "pnpm dev" }));
    const tool = createBashTool({ resolve, run });

    const toolResult = await tool.execute({
      command: "pnpm dev",
    }, {
      cwd: "/repo",
      sessionId: "session-1",
      toolCallId: "call-1",
      backgroundShell: { create },
    });

    expect(run).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      requestId: "tool:call-1",
      cwd: "/repo",
      sessionId: "session-1",
      command: "pnpm dev",
      description: "pnpm dev",
      settings: undefined,
    });
    expect(JSON.parse((toolResult.content[0] as { text: string }).text)).toMatchObject({
      kind: "job",
      action: "created",
      jobKind: "shell",
      jobId: "job-dev",
      label: "pnpm dev",
      note: expect.stringContaining("JobWait"),
    });
  });

  it("keeps explicitly timed commands inline even when they look long-running", async () => {
    const executor = fakeExecutor(result({ output: "done" }));
    const create = vi.fn(async () => ({ jobId: "job-dev", label: "pnpm dev" }));
    const tool = createBashTool(executor);

    const toolResult = await tool.execute({
      command: "pnpm dev",
      timeout: 1_000,
    }, {
      cwd: "/repo",
      sessionId: "session-1",
      toolCallId: "call-1",
      backgroundShell: { create },
    });

    expect(create).not.toHaveBeenCalled();
    expect(toolResult).toEqual({
      content: [{ type: "text", text: "done" }],
      isError: false,
      executionState: "completed",
      compactSummary: "Shell completed: exitCode=0",
    });
  });

  it("maps runner failures to the existing Bash error surface", async () => {
    const executor = fakeExecutor(result({
      status: "failed",
      failureKind: "runner",
      output: "SRT sandbox is unavailable",
      exitCode: null,
      runnerError: {
        name: "SandboxUnavailableError",
        message: "SRT sandbox is unavailable",
      },
    }));
    const tool = createBashTool(executor);

    const toolResult = await tool.execute({ command: "pwd" }, { cwd: process.cwd() });

    expect(toolResult).toEqual({
      content: [{ type: "text", text: "SRT sandbox is unavailable" }],
      isError: true,
      failureKind: "unknown_outcome",
      executionState: "unknown",
    });
  });

  it("renders timeout partial output from the resolved timeout", async () => {
    const executor = fakeExecutor(result({
      status: "timed_out",
      failureKind: "timeout",
      output: "partial marker",
      exitCode: null,
    }), spec({ timeoutMs: 750 }));
    const tool = createBashTool(executor);

    const toolResult = await tool.execute({ command: "slow", timeout: 750 }, { cwd: process.cwd() });

    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]).toMatchObject({
      type: "text",
      text: "Command timed out after 750 ms.\n\nPartial output:\npartial marker",
    });
  });

  it("keeps host shell dialect diagnostics before execution", async () => {
    const run = vi.fn(async () => result());
    const executor: ShellExecutor = {
      async resolve(request) {
        return spec({
          command: request.command,
          hostShell: { kind: "powershell", bin: "powershell.exe" },
        });
      },
      run,
    };
    const tool = createBashTool(executor);

    const toolResult = await tool.execute({ command: "ls -la /tmp" }, { cwd: process.cwd() });

    expect(run).not.toHaveBeenCalled();
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Shell dialect mismatch"),
    });
  });

  it("rejects Bash heredoc before PowerShell executes it", async () => {
    const run = vi.fn(async () => result());
    const executor: ShellExecutor = {
      async resolve(request) {
        return spec({ command: request.command, hostShell: { kind: "powershell", bin: "powershell.exe" } });
      },
      run,
    };
    const tool = createBashTool(executor);

    const toolResult = await tool.execute({ command: "python - <<'PY'\nprint('ok')\nPY" }, { cwd: process.cwd() });

    expect(run).not.toHaveBeenCalled();
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]).toMatchObject({ text: expect.stringContaining("heredoc") });
  });
});

function fakeExecutor(
  runResult: ShellRunResult,
  resolvedSpec = spec(),
): ShellExecutor {
  return {
    async resolve(request) {
      return { ...resolvedSpec, command: request.command };
    },
    async run() {
      return runResult;
    },
  };
}

function spec(overrides: Partial<ShellExecSpec> = {}): ShellExecSpec {
  return {
    command: "echo hello",
    cwd: process.cwd(),
    timeoutMs: 120_000,
    maxOutputChars: 12_000,
    policy: resolveSandboxPolicy({ cwd: process.cwd(), config: { enabled: false } }),
    hostShell: posixShell,
    runner: { mode: "host", fallbackToHost: false },
    ...overrides,
  };
}

function result(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    status: "completed",
    output: "",
    outputTruncated: false,
    exitCode: 0,
    ...overrides,
  };
}
