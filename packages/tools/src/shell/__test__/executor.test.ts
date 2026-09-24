import { spawn } from "node:child_process";
import type { Settings } from "@vykor/core";
import {
  SandboxPolicyDeniedError,
  type HostShellLauncher,
} from "@vykor/sandbox";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  DefaultShellExecutor,
} from "../executor.js";

const posixShell: HostShellLauncher = { kind: "posix-sh" };

describe("DefaultShellExecutor.resolve", () => {
  it("resolves request defaults and host runner facts", async () => {
    const executor = new DefaultShellExecutor({ resolveHostShell: () => posixShell });

    const spec = await executor.resolve({ command: "echo hello" }, {
      cwd: "C:\\workspace",
      sessionId: "session-1",
      settings: settings({ enabled: false }),
    });

    expect(spec).toMatchObject({
      command: "echo hello",
      cwd: "C:\\workspace",
      sessionId: "session-1",
      timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
      maxOutputChars: 12_000,
      hostShell: posixShell,
      runner: { mode: "host", fallbackToHost: false },
    });
  });

  it("makes SRT fallback explicit when the local sandbox is enabled", async () => {
    const executor = new DefaultShellExecutor({ resolveHostShell: () => posixShell });

    const preferred = await executor.resolve({ command: "pwd" }, {
      cwd: "D:\\workspace",
      settings: settings({ enabled: true, failIfUnavailable: false }),
    });
    const required = await executor.resolve({ command: "pwd" }, {
      cwd: "D:\\workspace",
      settings: settings({ enabled: true, failIfUnavailable: true }),
    });

    expect(preferred.runner).toEqual({
      mode: "sandbox-preferred",
      backend: "srt",
      fallbackToHost: true,
    });
    expect(required.runner).toEqual({
      mode: "sandbox-required",
      backend: "srt",
      fallbackToHost: false,
    });
  });
});

describe("DefaultShellExecutor.run", () => {
  it("returns a structured command failure", async () => {
    const executor = processExecutor("process.stdout.write('bad command'); process.exit(3)");
    const spec = await executor.resolve({ command: "ignored" }, { cwd: process.cwd() });

    const result = await executor.run(spec);

    expect(result).toMatchObject({
      status: "failed",
      failureKind: "command",
      exitCode: 3,
      output: "bad command",
    });
  });

  it("returns a structured runner failure when process startup fails", async () => {
    const executor = new DefaultShellExecutor({
      resolveHostShell: () => posixShell,
      createProcess: async () => {
        throw new Error("runner unavailable");
      },
    });
    const spec = await executor.resolve({ command: "ignored" }, { cwd: process.cwd() });

    const result = await executor.run(spec);

    expect(result).toMatchObject({
      status: "failed",
      failureKind: "runner",
      exitCode: null,
      output: "runner unavailable",
      runnerError: { name: "Error", message: "runner unavailable" },
    });
  });

  it("keeps policy denial separate from runner startup failure", async () => {
    const executor = new DefaultShellExecutor({
      resolveHostShell: () => posixShell,
      createProcess: async () => {
        throw new SandboxPolicyDeniedError("execution_denied", "execute", "execution denied");
      },
    });
    const spec = await executor.resolve({ command: "ignored" }, { cwd: process.cwd() });

    const result = await executor.run(spec);

    expect(result).toMatchObject({
      status: "failed",
      failureKind: "policy",
      exitCode: null,
      output: "execution denied",
    });
  });

  it("bounds retained output while recording truncation", async () => {
    const executor = processExecutor("process.stdout.write('a'.repeat(200))");
    const spec = await executor.resolve({
      command: "ignored",
      maxOutputChars: 32,
    }, { cwd: process.cwd() });

    const result = await executor.run(spec);

    expect(result.status).toBe("completed");
    expect(result.outputTruncated).toBe(true);
    expect(result.output.length).toBe(33);
  });

  it("retains output produced before a timeout", async () => {
    const executor = processExecutor(
      "process.stdout.write('partial-marker'); setTimeout(() => {}, 5_000)",
    );
    const spec = await executor.resolve({
      command: "ignored",
      timeoutMs: 500,
    }, { cwd: process.cwd() });

    const result = await executor.run(spec);

    expect(result).toMatchObject({
      status: "timed_out",
      failureKind: "timeout",
      output: "partial-marker",
    });
  });

  it("does not start a process when already interrupted", async () => {
    const createProcess = vi.fn();
    const executor = new DefaultShellExecutor({
      resolveHostShell: () => posixShell,
      createProcess,
    });
    const spec = await executor.resolve({ command: "ignored" }, { cwd: process.cwd() });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.run(spec, controller.signal);

    expect(result).toMatchObject({
      status: "interrupted",
      failureKind: "interrupted",
      exitCode: null,
    });
    expect(createProcess).not.toHaveBeenCalled();
  });
});

function processExecutor(script: string): DefaultShellExecutor {
  return new DefaultShellExecutor({
    resolveHostShell: () => posixShell,
    createProcess: async (_command, options) => spawn(process.execPath, ["-e", script], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: options.stdio,
    }),
  });
}

function settings(sandbox: NonNullable<Settings["sandbox"]>): Settings {
  return {
    model: "test", apiFormat: "openai", maxTurns: 1,
    permission: { mode: "default" }, sandbox,
  };
}
