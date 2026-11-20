import {
  reconcileDaemonSystemServiceForConnection,
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
  autoStart: boolean;
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
  autoStart?: boolean,
  serveArgs?: string[],
): Promise<DaemonAutoStartReconciliation> {
  const service = createDaemonSystemService(entry, serveArgs);
  return { service, ...await reconcileDaemonSystemServiceForConnection(service, autoStart) };
}
