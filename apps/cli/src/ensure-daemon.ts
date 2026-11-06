import { join } from "node:path";
import { getLogsDir } from "@vykor/host-config";
import { setTimeout as delay } from "node:timers/promises";
import { Service } from "@vykor/application-client/service";
import {
  daemonPidAlive,
  getDaemonRegistryPath,
  readDaemonRegistry,
} from "@vykor/server/daemon-host";
import { reconcileDaemonAutoStart } from "./daemon-auto-start.js";
import { resolveDaemonInvocation } from "./daemon-process.js";
import { probeDaemonRegistry } from "./daemon-lifecycle.js";

export interface LocalDaemonHandle {
  url: string;
  token: string;
  storePath?: string;
  pid: number;
  version?: string;
}

export interface EnsureLocalDaemonOptions {
  /** CLI entry used to spawn serve. Defaults to process.argv[1]. */
  cliPath?: string;
  /** Optional version constraint for a manually configured legacy backend. */
  expectedVersion?: string;
  serveArgs?: string[];
  autoStart?: boolean;
}

const startupTimeoutMs = 45_000;

export async function ensureLocalDaemon(
  options: EnsureLocalDaemonOptions = {},
): Promise<LocalDaemonHandle> {
  const cliPath = options.cliPath ?? process.argv[1];
  if (!cliPath) throw new Error("Cannot locate CLI entrypoint.");
  const serveArgs = options.serveArgs ?? ["serve", "--register", "--host", "127.0.0.1", "--port", "0"];
  const { autoStart } = await reconcileDaemonAutoStart(cliPath, options.autoStart, serveArgs);
  const file = getDaemonRegistryPath();
  const beforeProbe = readDaemonRegistry();
  const existing = await Service.discover({ file });
  if (existing) return existing;

  const registry = readDaemonRegistry();
  if (registry && daemonPidAlive(registry.pid)) {
    if (beforeProbe?.token !== registry.token || beforeProbe?.url !== registry.url ||
      beforeProbe?.pid !== registry.pid || beforeProbe?.startedAt !== registry.startedAt) {
      const published = await Service.discover({ file });
      if (published) return published;
    }
    // Preserve explicitly registered remote and custom legacy backends.
    if (!registry.launcher && await probeDaemonRegistry(registry, { expectedVersion: options.expectedVersion }) === "ready")
      return registry;
    throw new Error("The registered daemon is temporarily unavailable. Retry or stop the existing daemon explicitly.");
  }

  if (autoStart) {
    const deadline = AbortSignal.timeout(startupTimeoutMs);
    try {
      while (!deadline.aborted) {
        const endpoint = await Service.discover({ file, signal: deadline });
        if (endpoint) return endpoint;
        const current = readDaemonRegistry();
        if (current && !current.launcher && await probeDaemonRegistry(current, { expectedVersion: options.expectedVersion }) === "ready")
          return current;
        await delay(100, undefined, { signal: deadline });
      }
    } catch (error) {
      if (!deadline.aborted) throw error;
    }
    throw new Error("The Vykor system service did not become ready.");
  }

  const { command, args } = resolveDaemonInvocation(cliPath, serveArgs);
  const logPath = join(getLogsDir(), "daemon.log");
  try {
    return await Service.ensure({ file, command: [command, ...args], timeoutMs: startupTimeoutMs, logPath });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail} See daemon log at ${logPath}.`, { cause: error });
  }
}
