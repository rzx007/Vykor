import {
  reconcileDaemonSystemService,
  saveDaemonAutoStartPreference,
  shouldStartManagedDaemon,
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

export function reconcileDaemonAutoStart(
  entry: string,
  autoStart: boolean,
  serveArgs?: string[],
): DaemonAutoStartReconciliation {
  const service = createDaemonSystemService(entry, serveArgs);
  return { service, ...reconcileDaemonSystemService(service, autoStart) };
}
