import { loadSettings, updateSettings, type Settings } from "@vykor/host-config";

import { readDaemonRegistry } from "../daemon/paths.js";
import { daemonPidAlive } from "./lifecycle.js";
import { withDaemonControlLock } from "./registry-lease.js";
import {
  DaemonSystemService,
  type DaemonServiceInvocation,
  type DaemonSystemServiceState,
  type DaemonSystemServiceStatus,
} from "./system-service.js";

export interface DaemonAutoStartSnapshot {
  configured: boolean;
  serviceState: DaemonSystemServiceState;
  enabled: boolean;
}

export type DaemonAutoStartAction =
  "none" | "installed" | "started" | "uninstalled";

type ReconciledService = Pick<DaemonSystemService, "status" | "install" | "start" | "uninstall">;

export interface DaemonAutoStartController {
  snapshot(): Promise<DaemonAutoStartSnapshot>;
  enable(): Promise<DaemonAutoStartSnapshot>;
  disable(): Promise<DaemonAutoStartSnapshot>;
}

export interface DaemonAutoStartControllerOptions {
  invocation: DaemonServiceInvocation;
  loadSettings?: typeof loadSettings;
  updateSettings?: typeof updateSettings;
  createService?: () => Pick<
    DaemonSystemService,
    "status" | "statusAsync" | "install" | "start" | "uninstall"
  >;
}

export function createDaemonAutoStartController(
  options: DaemonAutoStartControllerOptions,
): DaemonAutoStartController {
  const read = options.loadSettings ?? loadSettings;
  const write = options.updateSettings ?? updateSettings;
  const createService =
    options.createService ??
    (() => new DaemonSystemService({ invocation: options.invocation }));

  const snapshot = async (): Promise<DaemonAutoStartSnapshot> => {
    const configured = (await read()).daemon?.autoStart ?? false;
    const serviceState = (await createService().statusAsync()).state;
    return {
      configured,
      serviceState,
      enabled: configured && serviceState === "running",
    };
  };

  return {
    snapshot,
    async enable() {
      const previous = await read();
      await write((settings) => withAutoStart(settings, true));
      const service = createService();
      try {
        service.install();
        const result = await snapshot();
        if (!result.enabled) {
          throw new Error(
            "Daemon system service did not reach an enabled state",
          );
        }
        return result;
      } catch (error) {
        throw await recoverAutoStartFailure({
          cause: error,
          restoreConfigured: previous.daemon?.autoStart ?? false,
          service,
          restoreSettings: async () => {
            await write((settings) =>
              withAutoStart(settings, previous.daemon?.autoStart ?? false),
            );
          },
        });
      }
    },
    async disable() {
      const previous = await read();
      const service = createService();
      try {
        service.uninstall();
        await write((settings) => withAutoStart(settings, false));
        const result = await snapshot();
        if (result.configured || result.serviceState !== "not-installed") {
          throw new Error(
            "Daemon system service did not reach a disabled state",
          );
        }
        return result;
      } catch (error) {
        throw await recoverAutoStartFailure({
          cause: error,
          restoreConfigured: previous.daemon?.autoStart ?? false,
          service,
          restoreSettings: async () => {
            await write((settings) =>
              withAutoStart(settings, previous.daemon?.autoStart ?? false),
            );
          },
        });
      }
    },
  };
}

export async function shouldStartManagedDaemon(): Promise<boolean> {
  return (await loadSettings()).daemon?.autoStart ?? false;
}

export async function saveDaemonAutoStartPreference(
  autoStart: boolean,
): Promise<void> {
  await updateSettings((settings) => withAutoStart(settings, autoStart));
}

export function reconcileDaemonSystemService(
  service: ReconciledService,
  autoStart: boolean,
): { state: DaemonSystemServiceState; action: DaemonAutoStartAction } {
  const status = service.status();
  return applyServiceAction(service, status, serviceAction(status, autoStart));
}

/** Recheck the setting and service state under the startup lock before making changes. */
export async function reconcileDaemonSystemServiceForConnection(
  service: ReconciledService,
  autoStartOverride?: boolean,
): Promise<{ autoStart: boolean; state: DaemonSystemServiceState; action: DaemonAutoStartAction }> {
  const readAutoStart = async () => autoStartOverride ?? await shouldStartManagedDaemon();
  const autoStart = await readAutoStart();
  const status = service.status();
  if (serviceAction(status, autoStart, true) === "none") {
    return { autoStart, state: status.state, action: "none" };
  }
  return withDaemonControlLock(async () => {
    const currentAutoStart = await readAutoStart();
    const currentStatus = service.status();
    const action = serviceAction(currentStatus, currentAutoStart, true);
    return { autoStart: currentAutoStart, ...applyServiceAction(service, currentStatus, action) };
  });
}

function serviceAction(
  status: DaemonSystemServiceStatus,
  autoStart: boolean,
  forConnection = false,
): DaemonAutoStartAction {
  const { state } = status;
  if (!autoStart) {
    return state === "not-installed" ? "none" : "uninstalled";
  }
  if (forConnection && status.platform === "linux" && status.detail === "activating") {
    return "none";
  }
  if (state === "not-installed" || state === "unknown") return "installed";
  if (state === "stopped") return "started";
  // An enabled Windows task reports Ready even when its detached daemon is absent.
  if (forConnection && status.platform === "win32" && status.detail === "ready" &&
    !daemonPidAlive(readDaemonRegistry()?.pid ?? 0)) {
    return "started";
  }
  return "none";
}

function applyServiceAction(
  service: ReconciledService,
  status: DaemonSystemServiceStatus,
  action: DaemonAutoStartAction,
): { state: DaemonSystemServiceState; action: DaemonAutoStartAction } {
  switch (action) {
    case "uninstalled":
      service.uninstall();
      return { state: "not-installed", action };
    case "installed":
      service.install();
      return { state: "running", action };
    case "started":
      service.start();
      return { state: "running", action };
    case "none":
      return { state: status.state, action };
  }
}

function withAutoStart(settings: Settings, autoStart: boolean): Settings {
  return {
    ...settings,
    daemon: { ...settings.daemon, autoStart },
  };
}

async function recoverAutoStartFailure(input: {
  cause: unknown;
  restoreConfigured: boolean;
  service: ReconciledService;
  restoreSettings(): Promise<void>;
}): Promise<unknown> {
  const recoveryErrors: unknown[] = [];
  try {
    reconcileDaemonSystemService(input.service, input.restoreConfigured);
  } catch (error) {
    recoveryErrors.push(error);
  }
  try {
    await input.restoreSettings();
  } catch (error) {
    recoveryErrors.push(error);
  }
  if (recoveryErrors.length === 0) return input.cause;
  return new AggregateError(
    [input.cause, ...recoveryErrors],
    `Daemon auto-start operation and ${recoveryErrors.length} recovery step(s) failed`,
  );
}
