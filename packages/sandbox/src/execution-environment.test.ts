import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceBinding } from "@vykor/environment";
import { createExecutionEnvironment } from "./execution-environment.js";
import { resolveShellDescriptor } from "./shell.js";

describe("createExecutionEnvironment", () => {
  it("prefers a validated pwsh before Windows PowerShell and cmd", async () => {
    const shell = await resolveShellDescriptor({
      platform: "win32",
      tempDir: "C:\\Temp",
      probe: async (executable) => executable === "pwsh.exe" ? { version: "7.6.0" } : null,
    });

    expect(shell).toMatchObject({
      family: "powershell",
      dialect: "pwsh",
      executable: "pwsh.exe",
      version: "7.6.0",
      capabilities: { conditionalAndOr: true },
    });
  });

  it("fails an explicit unusable shell instead of silently falling back", async () => {
    await expect(resolveShellDescriptor({
      platform: "win32",
      configuredExecutable: "X:\\missing\\pwsh.exe",
      tempDir: "C:\\Temp",
      probe: async () => null,
    })).rejects.toThrow(/configured shell is unavailable/i);
  });

  it("creates a lightweight local environment", async () => {
    const cwd = process.cwd();
    const handle = await createExecutionEnvironment({
      config: { mode: "local", kind: "local", failClosed: false, cwd, sandbox: {} as any },
      settings: settings(), binding: createWorkspaceBinding({ kind: "local", hostRoot: cwd, executionRoot: cwd }),
      sessionId: "local", userSkillsRoot: cwd,
    });
    expect(handle.info.kind).toBe("local");
    expect(handle.info.shellDescriptor).toBeDefined();
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it("creates a fail-closed WSL process and terminal environment", async () => {
    const spawnWslProcess = vi.fn(() => childProcess());
    const handle = await createExecutionEnvironment({
      config: { mode: "wsl", kind: "wsl", failClosed: true, cwd: "D:\\repo", sandbox: {} as any },
      settings: settings(), binding: createWorkspaceBinding({ kind: "wsl", hostRoot: "D:\\repo", executionRoot: "/mnt/d/repo" }),
      sessionId: "wsl", userSkillsRoot: "C:\\skills",
    }, { preflightWsl: vi.fn(async () => {}), spawnWslProcess });
    const controller = new AbortController();
    await handle.process.execShell("pwd", { signal: controller.signal });
    expect(spawnWslProcess).toHaveBeenCalledWith(expect.objectContaining({
      argv: ["/bin/sh", "-lc", "pwd"],
      cwd: "/mnt/d/repo",
      signal: controller.signal,
    }));
    expect(handle.info.shellDescriptor).toMatchObject({
      family: "posix",
      dialect: "posix-sh",
      executable: "/bin/sh",
      argsPrefix: ["-lc"],
      pathStyle: "posix",
    });
    await expect(handle.terminal.prepare({ cols: 80, rows: 24 })).resolves.toMatchObject({ command: "wsl.exe", args: ["--cd", "/mnt/d/repo"] });
  });

  it("retains WSL output produced before the consumer subscribes", async () => {
    const handle = await createExecutionEnvironment({
      config: { mode: "wsl", kind: "wsl", failClosed: true, cwd: "D:\\repo", sandbox: {} as any },
      settings: settings(), binding: createWorkspaceBinding({ kind: "wsl", hostRoot: "D:\\repo", executionRoot: "/mnt/d/repo" }),
      sessionId: "fast-output", userSkillsRoot: "C:\\skills",
    }, { preflightWsl: async () => {}, spawnWslProcess: () => childProcess("fast", "warning") });
    const process = await handle.process.execProcess(["printf", "fast"]);
    await new Promise((resolve) => setImmediate(resolve));
    let output = "";
    let errorOutput = "";
    process.onOutput((chunk) => { output += new TextDecoder().decode(chunk); });
    process.onErrorOutput?.((chunk) => { errorOutput += new TextDecoder().decode(chunk); });
    expect(output).toBe("fast");
    expect(errorOutput).toBe("warning");
  });
});

function settings() {
  return { model: "test", apiFormat: "openai" as const, maxTurns: 1, permission: { mode: "default" as const }, sandbox: { enabled: false } };
}

function childProcess(output?: string, errorOutput?: string) {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  if (output) queueMicrotask(() => child.stdout.write(output));
  if (errorOutput) queueMicrotask(() => child.stderr.write(errorOutput));
  return child;
}
