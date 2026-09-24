import { statSync } from "node:fs";
import { Command } from "commander";
import type { DaemonRegistry } from "@vykor/server";

import {
  daemonPidAlive,
  probeDaemonRegistry,
  terminateDaemonProcess,
} from "../daemon-lifecycle.js";
import { stopDaemonProcess } from "@vykor/server/daemon-host";
import {
  loadDaemonAutoStart,
  reconcileDaemonAutoStart,
} from "../daemon-auto-start.js";
import { daemonStartupError, spawnDaemonProcess } from "../daemon-process.js";
import {
  createCliDaemonAutoStartController,
  createDaemonSystemService,
} from "../daemon-system-service.js";
import { VERSION } from "../version.js";

interface ServeOptions {
  host?: string;
  port?: number;
  token?: string;
  allowOrigin?: string[];
  storePath?: string;
  register?: boolean;
}

export function isLoopbackHost(host: string | undefined): boolean {
  const normalized = (host ?? "127.0.0.1").trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export function assertSafeDaemonBinding(
  options: Pick<ServeOptions, "host" | "token">,
): void {
  if (!isLoopbackHost(options.host) && !options.token) {
    throw new Error("A non-loopback daemon requires an explicit --token");
  }
}

export function daemonHealthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/health`;
}

async function runServe(options: ServeOptions): Promise<void> {
  const {
    clearDaemonRegistry,
    createBearerToken,
    createDaemonRegistryEntry,
    readDaemonRegistry,
    startVykorDaemon,
    writeDaemonRegistry,
  } = await import("@vykor/server");

  assertSafeDaemonBinding(options);
  const token = options.token ?? createBearerToken();
  const { server, listen } = await startVykorDaemon({
    host: options.host,
    port: options.port,
    token,
    allowedOrigins: options.allowOrigin,
    storePath: options.storePath,
    version: VERSION,
  });

  if (options.register) {
    writeDaemonRegistry(
      createDaemonRegistryEntry({
        url: listen.url,
        pid: process.pid,
        token,
        storePath: server.store.path,
        version: VERSION,
        executionSurface: "cli_advanced",
      }),
    );
  }

  console.log(`[daemon] listening ${listen.url}`);
  if (options.register) console.log("[daemon] registry written");

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void (async () => {
        await server.close();
        const registry = readDaemonRegistry();
        if (registry?.pid === process.pid) clearDaemonRegistry();
        resolve();
      })();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

export function createServeCommand(): Command {
  return new Command("serve")
    .description(
      "Start the Vykor daemon/server runtime in the foreground",
    )
    .option("--host <host>", "Host to bind", "127.0.0.1")
    .option(
      "--port <port>",
      "Port to bind",
      (value) => Number.parseInt(value, 10),
      0,
    )
    .option("--token <token>", "Bearer token; generated when omitted")
    .option(
      "--allow-origin <origin...>",
      "Allow browser requests from exact origin(s)",
    )
    .option("--store-path <path>", "Session store path")
    .option("--register", "Write daemon registry for clients to attach")
    .action(async (options: ServeOptions) => {
      await runServe(options);
    });
}

export function createDaemonCommand(): Command {
  const cmd = new Command("daemon").description(
    "Manage the Vykor daemon/server runtime",
  );

  cmd
    .command("start")
    .description("Start the daemon in the background")
    .option("--host <host>", "Host to bind", "127.0.0.1")
    .option(
      "--port <port>",
      "Port to bind",
      (value) => Number.parseInt(value, 10),
      0,
    )
    .option("--token <token>", "Bearer token; generated when omitted")
    .option(
      "--allow-origin <origin...>",
      "Allow browser requests from exact origin(s)",
    )
    .option("--store-path <path>", "Session store path")
    .action(async (options: ServeOptions) => {
      assertSafeDaemonBinding(options);
      const { clearDaemonRegistry, readDaemonRegistry } =
        await import("@vykor/server");
      const entry = process.argv[1];
      if (!entry) {
        console.error("Cannot locate CLI entrypoint.");
        process.exit(1);
      }
      const probeOptions = {
        expectedVersion: VERSION,
        minimumStartedAt: statSync(entry).mtimeMs,
      };
      const existing = readDaemonRegistry();
      let existingStatus = existing
        ? await probeDaemonRegistry(existing, probeOptions)
        : "unreachable";
      const args = [
        "serve",
        "--register",
        "--host",
        options.host ?? "127.0.0.1",
      ];
      if (options.port !== undefined) args.push("--port", String(options.port));
      if (options.token) args.push("--token", options.token);
      for (const origin of options.allowOrigin ?? [])
        args.push("--allow-origin", origin);
      if (options.storePath) args.push("--store-path", options.storePath);
      const autoStart = await loadDaemonAutoStart();
      const reconciliation = reconcileDaemonAutoStart(entry, autoStart, args);
      if (
        existing &&
        existingStatus === "ready" &&
        reconciliation.action === "uninstalled"
      ) {
        existingStatus = await probeDaemonRegistry(existing, probeOptions);
      }
      if (existing && existingStatus === "ready") {
        console.log(
          `Daemon already running at ${existing.url} (PID: ${existing.pid})`,
        );
        return;
      }

      if (autoStart) {
        if (reconciliation.action === "none") {
          if (existingStatus === "stale") reconciliation.service.install();
          else reconciliation.service.restart();
        }
        const registry = await waitForReadyDaemon(
          probeOptions,
          readDaemonRegistry,
        );
        console.log(
          `Daemon started by the system service at ${registry.url} (PID: ${registry.pid})`,
        );
        return;
      }

      if (existing && existingStatus === "stale") {
        terminateDaemonProcess(existing.pid);
        await stopDaemonProcess(existing.pid);
      }
      clearDaemonRegistry();

      const spawned = spawnDaemonProcess(entry, args);
      const registry = await waitForReadyDaemon(
        probeOptions,
        readDaemonRegistry,
        () => {
          if (spawned.failure()) throw daemonStartupError(spawned);
        },
      ).catch((error) => {
        if (
          error instanceof Error &&
          error.message.includes("did not become ready")
        )
          throw daemonStartupError(spawned);
        throw error;
      });
      console.log(`Daemon started at ${registry.url} (PID: ${registry.pid})`);
    });

  cmd
    .command("install")
    .description("Start the daemon after sign-in and restart it after crashes")
    .option("--host <host>", "Host to bind", "127.0.0.1")
    .option(
      "--port <port>",
      "Port to bind",
      (value) => Number.parseInt(value, 10),
      0,
    )
    .option("--token <token>", "Bearer token; generated when omitted")
    .option(
      "--allow-origin <origin...>",
      "Allow browser requests from exact origin(s)",
    )
    .option("--store-path <path>", "Session store path")
    .action(async (options: ServeOptions) => {
      assertSafeDaemonBinding(options);
      const entry = process.argv[1];
      if (!entry) throw new Error("Cannot locate CLI entrypoint.");
      const { clearDaemonRegistry, readDaemonRegistry } =
        await import("@vykor/server");
      const args = [
        "serve",
        "--register",
        "--host",
        options.host ?? "127.0.0.1",
      ];
      if (options.port !== undefined) args.push("--port", String(options.port));
      if (options.token) args.push("--token", options.token);
      for (const origin of options.allowOrigin ?? [])
        args.push("--allow-origin", origin);
      if (options.storePath) args.push("--store-path", options.storePath);

      const existing = readDaemonRegistry();
      if (existing) {
        const probe = await probeDaemonRegistry(existing, {
          expectedVersion: VERSION,
        });
        if (
          (probe === "ready" || probe === "stale") &&
          daemonPidAlive(existing.pid)
        ) {
          terminateDaemonProcess(existing.pid);
          await stopDaemonProcess(existing.pid);
        }
      }
      clearDaemonRegistry();

      await createCliDaemonAutoStartController(entry, args).enable();
      const registry = await waitForReadyDaemon(
        { expectedVersion: VERSION, minimumStartedAt: statSync(entry).mtimeMs },
        readDaemonRegistry,
      );
      console.log(`Daemon system service installed for ${process.platform}.`);
      console.log(`Daemon running at ${registry.url} (PID: ${registry.pid})`);
    });

  cmd
    .command("uninstall")
    .description("Remove the daemon from automatic system startup")
    .action(async () => {
      const entry = process.argv[1];
      if (!entry) throw new Error("Cannot locate CLI entrypoint.");
      const { clearDaemonRegistry, readDaemonRegistry } =
        await import("@vykor/server");
      const registry = readDaemonRegistry();
      await createCliDaemonAutoStartController(entry).disable();
      if (registry && daemonPidAlive(registry.pid)) {
        terminateDaemonProcess(registry.pid);
        await stopDaemonProcess(registry.pid);
      }
      clearDaemonRegistry();
      console.log("Daemon system service uninstalled.");
    });

  cmd
    .command("watchdog", { hidden: true })
    .description("Check the local daemon once and start it when needed")
    .allowUnknownOption()
    .argument("<serve-command>")
    .argument("[serve-args...]")
    .action(async (serveCommand: string, serveArgs: string[]) => {
      if (serveCommand !== "serve")
        throw new Error("Daemon watchdog only accepts the serve command");
      if (!(await loadDaemonAutoStart())) return;
      const entry = process.argv[1];
      if (!entry) throw new Error("Cannot locate CLI entrypoint.");
      const { clearDaemonRegistry, readDaemonRegistry } =
        await import("@vykor/server");
      const registry = readDaemonRegistry();
      const probeOptions = {
        expectedVersion: VERSION,
        minimumStartedAt: statSync(entry).mtimeMs,
      };
      const status = registry
        ? await probeDaemonRegistry(registry, probeOptions)
        : "unreachable";
      if (status === "ready") return;
      if (registry && status === "stale") {
        terminateDaemonProcess(registry.pid);
        await stopDaemonProcess(registry.pid);
      }
      clearDaemonRegistry();
      const spawned = spawnDaemonProcess(entry, [serveCommand, ...serveArgs]);
      await waitForReadyDaemon(probeOptions, readDaemonRegistry, () => {
        if (spawned.failure()) throw daemonStartupError(spawned);
      });
    });

  cmd
    .command("status")
    .description("Show daemon status")
    .action(async () => {
      const { readDaemonRegistry } = await import("@vykor/server");
      console.log(
        `Automatic startup: ${(await loadDaemonAutoStart()) ? "enabled" : "disabled"}`,
      );
      const entry = process.argv[1];
      const service = entry ? createDaemonSystemService(entry) : undefined;
      const serviceStatus = service?.status();
      console.log(
        `System service: ${serviceStatus?.state ?? "unknown"}${serviceStatus ? ` (${serviceStatus.platform})` : ""}`,
      );
      const registry = readDaemonRegistry();
      if (!registry) {
        console.log("Daemon: stopped");
        return;
      }
      const probe = await probeDaemonRegistry(registry, {
        expectedVersion: VERSION,
        ...(entry ? { minimumStartedAt: statSync(entry).mtimeMs } : {}),
      });
      console.log(`Daemon: ${probe} (PID: ${registry.pid})`);
      console.log(`URL: ${daemonHealthUrl(registry.url)}`);
      console.log(`Store: ${registry.storePath}`);
      console.log(`Version: ${registry.version}`);
    });

  cmd
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      const { clearDaemonRegistry, readDaemonRegistry } =
        await import("@vykor/server");
      const entry = process.argv[1];
      const service = entry ? createDaemonSystemService(entry) : undefined;
      const registry = readDaemonRegistry();
      if (service?.isInstalled()) {
        service.stop();
        if (registry && daemonPidAlive(registry.pid)) {
          terminateDaemonProcess(registry.pid);
          await stopDaemonProcess(registry.pid);
        }
        if (registry)
          console.log(
            `Daemon system service stopped (last PID: ${registry.pid})`,
          );
        else console.log("Daemon system service stopped.");
        clearDaemonRegistry();
        return;
      }
      if (!registry) {
        console.log("Daemon is not running.");
        return;
      }
      if (daemonPidAlive(registry.pid)) {
        terminateDaemonProcess(registry.pid);
        console.log(`Daemon stopped (PID: ${registry.pid})`);
      } else {
        console.log(`Daemon registry was stale (PID: ${registry.pid})`);
      }
      clearDaemonRegistry();
    });

  return cmd;
}

async function waitForReadyDaemon(
  probeOptions: { expectedVersion: string; minimumStartedAt?: number },
  readRegistry: () => DaemonRegistry | undefined,
  checkFailure?: () => void,
): Promise<DaemonRegistry> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const registry = readRegistry();
    if (
      registry &&
      (await probeDaemonRegistry(registry, probeOptions)) === "ready"
    )
      return registry;
    checkFailure?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "The Vykor daemon did not become ready within 10 seconds",
  );
}
