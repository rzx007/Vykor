export {
  createDaemonAutoStartController,
  reconcileDaemonSystemService,
  reconcileDaemonSystemServiceForConnection,
  saveDaemonAutoStartPreference,
  shouldStartManagedDaemon,
  type DaemonAutoStartController,
  type DaemonAutoStartControllerOptions,
  type DaemonAutoStartSnapshot,
  type DaemonAutoStartAction,
} from "./auto-start-controller.js";
export * from "./system-service.js";
export {
  daemonPidAlive,
  forceKillDaemonProcess,
  stopDaemonProcess,
  stopRegisteredDaemon,
  terminateDaemonProcess,
  waitForProcessExit,
} from "./lifecycle.js";
export {
  clearDaemonRegistry,
  clearMatchingDaemonRegistry,
  createBearerToken,
  createDaemonRegistryEntry,
  getDaemonRegistryPath,
  getDefaultSessionStorePath,
  readDaemonRegistry,
  writeDaemonRegistry,
  type DaemonExecutionSurface,
  type DaemonRegistry,
} from "../daemon/paths.js";
export {
  startVykorDaemon,
  type VykorDaemonOptions,
} from "../daemon/default-daemon.js";

export { readOfficeFile, readOfficeBytes, MAX_OFFICE_BYTES } from "@vykor/services";
export { setHostResponseLocale } from "@vykor/agent-contracts";

export {
  parseBrowserBridgeEvent,
  type BrowserBridgeEvent,
} from "../application/browser-tools/browser-bridge-protocol.js";

export { isWindowsDaemonServiceEnabled, runRegisteredDaemon, type RegisteredDaemonControl } from "./registered-daemon.js";
export { readRegisteredDataLocation, readRegisteredDataSwitchResult } from "./data-location.js";
export { acquireRegistryLease, withDaemonControlLock } from "./registry-lease.js";
