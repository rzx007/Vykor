import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, rmdir, stat, statfs, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { securePrivateDirectory } from "@vykor/host-config";
import { isWithinManagedPath, movedDataRootMarkerPath, readDataRootSelector, readManagedPathMap, relocateManagedPath, resolveManagedRealPath, resolveUserDataPaths, withDataRootLock, withDataRootRecoveryLock, type DataRootLock, type ManagedPathMove } from "@vykor/host-config/paths";
import { readDatabasePathRegistrations, relocateDatabasePaths, verifyDataRootCopy } from "@vykor/services/data-root-relocation";
import { relocateInstalledPluginStore } from "@vykor/plugins";
import { inspectDataRootMigration, type DataRootMigrationPreview, type DataRootMigrationRequest, type MigrationSourceEntry } from "./data-root-sources.js";
import { relocateDataRootFiles, relocateProjectStorageKeys } from "./data-root-file-relocation.js";
import { assertJournalPaths, fileDigest, identity, info, readMigrationJournal, samePath, saveMigrationJournal, treeIdentity, writePrivateJson, type DataRootMigrationResult, type MigrationJournal, type TreeIdentity } from "./data-root-migration-journal.js";

export type { DataRootMigrationResult, MigrationPhase } from "./data-root-migration-journal.js";
/** T10 owns the shutdown/freeze lifetime. It must remain held through commit and publication. */
export interface DataRootMigrationCoordination {
  prepareStoppedCopy(): Promise<{ freshDesktopScanId?: string; desktopExportPath?: string }>;
  /** T9/T10 keep repair and trusted verification inside this lock-scoped callback. */
  withInstalledCopy?(handle: { journalPath: string; commit(): Promise<DataRootMigrationResult>; markWritersReleased(): Promise<DataRootMigrationResult> }): Promise<void>;
}
const result = (j: MigrationJournal): DataRootMigrationResult => ({ id: j.id, phase: j.phase, journalPath: j.journalPath, writersReleased: j.writersReleased });
const supported = (report: { unsupported: unknown[] }) => { if (report.unsupported.length) throw new Error("Unsupported structured migration data"); };
const checked = (preview: DataRootMigrationPreview) => { if (preview.blockers.length) throw new Error(`Migration preflight blocked: ${[...new Set(preview.blockers.map(item => item.code))].join(", ")}`); };
const project = (path: string, j: Pick<MigrationJournal, "targetRoot" | "stagingRoot">) => {
  if (!isWithinManagedPath(path, j.targetRoot)) throw new Error("Copy target escapes migration root");
  return join(j.stagingRoot, relative(j.targetRoot, path));
};
async function sameTree(path: string, expected: TreeIdentity, ignoredFile?: string): Promise<void> {
  const actual = await treeIdentity(path, ignoredFile);
  if (actual.identity !== expected.identity || actual.digest !== expected.digest || actual.files !== expected.files || actual.bytes !== expected.bytes) throw new Error("Migration copy identity or digest mismatch");
}
async function copyEntry(entry: MigrationSourceEntry, target: string, linkTarget?: string): Promise<void> {
  const before = await lstat(entry.source);
  if ((entry.kind === "file" && (!before.isFile() || before.isSymbolicLink())) || (entry.kind === "directory" && (!before.isDirectory() || before.isSymbolicLink())) || (entry.kind === "link" && !before.isSymbolicLink())) throw new Error("Migration source type changed");
  if (entry.kind === "directory") { await mkdir(target, { recursive: true, mode: before.mode & 0o777 }); return; }
  await mkdir(dirname(target), { recursive: true });
  if (entry.kind === "link") {
    const original = await readlink(entry.source);
    if (createHash("sha256").update(original).digest("hex") !== entry.digest) throw new Error("Migration link changed");
    let directory = false; try { directory = (await stat(entry.source)).isDirectory(); } catch { /* Preserve dangling links. */ }
    const reference = linkTarget ?? original;
    await symlink(directory && process.platform === "win32" && !isAbsolute(reference) ? resolve(dirname(entry.target), reference) : reference, target, directory ? "junction" : "file");
  } else {
    if (before.size !== entry.bytes || await fileDigest(entry.source) !== entry.digest) throw new Error("Migration source changed");
    await copyFile(entry.source, target, constants.COPYFILE_EXCL);
    await chmod(target, before.mode & 0o777); await utimes(target, before.atime, before.mtime);
    const copied = await lstat(target);
    if ((copied.dev === before.dev && copied.ino === before.ino) || copied.size !== entry.bytes || await fileDigest(target) !== entry.digest || (copied.mode & 0o777) !== (before.mode & 0o777) || Math.abs(copied.mtimeMs - before.mtimeMs) > 1) throw new Error("Migration independent copy validation failed");
  }
  const after = await lstat(entry.source);
  if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Migration source changed while copying");
}
async function copyInventory(preview: DataRootMigrationPreview, j: MigrationJournal): Promise<void> {
  const copied = new Set<string>();
  for (const entry of preview.entries) {
    const target = project(entry.target, j), key = process.platform === "win32" ? target.toLowerCase() : target;
    if (copied.has(key)) continue; copied.add(key);
    await assertJournalPaths(j);
    // Earlier copied links must never become traversed destination parents.
    if (!samePath(await resolveManagedRealPath(dirname(target)), dirname(target))) throw new Error("Migration copy parent changed");
    await copyEntry(entry, target, preview.links.find(link => samePath(link.path, entry.source))?.target);
  }
  for (const entry of [...preview.entries].reverse()) if (entry.kind === "directory") {
    const metadata = await lstat(entry.source), target = project(entry.target, j);
    if (!samePath(target, j.stagingRoot)) await chmod(target, metadata.mode & 0o777);
    await utimes(target, metadata.atime, metadata.mtime);
  }
}
async function checkSources(j: MigrationJournal): Promise<void> {
  for (const source of j.sourceTrees) await sameTree(source.path, source.tree);
  await checkStandaloneSources(j);
}
async function checkStandaloneSources(j: MigrationJournal): Promise<void> {
  for (const entry of j.entries) {
    if (entry.kind === "directory" || j.sourceTrees.some(source => isWithinManagedPath(entry.source, source.path))) continue;
    const actual = await lstat(entry.source), expected = entry.metadata;
    if (!expected || expected.identity !== `${actual.dev}:${actual.ino}` || expected.mode !== (actual.mode & 0o777) || expected.mtimeMs !== actual.mtimeMs || expected.ctimeMs !== actual.ctimeMs) throw new Error("Standalone migration source changed");
    const digest = entry.kind === "link" && actual.isSymbolicLink() ? createHash("sha256").update(await readlink(entry.source)).digest("hex")
      : entry.kind === "file" && actual.isFile() ? await fileDigest(entry.source) : undefined;
    if (digest !== entry.digest) throw new Error("Standalone migration source changed");
  }
}
async function rewriteCopy(j: MigrationJournal, cwdPaths: string[]): Promise<void> {
  const paths = resolveUserDataPaths(j.stagingRoot);
  for (const file of [paths.credentialsFilePath, paths.mcpOAuthFilePath, paths.channelCredentialsFilePath, paths.runtimeEnvironmentSecretsFilePath]) if (await info(file)) {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid credential file");
  }
  if (await info(paths.sessionsDatabasePath)) supported(relocateDatabasePaths(paths.sessionsDatabasePath, j.moves));
  const workflowDirectories: string[] = [], settingsPaths: string[] = [];
  for (const cwd of cwdPaths) {
    const logical = relocateManagedPath(cwd, j.moves);
    if (!isWithinManagedPath(logical, j.targetRoot)) continue;
    for (const [suffix, output] of [[".vykor/workflows", workflowDirectories], [".vykor/settings.json", settingsPaths]] as const) {
      const file = join(project(logical, j), suffix); if (await info(file)) output.push(file);
    }
  }
  supported(await relocateDataRootFiles({ stagedRoot: j.stagingRoot, targetRoot: j.targetRoot, moves: j.moves, workflowDirectories, settingsPaths }));
  supported(await relocateProjectStorageKeys({ stagedRoot: j.stagingRoot, moves: j.moves, cwdPaths }));
  if (await info(paths.installedPluginStorePath)) supported(await relocateInstalledPluginStore(paths.installedPluginStorePath, j.moves, { stagedRoot: j.stagingRoot, targetRoot: j.targetRoot }));
  const previous = readManagedPathMap(j.stagingRoot);
  const moves: ManagedPathMove[] = [...previous.moves.map(move => ({ ...move, to: relocateManagedPath(move.to, j.moves) })), ...j.moves].filter(move => !samePath(move.from, move.to));
  const unique = new Map(moves.map(move => [move.from, move]));
  await mkdir(paths.migrationsDir, { recursive: true });
  await writePrivateJson(paths.pathMapFilePath, { version: 1, moves: [...unique.values()], excludedRoots: [...new Set([...(previous.excludedRoots ?? []), j.stagingRoot, j.backupRoot])] });
  const location = join(paths.daemonDir, "data-location.json");
  if (await info(location)) await writePrivateJson(location, { version: 1, location: { directory: join(j.targetRoot, "data"), storePath: resolveUserDataPaths(j.targetRoot).sessionsDatabasePath } });
  if (await info(paths.sessionsDatabasePath)) await verifyDataRootCopy(paths.sessionsDatabasePath);
}

/** Known-path file operation core. Never starts a daemon, repairs Git or releases writers. */
export async function migrateDataRoot(input: DataRootMigrationRequest, coordination: DataRootMigrationCoordination): Promise<DataRootMigrationResult> {
  try { return await migrateStoppedRoot(input, coordination); }
  catch { throw new Error("Data root migration did not finish; inspect preflight, private permissions, writer coordination or the pending recovery journal before retrying."); }
}
async function migrateStoppedRoot(input: DataRootMigrationRequest, coordination: DataRootMigrationCoordination): Promise<DataRootMigrationResult> {
  if (!coordination?.prepareStoppedCopy) throw new Error("Migration requires a stopped-writer coordinator");
  const first = await inspectDataRootMigration(input);
  // The coordinator creates this receipt while freezing Desktop; all other blockers still stop immediately.
  checked({ ...first, blockers: first.blockers.filter(blocker => blocker.code !== "needs_desktop_export") });
  input = { ...input, homeDir: await resolveManagedRealPath(input.homeDir) };
  return withDataRootLock(input.homeDir, async lock => {
    const previousSelector = readDataRootSelector(input.homeDir);
    if (previousSelector?.pendingMigration) throw new Error("Recover the pending migration first");
    if (await info(movedDataRootMarkerPath(first.sourceRoot))) throw new Error("Source root has already moved");
    const stopped = await coordination.prepareStoppedCopy();
    const request = { ...input, sourceRoot: first.sourceRoot, targetRoot: first.targetRoot, ...(stopped.desktopExportPath ? { desktopExportPath: stopped.desktopExportPath } : {}) };
    let preview = await inspectDataRootMigration(request); checked(preview);
    if (preview.requiredValidations.includes("host-documents-location") || preview.requiredValidations.includes("host-desktop-profile-location")) throw new Error("Migration requires host Documents and Desktop profile locations");
    if (preview.requiredValidations.includes("fresh-desktop-scan-after-freeze") && (!stopped.freshDesktopScanId || stopped.freshDesktopScanId !== preview.desktopScanId)) throw new Error("needs_desktop_export");
    const receipt = request.desktopExportPath ?? resolveUserDataPaths(preview.sourceRoot).legacyImportFilePath;
    if (await info(receipt)) {
      const scan = JSON.parse(await readFile(receipt, "utf8")).desktopScan;
      if (scan) request.legacy = { ...request.legacy, documentsDir: request.legacy?.documentsDir ?? scan.documentsDir, userDataDir: request.legacy?.userDataDir ?? scan.userDataDir };
    }
    const id = randomUUID(), parent = dirname(preview.targetRoot), stagingRoot = join(parent, `.vykor-migration-${id}`);
    // Only owned adjacent locations are probed; no pending pointer before a durable journal exists.
    await mkdir(parent, { recursive: true }); await mkdir(stagingRoot, { mode: 0o700 });
    await securePrivateDirectory(stagingRoot);
    const probe = join(stagingRoot, ".write-probe"); await writeFile(probe, "probe", { flag: "wx", mode: 0o600 }); await rm(probe);
    const j: MigrationJournal = { version: 1, id, phase: "prepared", writersReleased: false, journalPath: join(parent, `.vykor-migration-${id}.json`), homeDir: input.homeDir, sourceRoot: preview.sourceRoot, targetRoot: preview.targetRoot, stagingRoot, backupRoot: join(dirname(preview.sourceRoot), `.vykor-migration-${id}-backup`), mode: preview.mode, previousSelector, parents: [], sourceTrees: [], stagingIdentity: await identity(stagingRoot), entries: [], moves: [], operation: "copy" };
    for (const path of new Set([input.homeDir, dirname(j.sourceRoot), parent])) j.parents.push({ path, identity: await identity(path) });
    j.sourceTrees.push({ path: j.sourceRoot, tree: await treeIdentity(j.sourceRoot) });
    await saveMigrationJournal(j);
    await lock.writeSelector({ version: 1, dataRoot: previousSelector?.dataRoot ?? j.sourceRoot, pendingMigration: { id, journalPath: j.journalPath } });
    try {
      const snapshot = join(stagingRoot, ".database-snapshot"); await mkdir(snapshot);
      const sourceDatabase = preview.databases[0]; let cwdPaths: string[] = [];
      const snapshotDigests = new Map(preview.entries.filter(entry => entry.kind === "file").map(entry => [entry.source, entry.digest]));
      if (sourceDatabase) {
        for (const file of [sourceDatabase.path, sourceDatabase.walPath, sourceDatabase.shmPath].filter((file): file is string => !!file)) {
          const entry = preview.entries.find(entry => samePath(entry.source, file)); if (!entry) throw new Error("Database snapshot is outside the inventory");
          await copyEntry(entry, join(snapshot, `sessions.db${file.slice(sourceDatabase.path.length)}`));
        }
        const managedRoots = [...preview.sources.filter(source => ["workspace", "channel", "worktree", "user-root"].includes(source.kind)).map(source => source.from), ...(request.legacy?.documentsDir ? [join(request.legacy.documentsDir, "Vykor")] : [])];
        const registrations = readDatabasePathRegistrations(join(snapshot, "sessions.db"), { managedRoots }); supported(registrations); cwdPaths = registrations.cwdPaths;
        const documents = request.legacy?.documentsDir;
        const workspaces = documents ? registrations.workspacePaths.filter(path => isWithinManagedPath(path, join(documents, "Vykor")) && !isWithinManagedPath(path, join(documents, "Vykor/channels"))) : [];
        preview = await inspectDataRootMigration({ ...request, projectPaths: [...new Set([...(request.projectPaths ?? []), ...registrations.projectPaths])], legacy: { ...request.legacy, workspacePaths: [...new Set([...(request.legacy?.workspacePaths ?? []), ...workspaces])] } }); checked(preview);
        // An open snapshot may have consumed WAL, but the source must still be exactly its inspected version.
        for (const old of [sourceDatabase.path, sourceDatabase.walPath].filter((p): p is string => !!p)) {
          if (snapshotDigests.get(old) !== (await fileDigest(old))) throw new Error("Stopped database changed");
        }
      } else {
        throw new Error("An existing database is required to verify path registrations");
      }
      await rm(snapshot, { recursive: true });
      if (preview.requiredValidations.includes("fresh-desktop-scan-after-freeze") && preview.desktopScanId !== stopped.freshDesktopScanId) throw new Error("Desktop scan changed after freeze");
      j.entries = await Promise.all(preview.entries.map(async entry => { const metadata = await lstat(entry.source); return { ...entry, metadata: { identity: `${metadata.dev}:${metadata.ino}`, mode: metadata.mode & 0o777, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs } }; })); j.moves = preview.moves;
      for (const source of preview.sources) if (!preview.sources.some(other => !samePath(other.from, source.from) && isWithinManagedPath(source.from, other.from))) {
        if (!samePath(source.from, j.sourceRoot) && (await lstat(source.from)).isDirectory()) j.sourceTrees.push({ path: source.from, tree: await treeIdentity(source.from) });
      }
      // Standalone custom DB/files are also represented by their final entries and checked after copy.
      await saveMigrationJournal(j);
      const capacity = await statfs(stagingRoot); if (capacity.bavail * capacity.bsize < preview.bytes) throw new Error("Insufficient migration space");
      await checkSources(j); await copyInventory(preview, j); await checkSources(j);
      for (const entry of j.entries) if (entry.kind === "file" && await fileDigest(entry.source) !== entry.digest) throw new Error("Migration source changed");
      j.operation = "rewrite"; await saveMigrationJournal(j); await rewriteCopy(j, cwdPaths);
      await checkSources(j); j.stagedTree = await treeIdentity(stagingRoot); j.phase = "staged"; await saveMigrationJournal(j);
      await assertJournalPaths(j); await checkSources(j); await sameTree(stagingRoot, j.stagedTree);
      if (j.mode === "same-root") {
        if (await info(j.backupRoot)) throw new Error("Migration backup path already exists");
        j.operation = "backup-source"; await saveMigrationJournal(j); await rename(j.sourceRoot, j.backupRoot);
      } else if (await info(j.targetRoot)) {
        if (!(await lstat(j.targetRoot)).isDirectory() || (await readdir(j.targetRoot)).length) throw new Error("Migration target is no longer empty");
        await rmdir(j.targetRoot); // Only the inspected, still-empty target directory.
      }
      j.operation = "install"; await saveMigrationJournal(j); await assertJournalPaths(j); await rename(stagingRoot, j.targetRoot);
      j.phase = "installed"; j.operation = "verify"; await saveMigrationJournal(j);
      await sameTree(j.targetRoot, j.stagedTree); j.phase = "verified"; await saveMigrationJournal(j);
      if (coordination.withInstalledCopy) {
        let active = true;
        let pending: Promise<unknown> = Promise.resolve();
        const requireActive = () => { if (!active) throw new Error("Migration coordination handle expired"); };
        try { await coordination.withInstalledCopy({ journalPath: j.journalPath,
          commit: async () => { requireActive(); const operation = pending.then(() => commitLocked(j, lock)); pending = operation; return operation; },
          markWritersReleased: async () => { requireActive(); const operation = pending.then(() => releaseLocked(j, lock)); pending = operation; return operation; },
        }); }
        finally { active = false; await pending; }
      }
      return result(j);
    } catch {
      // Never persist exception messages/causes: parsers and providers can include secrets or bodies.
      j.failedOperation = j.operation; if (!j.writersReleased) j.phase = "failed"; await saveMigrationJournal(j); return result(j);
    }
  });
}

async function selectedJournal(path: string, homeDir: string): Promise<MigrationJournal> {
  const j = await readMigrationJournal(path, homeDir), selector = readDataRootSelector(homeDir);
  const restoring = j.operation === "restore-selector" && JSON.stringify(selector) === JSON.stringify(j.previousSelector);
  if (!j.recovered && !restoring && !(j.phase === "committed" && selector && samePath(selector.dataRoot, j.targetRoot)) && (selector?.pendingMigration?.id !== j.id || !samePath(selector.pendingMigration.journalPath, path))) throw new Error("Migration journal is not selected by this home");
  return j;
}
/** T9/T10 call only after Git/service repair and trusted instance verification. */
export async function commitDataRootMigration(path: string, options: { homeDir: string }): Promise<DataRootMigrationResult> {
  return withDataRootLock(options.homeDir, async lock => {
    const j = await selectedJournal(path, options.homeDir);
    return commitLocked(j, lock);
  });
}
async function commitLocked(j: MigrationJournal, lock: DataRootLock): Promise<DataRootMigrationResult> {
    if (j.phase === "committed") return result(j);
    if (j.phase !== "verified" || !j.stagedTree) throw new Error("Migration is not verified");
    await sameTree(j.targetRoot, j.stagedTree); await assertJournalPaths(j);
    for (const source of j.sourceTrees) await sameTree(j.mode === "same-root" && samePath(source.path, j.sourceRoot) ? j.backupRoot : source.path, source.tree);
    await checkStandaloneSources(j);
    j.operation = "commit-selector"; await saveMigrationJournal(j);
    await lock.writeSelector({ version: 1, dataRoot: j.targetRoot, pendingMigration: { id: j.id, journalPath: j.journalPath } });
    const old = j.mode === "same-root" ? j.backupRoot : j.sourceRoot;
    j.oldMarkerDirectoryCreated = !await info(dirname(movedDataRootMarkerPath(old)));
    j.operation = "mark-old-root"; await saveMigrationJournal(j);
    await mkdir(dirname(movedDataRootMarkerPath(old)), { recursive: true });
    await writePrivateJson(movedDataRootMarkerPath(old), { version: 1, id: j.id, targetRoot: j.targetRoot, journalPath: j.journalPath });
    j.phase = "committed"; j.operation = "complete"; await saveMigrationJournal(j); return result(j);
}
/** Persist before the coordinator activates any ordinary writes; recovery can no longer choose old data. */
export async function markDataRootMigrationWritersReleased(path: string, options: { homeDir: string }): Promise<DataRootMigrationResult> {
  return withDataRootLock(options.homeDir, async lock => {
    const j = await selectedJournal(path, options.homeDir);
    return releaseLocked(j, lock);
  });
}
async function releaseLocked(j: MigrationJournal, lock: DataRootLock): Promise<DataRootMigrationResult> {
    if (j.phase !== "committed") throw new Error("Migration selection is not committed");
    if (!j.writersReleased) { if (!j.stagedTree) throw new Error("Migration target identity missing"); await sameTree(j.targetRoot, j.stagedTree); }
    j.writersReleased = true; await saveMigrationJournal(j);
    await lock.writeSelector({ version: 1, dataRoot: j.targetRoot }); return result(j);
}

/** Recovery preserves every copy. An ambiguous identity stops before any rename or selector restoration. */
export async function recoverDataRootMigration(path: string, options: { homeDir: string }): Promise<DataRootMigrationResult> {
  return withDataRootRecoveryLock(options.homeDir, async lock => {
    const j = await selectedJournal(path, options.homeDir);
    if (j.writersReleased) throw new Error("Migration writers were released; repair the current target or perform a reverse migration");
    if (j.recovered) return result(j);
    j.operation = "inspect-recovery";
    try {
      await assertJournalPaths(j);
      const sourceTree = j.sourceTrees.find(source => samePath(source.path, j.sourceRoot))?.tree;
      if (!sourceTree) throw new Error("Migration source identity was not recorded");
      const oldPath = j.mode === "same-root" && await info(j.backupRoot) ? j.backupRoot : j.sourceRoot;
      const marker = movedDataRootMarkerPath(oldPath);
      if (await info(marker)) {
        const value = JSON.parse(await readFile(marker, "utf8"));
        if (value.id !== j.id || value.targetRoot !== j.targetRoot || value.journalPath !== j.journalPath) throw new Error("Unknown moved-root marker");
      }
      const markerDirectory = dirname(marker);
      if (j.oldMarkerDirectoryCreated && await info(markerDirectory) && (await readdir(markerDirectory)).some(name => name !== "moved-root.json")) throw new Error("Unknown files in old marker directory");
      await sameTree(oldPath, sourceTree, j.oldMarkerDirectoryCreated ? markerDirectory : await info(marker) ? marker : undefined);
      for (const source of j.sourceTrees) if (!samePath(source.path, j.sourceRoot)) await sameTree(source.path, source.tree);
      await checkStandaloneSources(j);
      const target = await info(j.targetRoot), staged = await info(j.stagingRoot);
      const installed = target && await identity(j.targetRoot) === j.stagingIdentity;
      if (staged && await identity(j.stagingRoot) !== j.stagingIdentity) throw new Error("Unknown migration staging identity");
      if (installed) {
        if (staged || !j.stagedTree) throw new Error("Ambiguous migration copies");
        await sameTree(j.targetRoot, j.stagedTree);
      } else if (target && !(j.mode === "same-root" && samePath(oldPath, j.sourceRoot))) throw new Error("Unknown migration target identity");
      if (staged && j.stagedTree) await sameTree(j.stagingRoot, j.stagedTree);
      if (installed) { j.operation = "rollback-target"; await saveMigrationJournal(j); await rename(j.targetRoot, j.stagingRoot); }
      if (await info(marker)) await rm(marker);
      if (j.oldMarkerDirectoryCreated && await info(markerDirectory)) await rmdir(markerDirectory);
      if (j.mode === "same-root" && samePath(oldPath, j.backupRoot)) { j.operation = "restore-source"; await saveMigrationJournal(j); await rename(j.backupRoot, j.sourceRoot); }
      j.operation = "restore-selector"; await saveMigrationJournal(j); await restoreSelector(lock, j);
      j.recovered = true; j.phase = "failed"; j.operation = "complete"; await saveMigrationJournal(j); return result(j);
    } catch {
      j.failedOperation ??= j.operation; j.phase = "rollback_failed"; await saveMigrationJournal(j); return result(j);
    }
  });
}
async function restoreSelector(lock: DataRootLock, j: MigrationJournal): Promise<void> { await lock.restoreSelector(j.previousSelector); }
