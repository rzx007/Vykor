import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getDataDir } from "@vykor/host-config";
import { startVykorDaemon, type VykorDaemonOptions } from "../daemon/default-daemon.js";
import {
  clearMatchingDaemonRegistry,
  createBearerToken,
  createDaemonRegistryEntry,
  readDaemonRegistry,
  writeDaemonRegistry,
  type DaemonRegistry,
} from "../daemon/paths.js";
import { ApplicationError } from "../shared/application-error.js";
import { shouldStartManagedDaemon } from "./auto-start-controller.js";
import {
  dataLocationFile,
  defaultDataLocation,
  readDataLocationState,
  readLegacyDataLocation,
  saveDataLocationState,
  validateSwitchLocation,
  type DataLocationState,
  type DataSwitchResult,
  type RegisteredDataLocation,
} from "./data-location.js";
import { daemonPidAlive } from "./lifecycle.js";
import { acquireRegistryLease, daemonControlBusy } from "./registry-lease.js";
import { DaemonSystemService } from "./system-service.js";

interface PreparedSwitch {
  close(): Promise<void>;
  release(): void;
}

type PrepareSwitch = () => Promise<PreparedSwitch>;

export interface RegisteredDaemonControl {
  requestSwitch(
    target: RegisteredDataLocation & { id?: string },
    prepare: PrepareSwitch,
  ): Promise<{ id: string }>;
  getSwitchResult(id: string): DataSwitchResult | undefined;
}

type RegisteredRuntime = {
  listen: { url: string };
  server: {
    store: { path: string };
    close(): Promise<void>;
    application: { activateBackgroundWork?(): void };
  };
};

type OpenedRuntime = RegisteredRuntime & { token: string };

type RegisteredRuntimeOptions = VykorDaemonOptions & {
  deferBackgroundActivation: boolean;
};

export interface RegisteredDaemonOptions extends Pick<
  VykorDaemonOptions,
  "allowedOrigins" | "host" | "outsideProjectWorkspaceRoot" | "port"
> {
  launcher: "desktop" | "cli";
  version: string;
  initialToken?: string;
  supervised?: boolean;
  baseDataDirectory?: string;
  legacyDataLocationPath?: string;
  signal?: AbortSignal;
  canSwitchData?: () => Promise<boolean>;
  start?: (options: RegisteredRuntimeOptions) => Promise<RegisteredRuntime>;
}

/** Holds the fixed registry for the entire lifetime of an independent local daemon. */
export async function runRegisteredDaemon(options: RegisteredDaemonOptions): Promise<void> {
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase())) {
    throw new Error("The shared registered daemon requires a loopback listener.");
  }
  if (options.initialToken !== undefined && !options.initialToken.trim()) {
    throw new Error("The shared registered daemon requires a non-empty token.");
  }
  const base = resolve(options.baseDataDirectory ?? getDataDir());
  const registryPath = join(base, "daemon", "registry.json");
  const statePath = dataLocationFile(base);
  const start = options.start ?? startVykorDaemon;
  let current: OpenedRuntime | undefined;
  let published: DaemonRegistry | undefined;
  let state: DataLocationState;
  let switching = false;
  let transition: Promise<void> | undefined;
  let stopping = false;
  let dataDirectoryChanged = false;
  let initialDataDirectory: string | undefined;
  let ownerError: Error | undefined;
  let finish!: (error?: Error) => void;
  const stopped = new Promise<Error | undefined>((resolveStop) => {
    finish = (error) => {
      stopping = true;
      resolveStop(error);
    };
  });
  const stop = () => finish();
  const control: RegisteredDaemonControl = {
    getSwitchResult: (id) => state.result?.id === id ? state.result : undefined,
    requestSwitch,
  };

  if (options.signal?.aborted) return;
  if (options.signal) options.signal.addEventListener("abort", stop, { once: true });
  else {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
  let releaseOwner: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(registryPath), { recursive: true });
    releaseOwner = await waitForOwnership();
    if (!releaseOwner || stopping) return;

    const saved = await readDataLocationState(statePath);
    const legacy = !saved ? await readLegacyDataLocation(options.legacyDataLocationPath) : undefined;
    state = saved ?? { version: 1, location: legacy ?? defaultDataLocation(base) };
    if (state.result?.status === "pending") {
      state = { ...state, result: { id: state.result.id, status: "interrupted" } };
      await saveDataLocationState(statePath, state);
    } else if (legacy) {
      await saveDataLocationState(statePath, state);
    }

    if (!stopping) current = await open(state.location, options.initialToken);
    if (current && !stopping) publish(current);
    const error = await stopped;
    if (error) throw error;
  } finally {
    options.signal?.removeEventListener("abort", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      await transition;
      await current?.server.close();
    } finally {
      try {
        if (published) clearMatchingDaemonRegistry(published, registryPath);
      } finally {
        if (dataDirectoryChanged) {
          if (initialDataDirectory === undefined) delete process.env.VYKOR_DATA_DIR;
          else process.env.VYKOR_DATA_DIR = initialDataDirectory;
        }
        if (!ownerError) await releaseOwner?.();
      }
    }
  }

  async function waitForOwnership(): Promise<(() => Promise<void>) | undefined> {
    const retryUntil = Date.now() + 12_000;
    while (!stopping) {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquireRegistryLease(registryPath, "owner", (error) => {
          ownerError = error;
          finish(error);
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
        if (!options.supervised && (liveRegistryPid() !== undefined || Date.now() >= retryUntil)) throw error;
      }
      if (release) {
        try {
          const livePid = liveRegistryPid();
          if (livePid === undefined) return release;
          if (!options.supervised) throw new Error(`Registry is still owned by daemon process ${livePid}.`);
        } catch (error) {
          await release();
          throw error;
        }
        await release();
      }
      await sleep(500);
    }
  }

  function liveRegistryPid(): number | undefined {
    const existing = readDaemonRegistry(registryPath);
    if (existing === undefined) return undefined;
    if (!existing || !Number.isSafeInteger(existing.pid) || existing.pid <= 0) {
      throw new Error(`Invalid daemon registry: ${registryPath}`);
    }
    return daemonPidAlive(existing.pid) ? existing.pid : undefined;
  }

  async function open(location: RegisteredDataLocation, token = createBearerToken()): Promise<OpenedRuntime> {
    if (ownerError) throw ownerError;
    if (!dataDirectoryChanged) initialDataDirectory = process.env.VYKOR_DATA_DIR;
    dataDirectoryChanged = true;
    process.env.VYKOR_DATA_DIR = location.directory;
    const runtime = await start({
      host,
      port: options.port ?? 0,
      token,
      storePath: location.storePath,
      version: options.version,
      executionSurface: "desktop_managed",
      enableDesktopBrowser: true,
      ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
      ...(options.outsideProjectWorkspaceRoot
        ? { outsideProjectWorkspaceRoot: options.outsideProjectWorkspaceRoot } : {}),
      registeredDaemonControl: control,
      deferBackgroundActivation: true,
    });
    if (resolve(runtime.server.store.path) !== location.storePath) {
      await runtime.server.close();
      throw new Error("后台打开的数据库与选择的位置不一致。");
    }
    return { ...runtime, token };
  }

  function publish(runtime: OpenedRuntime): void {
    if (ownerError) throw ownerError;
    const entry = createDaemonRegistryEntry({
      url: runtime.listen.url,
      pid: process.pid,
      token: runtime.token,
      storePath: runtime.server.store.path,
      version: options.version,
      executionSurface: options.launcher === "desktop" ? "desktop_managed" : "cli_advanced",
      launcher: options.launcher,
      supervised: options.supervised ?? false,
    });
    writeDaemonRegistry(entry, registryPath);
    published = entry;
    if (options.launcher === "cli") console.log(`[daemon] listening ${entry.url}`);
    runtime.server.application.activateBackgroundWork?.();
  }

  async function requestSwitch(
    target: RegisteredDataLocation & { id?: string },
    prepare: PrepareSwitch,
  ): Promise<{ id: string }> {
    const id = target.id ?? randomUUID();
    if (!/^[\w-]{1,80}$/.test(id)) throw new ApplicationError(400, "数据切换标识无效。");
    if (state.result?.id === id) return { id };
    if (stopping || switching) throw new ApplicationError(409, "后台服务正在关闭或切换数据。");
    switching = true;
    let releaseController: (() => Promise<void>) | undefined;
    let controllerError: Error | undefined;
    let prepared: PreparedSwitch | undefined;
    try {
      releaseController = await acquireRegistryLease(registryPath, "control", (error) => {
        controllerError = error;
        finish(error);
      });
      // The Windows watchdog's detached worker can outlive its uninstalled service.
      if (!await (options.canSwitchData ?? canSwitchData)()) {
        throw new ApplicationError(409, "请先关闭系统常驻服务，再切换数据目录。");
      }
      const next = await validateSwitchLocation(target);
      prepared = await prepare();
      if (stopping) throw new ApplicationError(409, "后台服务正在关闭。");
      const pending: DataLocationState = { ...state, result: { id, status: "pending" } };
      await saveDataLocationState(statePath, pending);
      state = pending;
      if (stopping) throw new ApplicationError(409, "后台服务正在关闭。");
      const shutdown = prepared;
      const release = releaseController;
      transition = new Promise<void>((resolveTransition) => setImmediate(resolveTransition))
        .then(() => switchLocation(id, next, shutdown, () => controllerError))
        .catch((error: unknown) => finish(asError(error)))
        .finally(async () => {
          try {
            if (!controllerError) await release();
          } finally {
            switching = false;
          }
        })
        .catch((error: unknown) => finish(asError(error)));
      return { id };
    } catch (error) {
      prepared?.release();
      switching = false;
      if (!controllerError) await releaseController?.();
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw daemonControlBusy();
      throw error;
    }
  }

  async function switchLocation(
    id: string,
    target: RegisteredDataLocation,
    prepared: PreparedSwitch,
    getControllerError: () => Error | undefined,
  ): Promise<void> {
    const previous = state.location;
    const oldRuntime = current;
    current = undefined;
    try {
      try {
        await prepared.close();
      } finally {
        prepared.release();
        await oldRuntime?.server.close();
      }
      current = await open(target);
      const leaseError = getControllerError() ?? ownerError;
      if (leaseError) throw leaseError;
      const committed: DataLocationState = { version: 1, location: target, result: { id, status: "succeeded" } };
      await saveDataLocationState(statePath, committed);
      state = committed;
    } catch (error) {
      if (getControllerError() || ownerError) throw error;
      const failure = asError(error);
      try {
        await current?.server.close();
        current = await open(previous);
      } catch (rollbackError) {
        state = {
          version: 1,
          location: previous,
          result: { id, status: "rollback_failed", error: failure.message, rollbackError: asError(rollbackError).message },
        };
        await saveDataLocationState(statePath, state).catch(() => {});
        throw new AggregateError([failure, rollbackError], "切换数据目录失败，恢复旧位置也失败。");
      }
      state = { version: 1, location: previous, result: { id, status: "failed", error: failure.message } };
      try {
        await saveDataLocationState(statePath, state);
      } catch (persistenceError) {
        state.result!.error += `；无法保存切换结果：${asError(persistenceError).message}`;
      }
    }
    // A failure here leaves the selected location committed for the next launch.
    publish(current);
  }
}

async function canSwitchData(): Promise<boolean> {
  if (await shouldStartManagedDaemon()) return false;
  const systemService = new DaemonSystemService({
    invocation: { command: process.execPath, args: [], cwd: process.cwd() },
  });
  return (await systemService.statusAsync()).state === "not-installed";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
