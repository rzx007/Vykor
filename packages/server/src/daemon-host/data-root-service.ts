import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveManagedRealPath } from "@vykor/host-config/paths";
import { DaemonSystemService, type DaemonServiceSnapshot } from "./system-service.js";
import { fileDigest, samePath, saveMigrationJournal, writePrivateJson, type MigrationJournal } from "./data-root-migration-journal.js";

export interface MigrationSystemService {
  backupPath: string;
  digest: string;
  resumeRequired?: boolean;
  state: "captured" | "pause-intent" | "paused" | "install-intent" | "installed" | "restore-intent" | "restored";
}
export function validateMigrationServiceJournal(j: MigrationJournal): void {
  const service = j.systemService;
  if (service?.resumeRequired !== undefined && typeof service.resumeRequired !== "boolean") throw new Error("Invalid migration service resume state");
  if (service && (!samePath(service.backupPath, `${j.journalPath}.service.json`) || !/^[a-f0-9]{64}$/.test(service.digest)
    || !["captured", "pause-intent", "paused", "install-intent", "installed", "restore-intent", "restored"].includes(service.state))) throw new Error("Invalid migration service backup scope");
}
const sourceLogs = (j: MigrationJournal, logs: string) => [{ path: join(j.sourceRoot, "data") }, ...(j.preparation?.runtimeDirectories ?? [])].some(runtime => samePath(logs, join(runtime.path, "logs")));
async function backup(j: MigrationJournal): Promise<DaemonServiceSnapshot> {
  validateMigrationServiceJournal(j);
  const record = j.systemService;
  if (!record) throw new Error("Migration service not captured");
  const metadata = await lstat(record.backupPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !samePath(await resolveManagedRealPath(record.backupPath), record.backupPath)
    || await fileDigest(record.backupPath) !== record.digest) throw new Error("Migration service backup changed");
  const saved = JSON.parse(await readFile(record.backupPath, "utf8")) as DaemonServiceSnapshot;
  if (saved.version !== 1 || !saved.options || !["win32", "darwin", "linux"].includes(saved.options.platform ?? "")
    || !saved.options.homeDir || !samePath(saved.options.homeDir, j.homeDir) || !saved.options.logsDir
    || !sourceLogs(j, saved.options.logsDir) || typeof saved.installed !== "boolean" || typeof saved.wasRunning !== "boolean" || typeof saved.wasEnabled !== "boolean") throw new Error("Invalid migration service backup");
  return saved;
}
export async function captureMigrationService(j: MigrationJournal, service: DaemonSystemService): Promise<void> {
  if (j.systemService) throw new Error("Migration service was already captured");
  const snapshot = service.snapshotForMigration();
  if (!snapshot.options.homeDir || !samePath(snapshot.options.homeDir, j.homeDir) || !snapshot.options.logsDir
    || !sourceLogs(j, snapshot.options.logsDir)) throw new Error("System service does not belong to this migration root/home");
  const backupPath = `${j.journalPath}.service.json`;
  await writePrivateJson(backupPath, snapshot);
  j.systemService = { backupPath, digest: await fileDigest(backupPath), state: "captured" };
  j.operation = "service-capture"; await saveMigrationJournal(j);
}
export async function pauseMigrationService(j: MigrationJournal, service: DaemonSystemService): Promise<void> {
  await backup(j);
  j.systemService!.state = "pause-intent"; j.systemService!.resumeRequired = true; j.operation = "service-pause"; await saveMigrationJournal(j);
  service.pauseForMigration();
  j.systemService!.state = "paused"; await saveMigrationJournal(j);
}
export async function stageMigrationService(j: MigrationJournal, adapter?: DaemonSystemService): Promise<void> {
  if (!j.systemService) return;
  const saved = await backup(j);
  if (saved.installed) (adapter ?? new DaemonSystemService(saved.options)).forDataRoot(j.targetRoot).stageMigrationFiles(j.stagingRoot, j.targetRoot);
}
export async function installMigrationService(j: MigrationJournal, adapter?: DaemonSystemService): Promise<void> {
  if (!j.systemService) return;
  const saved = await backup(j);
  if (j.systemService.state !== "paused") throw new Error("Migration service is not paused");
  j.systemService.state = "install-intent"; j.operation = "service-install"; await saveMigrationJournal(j);
  if (saved.installed) (adapter ?? new DaemonSystemService(saved.options)).forDataRoot(j.targetRoot).install({ start: false });
  j.systemService.state = "installed"; await saveMigrationJournal(j);
}
/** Old roots/Git have been restored; keep service paused until the selector is restored too. */
export async function restoreMigrationService(j: MigrationJournal, adapter?: DaemonSystemService): Promise<void> {
  if (!j.systemService || j.systemService.state === "restored") return;
  const saved = await backup(j);
  if (saved.installed && j.systemService.state !== "captured") {
    j.systemService.state = "restore-intent"; j.operation = "service-restore"; await saveMigrationJournal(j);
    const service = adapter ?? new DaemonSystemService(saved.options);
    service.restoreMigrationSnapshot(saved);
  }
  j.systemService.state = "restored"; await saveMigrationJournal(j);
}

export async function resumeMigrationService(j: MigrationJournal, adapter?: DaemonSystemService, target = false): Promise<void> {
  if (!j.systemService || !target && !j.systemService.resumeRequired) return;
  const saved = await backup(j), service = adapter ?? new DaemonSystemService(saved.options);
  (target ? service.forDataRoot(j.targetRoot) : service).resumeMigrationSnapshot(saved);
}
