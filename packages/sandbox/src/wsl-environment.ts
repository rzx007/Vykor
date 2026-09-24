import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

import type {
  EnvironmentPathResolver,
  ResolvedEnvironmentPath,
  WorkspaceBinding,
} from "@vykor/environment";
import { signalProcessTree } from "./process-control.js";

const execFileAsync = promisify(execFile);

export class WslEnvironmentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WslEnvironmentUnavailableError";
  }
}

export interface WslProbeResult {
  exitCode: number;
  stderr: string;
}

export async function preflightWsl(
  dependencies: {
    platform?: NodeJS.Platform;
    run?: () => Promise<WslProbeResult>;
  } = {},
): Promise<void> {
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new WslEnvironmentUnavailableError("WSL is only available on Windows");
  }
  const result = await (dependencies.run ?? defaultWslProbe)();
  if (result.exitCode !== 0) {
    throw new WslEnvironmentUnavailableError(
      result.stderr.trim() || "WSL or its default distribution is unavailable",
    );
  }
}

export function hostPathToWslPath(path: string): string {
  if (/^\\\\wsl(?:\.localhost|\$)?\\/i.test(path)) {
    throw new Error("WSL filesystem projects are not supported yet");
  }
  const normalized = win32.resolve(path);
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(normalized);
  if (!match) throw new Error(`WSL requires a Windows drive path: ${path}`);
  const drive = match[1]!.toLowerCase();
  const rest = match[2]!.replace(/\\/g, "/");
  return posix.join("/mnt", drive, rest);
}

export function wslPathToHostPath(path: string): string | undefined {
  const normalized = posix.resolve(path);
  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(normalized);
  if (!match) return undefined;
  const rest = match[2]?.split("/") ?? [];
  return win32.join(`${match[1]!.toUpperCase()}:\\`, ...rest);
}

export function createWslPathResolver(binding: WorkspaceBinding): EnvironmentPathResolver {
  if (binding.kind !== "wsl") throw new Error("WSL path resolver requires a WSL binding");
  const resolveExecutionPath = (path: string) =>
    path.startsWith("/") ? posix.resolve(path) : posix.resolve(binding.executionRoot, path);
  const describe = (executionPath: string): ResolvedEnvironmentPath => {
    const hostPath = wslPathToHostPath(executionPath);
    const inWorkspace = executionPath === binding.executionRoot ||
      executionPath.startsWith(`${binding.executionRoot}/`);
    return {
      executionPath,
      ...(hostPath ? { hostPath } : {}),
      mountPurpose: inWorkspace ? "workspace" : "unmounted",
      ...(inWorkspace ? { mountMode: "rw" as const } : {}),
    };
  };
  return {
    async resolve(path) {
      if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
        return describe(hostPathToWslPath(path));
      }
      return describe(resolveExecutionPath(path));
    },
    presentHostPath(path) {
      try {
        return hostPathToWslPath(path);
      } catch {
        return undefined;
      }
    },
    toHostPath: wslPathToHostPath,
  };
}

export function spawnWslProcess(input: {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  stdio?: import("node:child_process").StdioOptions;
  signal?: AbortSignal;
}): ChildProcess {
  if (input.argv.length === 0) throw new Error("WSL process requires a non-empty argv");
  const envArgs = Object.entries(input.env ?? {}).map(([key, value]) => `${key}=${value}`);
  const executionArgv = envArgs.length > 0 ? ["/usr/bin/env", ...envArgs, ...input.argv] : input.argv;
  const cancelHostPath = input.signal
    ? win32.join(tmpdir(), `vykor-wsl-cancel-${randomUUID()}`)
    : undefined;
  const supervisedArgv = cancelHostPath
    ? ["/bin/sh", "-c", WSL_CANCEL_SUPERVISOR, "vykor-wsl", hostPathToWslPath(cancelHostPath), ...executionArgv]
    : executionArgv;
  const child = spawn("wsl.exe", ["--cd", input.cwd, "--exec", ...supervisedArgv], {
    windowsHide: true,
    stdio: input.stdio ?? ["pipe", "pipe", "pipe"],
  });
  if (input.signal && cancelHostPath) {
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      try { writeFileSync(cancelHostPath, "cancel", "utf8"); } catch { signalProcessTree(child, "SIGTERM"); }
      fallback = setTimeout(() => signalProcessTree(child, "SIGKILL"), 3_000);
      fallback.unref?.();
    };
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      input.signal?.removeEventListener("abort", abort);
      if (fallback) clearTimeout(fallback);
      try { unlinkSync(cancelHostPath); } catch { /* no marker was created or WSL removed it */ }
    };
    child.once("close", cleanup);
    child.once("error", cleanup);
  }
  return child;
}

const WSL_CANCEL_SUPERVISOR = `
cancel_file=$1
shift
/usr/bin/setsid "$@" &
child_pid=$!
while kill -0 "$child_pid" 2>/dev/null; do
  if [ -f "$cancel_file" ]; then
    kill -TERM -- "-$child_pid" 2>/dev/null || kill -TERM "$child_pid" 2>/dev/null
    wait "$child_pid" 2>/dev/null
    rm -f -- "$cancel_file"
    exit 143
  fi
  /bin/sleep 0.05
done
wait "$child_pid"
status=$?
rm -f -- "$cancel_file"
exit "$status"
`;

async function defaultWslProbe(): Promise<WslProbeResult> {
  try {
    await execFileAsync("wsl.exe", ["--exec", "/bin/sh", "-c", "exit 0"], {
      timeout: 10_000,
      windowsHide: true,
    });
    return { exitCode: 0, stderr: "" };
  } catch (error) {
    const detail = error as { code?: number | string; stderr?: string | Buffer; message?: string };
    return {
      exitCode: typeof detail.code === "number" ? detail.code : 1,
      stderr: detail.stderr?.toString() || detail.message || "WSL is unavailable",
    };
  }
}
