import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { Command, Option } from "commander";

import { isLoopbackHost, probeDaemonRegistry, verifyDaemonProcess } from "../daemon-lifecycle.js";
import {
  acquireRegistryLease,
  clearMatchingDaemonRegistry,
  daemonPidAlive,
  getDaemonRegistryPath,
  isWindowsDaemonServiceEnabled,
  runRegisteredDaemon,
  stopRegisteredDaemon,
  withDaemonControlLock,
  type DaemonRegistry,
} from "@vykor/server/daemon-host";
import {
  loadDaemonAutoStart,
  reconcileDaemonAutoStart,
} from "../daemon-auto-start.js";
import { daemonStartupError, spawnDaemonProcess } from "../daemon-process.js";
import {
  createCliDaemonAutoStartController,
  createDaemonSystemService,
} from "../daemon-system-service.js";
import { ensureLocalDaemon } from "../ensure-daemon.js";
import { VERSION } from "../version.js";

export { isLoopbackHost } from "../daemon-lifecycle.js";

interface ServeOptions {
  host?: string;
  port?: number;
  token?: string;
  allowOrigin?: string[];
  storePath?: string;
  register?: boolean;
  supervised?: boolean;
}

export function assertSafeDaemonBinding(
  options: Pick<ServeOptions, "host" | "token">,
): void {
  if (!isLoopbackHost(options.host) && !options.token) {
    throw new Error("A non-loopback daemon requires an explicit --token");
  }
}

function legacyDesktopDataLocation(): string | undefined {
  if (process.env.VYKOR_CONFIG_DIR || process.env.VYKOR_DATA_DIR) return undefined;
  const root = process.platform === "win32"
    ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(root, "Vykor", "runtime-data-location.json");
}

export function daemonHealthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/health`;
}

async function runServe(options: ServeOptions): Promise<void> {
  const { createBearerToken, createDaemonRegistryEntry, readDaemonRegistry, startVykorDaemon, writeDaemonRegistry } =
    await import("@vykor/server");

  assertSafeDaemonBinding(options);
  const shouldStart = options.register && options.supervised && process.platform === "win32"
    ? isWindowsDaemonServiceEnabled : undefined;
  if (options.register && isLoopbackHost(options.host) && !options.storePath) {
    await runRegisteredDaemon({
      launcher: "cli", version: VERSION, supervised: options.supervised,
      host: options.host, port: options.port, allowedOrigins: options.allowOrigin,
      legacyDataLocationPath: legacyDesktopDataLocation(),
      initialToken: options.token,
      shouldStart,
    });
    return;
  }
  const registryPath = getDaemonRegistryPath();
  const shutdown = new AbortController();
  if (options.register) await mkdir(dirname(registryPath), { recursive: true });
  const release = options.register
    ? await acquireRegistryLease(registryPath, "owner", error => shutdown.abort(error))
    : undefined;
  try {
    const existing = options.register ? readDaemonRegistry(registryPath) : undefined;
    if (existing && daemonPidAlive(existing.pid))
      throw new Error("A live daemon already owns the local registry.");
    if (shouldStart && !await shouldStart()) return;
    const token = options.token ?? createBearerToken();
    const { server, listen } = await startVykorDaemon({
      host: options.host, port: options.port, token,
      allowedOrigins: options.allowOrigin, storePath: options.storePath, version: VERSION,
    });
    let published: DaemonRegistry | undefined;
    const stop = () => shutdown.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      shutdown.signal.throwIfAborted();
      if (shouldStart && !await shouldStart()) return;
      console.log(`[daemon] listening ${listen.url}`);
      if (options.register) {
        const registry = createDaemonRegistryEntry({
          url: listen.url, pid: process.pid, token, storePath: server.store.path,
          version: VERSION, executionSurface: "cli_advanced",
        });
        writeDaemonRegistry(registry, registryPath);
        published = registry;
        console.log("[daemon] registry written");
      }
      await new Promise<void>(resolve => {
        if (shutdown.signal.aborted) resolve();
        else shutdown.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      try { await server.close(); }
      finally { if (published) clearMatchingDaemonRegistry(published, registryPath); }
    }
  } finally {
    if (!(shutdown.signal.reason instanceof Error) || shutdown.signal.reason.name === "AbortError")
      await release?.();
  }
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
    .addOption(new Option("--supervised").hideHelp())
    .action(async (options: ServeOptions) => {
      await runServe(options);
    });
}

function registeredServeArgs(options: ServeOptions): string[] {
  const args = ["serve", "--register", "--host", options.host ?? "127.0.0.1"];
  if (options.port !== undefined) args.push("--port", String(options.port));
  if (options.token) args.push("--token", options.token);
  for (const origin of options.allowOrigin ?? []) args.push("--allow-origin", origin);
  if (options.storePath) args.push("--store-path", options.storePath);
  return args;
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
      const { readDaemonRegistry } =
        await import("@vykor/server");
      const entry = process.argv[1];
      if (!entry) {
        console.error("Cannot locate CLI entrypoint.");
        process.exit(1);
      }
      const args = registeredServeArgs(options);
      if (isLoopbackHost(options.host)) {
        const endpoint = await ensureLocalDaemon({ cliPath: entry, serveArgs: args });
        console.log(`Daemon running at ${endpoint.url} (PID: ${endpoint.pid})`);
        return;
      }

      const { autoStart } = await reconcileDaemonAutoStart(entry, undefined, args);
      const probeOptions = { expectedVersion: VERSION, minimumStartedAt: statSync(entry).mtimeMs };
      const existing = readDaemonRegistry();
      if (existing && await probeDaemonRegistry(existing, probeOptions) === "ready") {
        console.log(`Daemon already running at ${existing.url} (PID: ${existing.pid})`);
        return;
      }
      if (existing && daemonPidAlive(existing.pid))
        throw new Error("Registered daemon is unavailable. Stop it explicitly before starting another.");
      if (autoStart) {
        const registry = await waitForReadyDaemon(probeOptions, readDaemonRegistry);
        console.log(`Daemon started by the system service at ${registry.url} (PID: ${registry.pid})`);
        return;
      }

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
      const { readDaemonRegistry } =
        await import("@vykor/server");
      const args = registeredServeArgs(options);

      await withDaemonControlLock(async () => {
        await createCliDaemonAutoStartController(entry, args).enable();
      });
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
      await withDaemonControlLock(async () => {
        await createCliDaemonAutoStartController(entry).disable();
        await stopRegisteredDaemon(verifyDaemonProcess);
      });
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
      const { readDaemonRegistry } =
        await import("@vykor/server");
      const registry = readDaemonRegistry();
      const probeOptions = {
        expectedVersion: VERSION,
        minimumStartedAt: statSync(entry).mtimeMs,
      };
      if (registry && daemonPidAlive(registry.pid)) return;
      const spawned = spawnDaemonProcess(entry, [serveCommand, ...serveArgs, "--supervised"]);
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
      const entry = process.argv[1];
      const service = entry ? createDaemonSystemService(entry) : undefined;
      await withDaemonControlLock(async () => {
        if (service?.isInstalled()) service.stop();
        const registry = await stopRegisteredDaemon(verifyDaemonProcess);
        if (registry) console.log(`Daemon stopped (PID: ${registry.pid})`);
        else console.log("Daemon is not running.");
      });
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
