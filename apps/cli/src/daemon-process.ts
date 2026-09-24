import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";

import { getLogsDir } from "@vykor/core";

export interface DaemonInvocationOptions {
  bunRuntime?: boolean;
  execPath?: string;
  nodePath?: string;
  tsxImport?: string;
  locateNode?: () => string | undefined;
}

export interface SpawnedDaemonProcess {
  child: ChildProcess;
  logPath: string;
  failure(): string | undefined;
}

function isTypeScriptEntry(entry: string): boolean {
  return [".ts", ".tsx", ".mts", ".cts"].includes(extname(entry).toLowerCase());
}

function formatInvocation(command: string, args: string[]): string {
  const redacted = args.map((arg, index) => args[index - 1] === "--token" ? "<redacted>" : arg);
  return [command, ...redacted].join(" ");
}

export function resolveDaemonInvocation(
  entry: string,
  args: string[],
  options: DaemonInvocationOptions = {},
): { command: string; args: string[] } {
  const bunRuntime = options.bunRuntime ?? "bun" in process.versions;
  const command = bunRuntime
    ? options.nodePath
      ?? process.env.VYKOR_NODE_EXECUTABLE
      ?? options.locateNode?.()
      ?? locateNodeExecutable()
      ?? "node"
    : options.execPath ?? process.execPath;
  const loaderArgs = isTypeScriptEntry(entry)
    ? ["--import", options.tsxImport ?? import.meta.resolve("tsx")]
    : [];
  return { command, args: [...loaderArgs, entry, ...args] };
}

export function locateNodeExecutable(platform: NodeJS.Platform = process.platform): string | undefined {
  const command = platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, [platform === "win32" ? "node.exe" : "node"], {
    encoding: "utf-8",
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

export function spawnDaemonProcess(entry: string, args: string[]): SpawnedDaemonProcess {
  const invocation = resolveDaemonInvocation(entry, args);
  const logPath = join(getLogsDir(), "daemon.log");
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `\n[launcher] ${new Date().toISOString()} ${formatInvocation(invocation.command, invocation.args)}\n`);

  const logFd = openSync(logPath, "a");
  let child: ChildProcess;
  try {
    child = spawn(invocation.command, invocation.args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }

  let failure: string | undefined;
  child.once("error", (error) => {
    failure = `spawn failed: ${error.message}`;
  });
  child.once("exit", (code, signal) => {
    failure = signal ? `exited from signal ${signal}` : `exited with code ${code ?? "unknown"}`;
  });
  child.unref();
  return { child, logPath, failure: () => failure };
}

export function daemonLogTail(logPath: string, maxCharacters = 4_000): string {
  try {
    const content = readFileSync(logPath, "utf-8").trim();
    return content.slice(-maxCharacters);
  } catch {
    return "";
  }
}

export function daemonStartupError(spawned: SpawnedDaemonProcess, reason?: string): Error {
  const detail = reason ?? spawned.failure() ?? "did not become ready";
  const tail = daemonLogTail(spawned.logPath);
  return new Error([
    `The Vykor daemon ${detail}.`,
    `Daemon log: ${spawned.logPath}`,
    ...(tail ? ["", tail] : []),
  ].join("\n"));
}
