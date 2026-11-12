import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, readlink, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { securePrivateFile, writeJsonFileAtomically } from "@vykor/host-config";
import { isWithinManagedPath, requireCompleteAbsolutePath, resolveManagedRealPath, type DataRootSelector, type ManagedPathMove } from "@vykor/host-config/paths";
import type { MigrationSourceEntry } from "./data-root-sources.js";

export type MigrationPhase = "prepared" | "staged" | "installed" | "verified" | "committed" | "failed" | "rollback_failed";
export interface DataRootMigrationResult { id: string; phase: MigrationPhase; journalPath: string; writersReleased: boolean }
export interface TreeIdentity { identity: string; digest: string; files: number; bytes: number }
export interface MigrationJournal extends DataRootMigrationResult {
  version: 1;
  homeDir: string; sourceRoot: string; targetRoot: string; stagingRoot: string; backupRoot: string;
  mode: "same-root" | "different-root";
  previousSelector?: DataRootSelector;
  parents: Array<{ path: string; identity: string }>;
  sourceTrees: Array<{ path: string; tree: TreeIdentity }>;
  stagingIdentity: string;
  entries: Array<MigrationSourceEntry & { metadata?: { identity: string; mode: number; mtimeMs: number; ctimeMs: number } }>;
  moves: ManagedPathMove[];
  stagedTree?: TreeIdentity;
  operation: "copy" | "rewrite" | "backup-source" | "install" | "verify" | "commit-selector" | "mark-old-root" | "inspect-recovery" | "rollback-target" | "restore-source" | "restore-selector" | "complete";
  failedOperation?: MigrationJournal["operation"];
  recovered?: boolean;
  oldMarkerCreatedDirectories?: Array<"data" | "data/migrations">;
}
export const samePath = (a: string, b: string): boolean => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
export async function info(path: string) {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function identity(path: string): Promise<string> {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink() || !samePath(await resolveManagedRealPath(path), path)) throw new Error("Migration directory identity is unsafe");
  return `${value.dev}:${value.ino}`;
}
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
/** Does not follow links, read bodies into the journal, or ignore unknown user locks. */
export async function treeIdentity(root: string, ignoredFile?: string): Promise<TreeIdentity> {
  const rootIdentity = await identity(root), hash = createHash("sha256"); let files = 0, bytes = 0;
  const walk = async (path: string): Promise<void> => {
    if (ignoredFile && samePath(path, ignoredFile)) return;
    const before = await lstat(path), name = relative(root, path), mode = before.mode & 0o777;
    if (before.isSymbolicLink()) { hash.update(JSON.stringify([name, "link", await readlink(path)])); files++; }
    else if (before.isDirectory()) {
      hash.update(JSON.stringify([name, "directory", mode]));
      for (const name of (await readdir(path)).sort()) await walk(join(path, name));
    } else if (before.isFile()) {
      const digest = await fileDigest(path), after = await lstat(path);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Migration source changed");
      hash.update(JSON.stringify([name, "file", before.size, mode, before.mtimeMs, digest])); files++; bytes += before.size;
    } else throw new Error("Unsupported migration file type");
  };
  await walk(root);
  return { identity: rootIdentity, digest: hash.digest("hex"), files, bytes };
}
export async function saveMigrationJournal(journal: MigrationJournal): Promise<void> {
  await writePrivateJson(journal.journalPath, journal);
}
/** Atomic JSON helper with fsync and private permissions before exposing the temporary bytes. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeJsonFileAtomically(path, value, {
    writeFile: async (temporary, content) => {
      const handle = await open(temporary, "wx", 0o600);
      try { await securePrivateFile(temporary); await handle.writeFile(content, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
    }, rename, rm,
  });
}
export async function readMigrationJournal(path: string, homeDir: string): Promise<MigrationJournal> {
  requireCompleteAbsolutePath(path, "journalPath"); requireCompleteAbsolutePath(homeDir, "homeDir");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid migration journal");
  let j: MigrationJournal;
  try { j = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Invalid migration journal"); }
  const phases = ["prepared", "staged", "installed", "verified", "committed", "failed", "rollback_failed"];
  if (j.version !== 1 || !/^[a-f0-9-]{36}$/.test(j.id) || !phases.includes(j.phase) || typeof j.writersReleased !== "boolean"
    || !["same-root", "different-root"].includes(j.mode) || typeof j.stagingIdentity !== "string"
    || !Array.isArray(j.parents) || !Array.isArray(j.sourceTrees) || !Array.isArray(j.entries) || !Array.isArray(j.moves)) throw new Error("Invalid migration journal");
  const created = j.oldMarkerCreatedDirectories;
  if (created !== undefined && !(Array.isArray(created) && (created.length === 0
    || (created.length === 1 && created[0] === "data/migrations")
    || (created.length === 2 && created[0] === "data" && created[1] === "data/migrations")))) throw new Error("Invalid migration marker directory chain");
  for (const value of [j.homeDir, j.sourceRoot, j.targetRoot, j.stagingRoot, j.backupRoot, j.journalPath]) requireCompleteAbsolutePath(value, "journal path");
  for (const value of [...j.parents.map(item => item.path), ...j.sourceTrees.map(item => item.path), ...j.entries.flatMap(item => [item.source, item.target]), ...j.moves.flatMap(item => [item.from, item.to])]) requireCompleteAbsolutePath(value, "journal entry");
  const requiredParents = [j.homeDir, dirname(j.sourceRoot), dirname(j.targetRoot)];
  if (requiredParents.some(path => !j.parents.some(parent => samePath(path, parent.path))) || j.entries.some(entry => !isWithinManagedPath(entry.target, j.targetRoot))) throw new Error("Invalid migration journal scope");
  if (!samePath(homeDir, j.homeDir) || !samePath(path, j.journalPath) || !samePath(path, join(dirname(j.targetRoot), `.vykor-migration-${j.id}.json`))
    || !samePath(j.stagingRoot, join(dirname(j.targetRoot), `.vykor-migration-${j.id}`)) || !samePath(j.backupRoot, join(dirname(j.sourceRoot), `.vykor-migration-${j.id}-backup`))
    || (j.mode === "same-root") !== samePath(j.sourceRoot, j.targetRoot) || isWithinManagedPath(homeDir, j.sourceRoot) || isWithinManagedPath(homeDir, j.targetRoot)) throw new Error("Migration journal path mismatch");
  await assertJournalPaths(j);
  return j;
}
export async function assertJournalPaths(j: MigrationJournal): Promise<void> {
  for (const parent of j.parents) if (await identity(parent.path) !== parent.identity) throw new Error("Migration parent identity changed");
  for (const path of [j.homeDir, j.sourceRoot, j.targetRoot, j.stagingRoot, j.backupRoot, j.journalPath]) {
    if (!samePath(await resolveManagedRealPath(path), path)) throw new Error("Migration path escaped its inspected scope");
  }
}
