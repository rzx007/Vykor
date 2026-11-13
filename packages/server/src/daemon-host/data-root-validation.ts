import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, rename, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { securePrivateDirectory, securePrivateFile } from "@vykor/host-config";
import { resolveManagedRealPath, resolveUserDataPaths } from "@vykor/host-config/paths";
import { digestDataRootCopy } from "@vykor/services/data-root-relocation";
import { requestDaemon } from "../http/daemon-request.js";
import { fileDigest, info, samePath, saveMigrationJournal, treeIdentity, type MigrationJournal, type TreeIdentity } from "./data-root-migration-journal.js";

export interface MigrationValidationInvocation { command: string; args: string[]; timeoutMs?: number }
export interface MigrationValidation {
  backupPath: string; digest: string; logicalDigest: string; mode: number; mtimeMs: number; atimeMs: number;
  untouchedTree: TreeIdentity; pid?: number; state: "prepared" | "started" | "closed" | "restored";
}
const equal = (a: TreeIdentity, b: TreeIdentity) => a.identity === b.identity && a.digest === b.digest && a.files === b.files && a.bytes === b.bytes;
const database = (j: MigrationJournal) => resolveUserDataPaths(j.targetRoot).sessionsDatabasePath;
const files = (j: MigrationJournal) => [database(j), `${database(j)}-wal`, `${database(j)}-shm`];
export function validateMigrationValidationJournal(j: MigrationJournal): void {
  const v = j.validation;
  if (v && (!samePath(v.backupPath, join(`${j.journalPath}.validation`, "database.db")) || !/^[a-f0-9]{64}$/.test(v.digest) || !/^[a-f0-9]{64}$/.test(v.logicalDigest)
    || !["prepared", "started", "closed", "restored"].includes(v.state) || !Number.isFinite(v.mtimeMs) || !Number.isFinite(v.atimeMs)
    || !Number.isInteger(v.mode) || v.mode < 0 || v.mode > 0o777 || !v.untouchedTree || v.pid !== undefined && (!Number.isSafeInteger(v.pid) || v.pid <= 0))) throw new Error("Invalid migration validation record");
}

/** Restores exact bytes only after all business rows and all other files prove equivalent. */
export async function restoreValidationDatabase(j: MigrationJournal): Promise<void> {
  const v = j.validation; if (!v || v.state === "restored") return;
  validateMigrationValidationJournal(j);
  if ((await readdir(dirname(v.backupPath))).some(name => name !== "database.db" && name !== "restore.db")) throw new Error("Unknown validation backup contents");
  if (v.pid) {
    let alive = true; try { process.kill(v.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (alive) throw new Error("Migration validation process is still alive");
  }
  const metadata = await lstat(v.backupPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !samePath(await resolveManagedRealPath(v.backupPath), v.backupPath)
    || await fileDigest(v.backupPath) !== v.digest) throw new Error("Migration validation backup changed");
  for (const file of files(j)) { const value = await info(file); if (value && (!value.isFile() || value.isSymbolicLink() || !samePath(await resolveManagedRealPath(file), file))) throw new Error("Invalid validation database file"); }
  if (!equal(await treeIdentity(j.targetRoot, undefined, files(j)), v.untouchedTree)) throw new Error("Migration validation changed unknown files");
  if (digestDataRootCopy(database(j), { stoppedValidationPid: v.pid }) !== v.logicalDigest) throw new Error("Migration validation changed business data");
  const replacement = join(dirname(v.backupPath), "restore.db");
  const previous = await info(replacement);
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || !samePath(await resolveManagedRealPath(replacement), replacement) || await fileDigest(replacement) !== v.digest)) throw new Error("Unknown validation replacement file");
  if (!previous) await copyFile(v.backupPath, replacement, constants.COPYFILE_EXCL);
  await chmod(replacement, v.mode); await utimes(replacement, new Date(v.atimeMs), new Date(v.mtimeMs));
  await rename(replacement, database(j));
  for (const file of files(j).slice(1)) await rm(file, { force: true });
  if (!j.stagedTree || !equal(await treeIdentity(j.targetRoot), j.stagedTree)) throw new Error("Validation did not restore the verified tree");
  v.state = "restored"; await saveMigrationJournal(j);
}

export async function validateMigrationInNewProcess(j: MigrationJournal, invocation: MigrationValidationInvocation): Promise<{ pid: number; storePath: string }> {
  if (j.validation || !j.stagedTree || !equal(await treeIdentity(j.targetRoot), j.stagedTree)) throw new Error("Validation requires the original verified target");
  for (const file of files(j).slice(1)) if (await info(file)) throw new Error("Validation requires a closed database");
  const path = database(j), metadata = await lstat(path), backupDirectory = `${j.journalPath}.validation`, backupPath = join(backupDirectory, "database.db");
  await mkdir(backupDirectory, { mode: 0o700 }); await securePrivateDirectory(backupDirectory);
  const handle = await open(backupPath, "wx", 0o600); await handle.close(); await securePrivateFile(backupPath);
  await copyFile(path, backupPath); await securePrivateFile(backupPath);
  const saved = await open(backupPath, "r+"); try { await saved.sync(); } finally { await saved.close(); }
  const logicalDigest = digestDataRootCopy(backupPath);
  // The readonly inspector is now closed; its own SQLite sidecars are not part of the backup.
  await rm(`${backupPath}-wal`, { force: true }); await rm(`${backupPath}-shm`, { force: true });
  const validation: MigrationValidation = { backupPath, digest: await fileDigest(backupPath), logicalDigest, mode: metadata.mode & 0o777,
    atimeMs: metadata.atimeMs, mtimeMs: metadata.mtimeMs, untouchedTree: await treeIdentity(j.targetRoot, undefined, files(j)), state: "prepared" };
  if (await fileDigest(path) !== validation.digest || !equal(await treeIdentity(j.targetRoot), j.stagedTree)) throw new Error("Validation baseline changed during backup");
  j.validation = validation;
  j.operation = "validate-instance"; await saveMigrationJournal(j);
  const child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    env: { ...process.env, HOME: j.homeDir, USERPROFILE: j.homeDir, VYKOR_CONFIG_DIR: j.targetRoot, VYKOR_DATA_DIR: undefined, VYKOR_CHANNELS_DIR: undefined, VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: undefined } });
  const exited = new Promise<void>((resolve, reject) => { child.once("error", () => reject(new Error("Migration validation failed to start"))); child.once("exit", () => resolve()); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<{ pid: number; storePath: string; url: string; token: string }>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Migration validation startup timed out")), invocation.timeoutMs ?? 45000);
    child.once("message", value => {
      const message = value as { type?: unknown; pid: number; storePath: string; url: string; token: string };
      if (message?.type !== "validation-ready" || message.pid !== child.pid || message.storePath !== path || typeof message.token !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(message.url)) reject(new Error("Invalid migration validation identity"));
      else resolve(message);
    });
    void exited.then(() => reject(new Error("Migration validation exited before ready")), reject);
  });
  // Journal fsync/ACL work can outlast a short startup timeout. Attach handlers immediately.
  void ready.catch(() => {}); void exited.catch(() => {});
  const awaitClosed = async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise<void>((_, reject) => { timeout = setTimeout(() => reject(new Error("Migration validation process did not close")), 10000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
  };
  try {
    if (!child.pid) throw new Error("Migration validation child has no PID");
    j.validation.pid = child.pid; j.validation.state = "started"; await saveMigrationJournal(j);
    child.send({ type: "validate-data-root", homeDir: j.homeDir, targetRoot: j.targetRoot, journalPath: j.journalPath });
    const endpoint = await ready;
    const response = await requestDaemon(endpoint, "/sessions?limit=1", { signal: AbortSignal.timeout(5000) });
    if (!response.ok || !Array.isArray((await response.json() as { sessions?: unknown }).sessions)) throw new Error("Migration validation cannot read target sessions");
    child.send({ type: "close-validation" }); await awaitClosed();
    j.validation.state = "closed"; await saveMigrationJournal(j); await restoreValidationDatabase(j);
    return { pid: endpoint.pid, storePath: endpoint.storePath };
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.disconnect();
      await awaitClosed();
    }
  }
}
