import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceBinding } from "@vykor/environment";
import { createExecutionEnvironment } from "../execution-environment.js";

afterEach(() => vi.useRealTimers());

async function environment(createChild: () => ChildProcess) {
  const cwd = process.cwd();
  return createExecutionEnvironment({
    config: { mode: "local", kind: "local", failClosed: false, cwd, sandbox: {} as any },
    settings: { model: "test", apiFormat: "openai", maxTurns: 1, permission: { mode: "default" }, sandbox: { enabled: false } },
    binding: createWorkspaceBinding({ kind: "local", hostRoot: cwd, executionRoot: cwd }),
    sessionId: "output-drain", userSkillsRoot: cwd,
  }, { createShellProcess: async () => createChild(), createProcess: async () => createChild() });
}

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null, signalCode: null,
  }) as unknown as ChildProcess;
}

it.each(["shell", "process"] as const)("bounds output drain after %s exits without closing its inherited pipes", async kind => {
  const child = childProcess();
  const handle = await environment(() => child);
  vi.useFakeTimers();
  const command = kind === "shell"
    ? await handle.process.execShell("browser open")
    : await handle.process.execProcess(["browser", "open"]);
  let output = "";
  command.onOutput(chunk => { output += Buffer.from(chunk).toString(); });
  command.onErrorOutput?.(chunk => { output += Buffer.from(chunk).toString(); });
  const settled = vi.fn();
  const outcome = command.wait().then(value => { settled(); return value; }, error => { settled(); return error; });
  // A live command has no output-drain deadline.
  await vi.advanceTimersByTimeAsync(10_000);
  expect(settled).not.toHaveBeenCalled();
  child.stdout!.write("partial output");
  child.stderr!.write("diagnostic");
  Object.assign(child, { exitCode: 0 });
  child.emit("exit", 0, null);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(settled).toHaveBeenCalledOnce();
  expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringMatching(/output.*(?:close|drain)/i) }));
  expect(child.stdout!.destroyed).toBe(true);
  expect(child.stderr!.destroyed).toBe(true);
  expect(output).toBe("partial outputdiagnostic");
  // A late close must not turn the uncertain outcome into success.
  child.emit("close", 0, null);
  await expect(command.wait()).rejects.toThrow(/output.*(?:close|drain)/i);
});
it("retains trailing output after exit and clears the drain deadline on close", async () => {
  const child = childProcess();
  const handle = await environment(() => child);
  vi.useFakeTimers();
  const command = await handle.process.execProcess(["browser", "open"]);
  let output = "";
  command.onOutput(chunk => { output += Buffer.from(chunk).toString(); });
  const settled = vi.fn();
  const outcome = command.wait().then(value => { settled(); return value; });
  child.emit("exit", 0, null);
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).not.toHaveBeenCalled();
  child.stdout!.write("last output");
  child.emit("close", 0, null);
  await expect(outcome).resolves.toEqual({ exitCode: 0 });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(output).toBe("last output");
  expect(child.stdout!.destroyed).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

