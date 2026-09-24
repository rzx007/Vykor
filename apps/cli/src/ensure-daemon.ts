import { stat } from "node:fs/promises";

import {
  loadDaemonAutoStart,
  reconcileDaemonAutoStart,
} from "./daemon-auto-start.js";
import { VERSION } from "./version.js";
import {
  probeDaemonRegistry,
  terminateDaemonProcess,
} from "./daemon-lifecycle.js";
import {
  daemonStartupError,
  spawnDaemonProcess,
  type SpawnedDaemonProcess,
} from "./daemon-process.js";

export interface LocalDaemonHandle {
  url: string;
  token: string;
  storePath?: string;
  pid: number;
  version?: string;
}

export interface EnsureLocalDaemonOptions {
  /** Absolute or relative CLI entry used to spawn `serve`. Defaults to `process.argv[1]`. */
  cliPath?: string;
  expectedVersion?: string;
  /** Override the global daemon.autoStart setting. Intended for tests and embedded hosts. */
  autoStart?: boolean;
}

/**
 * Ensure a local Vykor daemon is ready (registry + health).
 * Shared by TUI launcher and print/headless Session API client.
 */
export async function ensureLocalDaemon(
  options: EnsureLocalDaemonOptions = {},
): Promise<LocalDaemonHandle> {
  const cliPath = options.cliPath ?? process.argv[1];
  if (!cliPath) throw new Error("Cannot locate CLI entrypoint.");

  const expectedVersion = options.expectedVersion ?? VERSION;
  const daemonProbeOptions = {
    expectedVersion,
    minimumStartedAt: (await stat(cliPath)).mtimeMs,
  };

  const { clearDaemonRegistry, readDaemonRegistry } =
    await import("@vykor/server");

  const waitForDaemonRegistry = async (
    spawned: SpawnedDaemonProcess,
  ): Promise<NonNullable<ReturnType<typeof readDaemonRegistry>>> => {
    for (let i = 0; i < 40; i += 1) {
      const registry = readDaemonRegistry();
      if (
        registry &&
        (await probeDaemonRegistry(registry, daemonProbeOptions)) === "ready"
      ) {
        return registry;
      }
      if (spawned.failure()) throw daemonStartupError(spawned);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw daemonStartupError(spawned);
  };

  let daemon = readDaemonRegistry();
  let daemonStatus = daemon
    ? await probeDaemonRegistry(daemon, daemonProbeOptions)
    : "unreachable";
  const autoStart = options.autoStart ?? (await loadDaemonAutoStart());
  const reconciliation = reconcileDaemonAutoStart(cliPath, autoStart);
  if (
    daemon &&
    daemonStatus === "ready" &&
    reconciliation.action === "uninstalled"
  ) {
    daemonStatus = await probeDaemonRegistry(daemon, daemonProbeOptions);
  }

  if (!daemon || daemonStatus !== "ready") {
    if (autoStart) {
      if (reconciliation.action === "none") {
        if (daemonStatus === "stale") reconciliation.service.install();
        else reconciliation.service.restart();
      }
      for (let i = 0; i < 100; i += 1) {
        daemon = readDaemonRegistry();
        if (
          daemon &&
          (await probeDaemonRegistry(daemon, daemonProbeOptions)) === "ready"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (
        !daemon ||
        (await probeDaemonRegistry(daemon, daemonProbeOptions)) !== "ready"
      ) {
        const status = reconciliation.service.status();
        throw new Error(
          `The Vykor daemon system service did not become ready (state: ${status.state})`,
        );
      }
    } else {
      if (daemon && daemonStatus === "stale")
        terminateDaemonProcess(daemon.pid);
      clearDaemonRegistry();
      const serveArgs = [
        cliPath,
        "serve",
        "--register",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ];
      const spawned = spawnDaemonProcess(serveArgs[0]!, serveArgs.slice(1));
      daemon = await waitForDaemonRegistry(spawned);
    }
  }

  return {
    url: daemon.url,
    token: daemon.token,
    pid: daemon.pid,
    ...(daemon.storePath ? { storePath: daemon.storePath } : {}),
    ...(daemon.version ? { version: daemon.version } : {}),
  };
}
