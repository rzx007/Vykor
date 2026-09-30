import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import process from "node:process";
import { getTasksDir, PROJECT_CONFIG_DIR_NAME } from "@vykor/core";
import type { EnvironmentProcess } from "@vykor/environment";
import { signalProcessTree, terminateProcessTree } from "@vykor/sandbox";
import type { ExecutionStatus } from "./types.js";

export function adaptEnvironmentProcess(process: EnvironmentProcess): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const mutable = child as unknown as {
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
  };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      try {
        process.write(chunk);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      process.end();
      callback();
    },
  });
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  mutable.pid = process.pid;
  mutable.exitCode = null;
  mutable.signalCode = null;
  mutable.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    mutable.killed = true;
    void process.signal(signal === "SIGINT" ? "interrupt" : "terminate");
    return true;
  }) as ChildProcess["kill"];
  const stop = process.onOutput((chunk) => stdout.write(chunk));
  const stopErrors = process.onErrorOutput?.((chunk) => stderr.write(chunk));
  void process.wait().then((result) => {
    stop();
    stopErrors?.();
    mutable.exitCode = result.exitCode;
    stdout.end();
    stderr.end();
    child.emit("close", result.exitCode, result.signal ?? null);
    child.emit("exit", result.exitCode, result.signal ?? null);
  }).catch((error) => {
    stop();
    stopErrors?.();
    stdout.end();
    stderr.end();
    child.emit("error", error);
    child.emit("close", 1, null);
    child.emit("exit", 1, null);
  });
  return child;
}

// ── helpers ───────────────────────────────────────────────

/** A task in a terminal state will receive no further status transitions. */
export function isTerminal(status: ExecutionStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

export function defaultTasksDir(): string {
  try {
    return getTasksDir();
  } catch {
    return join(process.cwd(), PROJECT_CONFIG_DIR_NAME, "tasks");
  }
}

/** Write a frame to stdin, resolving on flush or rejecting on a pipe error. */
export function writeToStdin(stdin: NodeJS.WritableStream, payload: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stdin.write(payload, (err) => (err ? reject(err) : resolve()));
  });
}

/** Serialize one worker input as a single newline-terminated frame. */
export function encodeWorkerPayload(data: string): string {
  const stripped = data.replace(/\n+$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
    return stripped + "\n";
  }
  if (!stripped.includes("\n") && !stripped.includes("\r")) {
    return stripped + "\n";
  }
  return JSON.stringify({ text: stripped }) + "\n";
}

/** SIGTERM, then SIGKILL after `graceMs`. Resolves when the child has exited. */
export function terminateProcess(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return (async () => {
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    await terminateProcessTree(child, "SIGTERM").catch(() => false);
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (await waitForProcessExit(child, graceMs)) return;
    await terminateProcessTree(child, "SIGKILL").catch(() => false);
    await waitForProcessExit(child, 200);
  })();
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

/** Force-kill a process and its children, cross-platform. */
export function killProcessTree(child: ChildProcess): void {
  signalProcessTree(child, "SIGKILL");
}
