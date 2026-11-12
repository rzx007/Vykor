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
export { BROWSER_BRIDGE_MAX_RESULT_BODY_BYTES, BROWSER_BRIDGE_RESULT_TOO_LARGE } from "../application/browser-tools/browser-bridge.js";

export { isWindowsDaemonServiceEnabled, runRegisteredDaemon, type RegisteredDaemonControl } from "./registered-daemon.js";
export { readRegisteredDataLocation, readRegisteredDataSwitchResult } from "./data-location.js";
export { acquireRegistryLease, withDaemonControlLock } from "./registry-lease.js";
export { inspectDataRootMigration, type DataRootMigrationRequest, type DataRootMigrationPreview, type MigrationBlocker, type MigrationSourceEntry } from "./data-root-sources.js";
export { relocateDataRootFiles, relocateProjectStorageKeys, type DataRootFileRelocationInput } from "./data-root-file-relocation.js";
export { migrateDataRoot, recoverDataRootMigration, commitDataRootMigration, markDataRootMigrationWritersReleased, type DataRootMigrationCoordination, type DataRootMigrationResult, type MigrationPhase } from "./data-root-migration.js";
