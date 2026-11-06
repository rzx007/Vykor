import {
  reconcileDaemonSystemService,
  saveDaemonAutoStartPreference,
  shouldStartManagedDaemon,
  withDaemonControlLock,
  type DaemonAutoStartAction,
} from "@vykor/server/daemon-host";

import {
  createDaemonSystemService,
  type DaemonSystemService,
  type DaemonSystemServiceState,
} from "./daemon-system-service.js";

export type { DaemonAutoStartAction } from "@vykor/server/daemon-host";

export interface DaemonAutoStartReconciliation {
  service: DaemonSystemService;
  state: DaemonSystemServiceState;
  action: DaemonAutoStartAction;
}

export async function loadDaemonAutoStart(): Promise<boolean> {
  return await shouldStartManagedDaemon();
}

export async function saveDaemonAutoStart(autoStart: boolean): Promise<void> {
  await saveDaemonAutoStartPreference(autoStart);
}

export async function reconcileDaemonAutoStart(
  entry: string,
  autoStart: boolean,
  serveArgs?: string[],
): Promise<DaemonAutoStartReconciliation> {
  const service = createDaemonSystemService(entry, serveArgs);
  const state = service.status().state;
  if ((!autoStart && state === "not-installed") || (autoStart && state === "running"))
    return { service, state, action: "none" };
  return withDaemonControlLock(() => ({ service, ...reconcileDaemonSystemService(service, autoStart) }));
}
