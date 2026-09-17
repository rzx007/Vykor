import { loadSettings, saveSettings, type Settings } from "@openharness/core";

import {
  DaemonSystemService,
  type DaemonServiceInvocation,
  type DaemonSystemServiceState,
} from "./system-service.js";

export interface DaemonAutoStartSnapshot {
  configured: boolean;
  serviceState: DaemonSystemServiceState;
  enabled: boolean;
}

export type DaemonAutoStartAction =
  "none" | "installed" | "started" | "uninstalled";

export interface DaemonAutoStartController {
  snapshot(): Promise<DaemonAutoStartSnapshot>;
  enable(): Promise<DaemonAutoStartSnapshot>;
  disable(): Promise<DaemonAutoStartSnapshot>;
}

export interface DaemonAutoStartControllerOptions {
  invocation: DaemonServiceInvocation;
  loadSettings?: typeof loadSettings;
  saveSettings?: typeof saveSettings;
  createService?: () => Pick<
    DaemonSystemService,
    "status" | "statusAsync" | "install" | "start" | "uninstall"
  >;
}

export function createDaemonAutoStartController(
  options: DaemonAutoStartControllerOptions,
): DaemonAutoStartController {
  const read = options.loadSettings ?? loadSettings;
  const write = options.saveSettings ?? saveSettings;
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
      await write(withAutoStart(previous, true));
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
          restoreSettings: () => write(previous),
        });
      }
    },
    async disable() {
      const previous = await read();
      const service = createService();
      try {
        service.uninstall();
        await write(withAutoStart(previous, false));
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
          restoreSettings: () => write(previous),
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
  const settings = await loadSettings();
  await saveSettings(withAutoStart(settings, autoStart));
}

export function reconcileDaemonSystemService(
  service: Pick<
    DaemonSystemService,
    "status" | "install" | "start" | "uninstall"
  >,
  autoStart: boolean,
): { state: DaemonSystemServiceState; action: DaemonAutoStartAction } {
  const state = service.status().state;
  if (!autoStart) {
    if (state === "not-installed") return { state, action: "none" };
    service.uninstall();
    return { state: "not-installed", action: "uninstalled" };
  }
  if (state === "not-installed") {
    service.install();
    return { state: "running", action: "installed" };
  }
  if (state === "stopped") {
    service.start();
    return { state: "running", action: "started" };
  }
  if (state === "unknown") {
    service.install();
    return { state: "running", action: "installed" };
  }
  return { state, action: "none" };
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
  service: Pick<
    DaemonSystemService,
    "status" | "install" | "start" | "uninstall"
  >;
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
