import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, rmdir, stat, statfs, symlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { securePrivateDirectory } from "@vykor/host-config";
import { isWithinManagedPath, movedDataRootMarkerPath, readDataRootSelector, readManagedPathMap, relocateManagedPath, resolveManagedRealPath, resolveUserDataPaths, withDataRootLock, withDataRootRecoveryLock, type DataRootLock, type ManagedPathMove } from "@vykor/host-config/paths";
import { relocateDatabasePaths, verifyDataRootCopy } from "@vykor/services/data-root-relocation";
import { relocateInstalledPluginStore } from "@vykor/plugins";
import { inspectDataRootMigration, inspectDataRootMigrationFromStoppedCopy, type DataRootMigrationPreview, type DataRootMigrationRequest, type MigrationSourceEntry } from "./data-root-sources.js";
import { repairMigrationGit, restoreMigrationGit, verifyMigrationGitTrees, verifyRestoredGitSource } from "./data-root-git.js";
import { captureMigrationService, installMigrationService, pauseMigrationService, restoreMigrationService, resumeMigrationService, stageMigrationService } from "./data-root-service.js";
import type { DaemonSystemService } from "./system-service.js";
import { restoreValidationDatabase, validateMigrationInNewProcess, type MigrationValidationInvocation } from "./data-root-validation.js";
import { relocateDataRootFiles, relocateProjectStorageKeys } from "./data-root-file-relocation.js";
import { assertJournalPaths, fileDigest, identity, info, readMigrationJournal, samePath, saveMigrationJournal, treeIdentity, writePrivateJson, type DataRootMigrationResult, type MigrationJournal, type TreeIdentity } from "./data-root-migration-journal.js";

export type { DataRootMigrationResult, MigrationPhase } from "./data-root-migration-journal.js";
/** T10 owns the shutdown/freeze lifetime. It must remain held through commit and publication. */
export interface DataRootMigrationCoordination {
  prepareStoppedCopy(context: { journalPath: string; runtimeDirectories: readonly string[]; captureSystemService(service: DaemonSystemService): Promise<void>; pauseSystemService(): Promise<void> }): Promise<{ freshDesktopScanId?: string; desktopExportPath?: string }>;
  /** T9/T10 keep repair and trusted verification inside this lock-scoped callback. */
  withInstalledCopy?(handle: { journalPath: string; validateInNewProcess(invocation: MigrationValidationInvocation): Promise<{ pid: number; storePath: string }>; commit(): Promise<DataRootMigrationResult>; markWritersReleased(): Promise<DataRootMigrationResult> }): Promise<void>;
}
const operations = new Set(["stop-writers", "service-capture", "service-pause", "service-install", "service-restore", "validate-instance", "copy", "rewrite", "backup-source", "install", "verify", "git-repair", "git-restore", "commit-selector", "mark-old-root", "inspect-recovery", "rollback-target", "restore-source", "restore-selector", "complete"]);
const result = (j: MigrationJournal): DataRootMigrationResult => ({ id: j.id, phase: j.phase, journalPath: j.journalPath, writersReleased: j.writersReleased,
  ...(operations.has(j.operation) ? { operation: j.operation } : {}), ...(j.failedOperation && operations.has(j.failedOperation) ? { failedOperation: j.failedOperation } : {}),
  ...(j.recoveryWritersReleased ? { recoveryWritersReleased: true } : {}), ...(j.serviceResumeStatus ? { serviceResumeStatus: j.serviceResumeStatus } : {}) });
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
  for (const source of j.sourceTrees) if (!await verifyRestoredGitSource(j, source.path, source.path)) await sameTree(source.path, source.tree);
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
  if (await info(paths.legacyImportFilePath)) {
    const manifest = JSON.parse(await readFile(paths.legacyImportFilePath, "utf8"));
    if (manifest.legacySources?.status === "pending") {
      manifest.legacySources.status = "consumed";
      await writePrivateJson(paths.legacyImportFilePath, manifest);
    }
  }
  supported(await relocateProjectStorageKeys({ stagedRoot: j.stagingRoot, moves: j.moves, cwdPaths }));
  if (await info(paths.installedPluginStorePath)) supported(await relocateInstalledPluginStore(paths.installedPluginStorePath, j.moves, { stagedRoot: j.stagingRoot, targetRoot: j.targetRoot }));
  const previous = readManagedPathMap(j.stagingRoot);
  const moves: ManagedPathMove[] = [...previous.moves.map(move => ({ ...move, to: relocateManagedPath(move.to, j.moves) })), ...j.moves].filter(move => !samePath(move.from, move.to));
  const unique = new Map(moves.map(move => [move.from, move]));
  await mkdir(paths.migrationsDir, { recursive: true });
  await writePrivateJson(paths.pathMapFilePath, { version: 1, moves: [...unique.values()], excludedRoots: [...new Set([...(previous.excludedRoots ?? []), j.stagingRoot, j.backupRoot])] });
  const location = join(paths.daemonDir, "data-location.json");
  if (await info(location)) await writePrivateJson(location, { version: 1, location: { directory: join(j.targetRoot, "data"), storePath: resolveUserDataPaths(j.targetRoot).sessionsDatabasePath } });
  if (await info(paths.sessionsDatabasePath)) {
    await verifyDataRootCopy(paths.sessionsDatabasePath);
    const databaseMetadata = await lstat(paths.sessionsDatabasePath);
    await utimes(paths.sessionsDatabasePath, databaseMetadata.atime, databaseMetadata.mtime);
  }
}

/** Known-path migration core. Git repair stays under the lock; the caller owns daemon/writer lifetime. */
export async function migrateDataRoot(input: DataRootMigrationRequest, coordination: DataRootMigrationCoordination): Promise<DataRootMigrationResult> {
  try { return await migrateStoppedRoot(input, coordination); }
  catch { throw new Error("Data root migration did not finish; inspect preflight, private permissions, writer coordination or the pending recovery journal before retrying."); }
}
async function migrateStoppedRoot(input: DataRootMigrationRequest, coordination: DataRootMigrationCoordination): Promise<DataRootMigrationResult> {
  if (!coordination?.prepareStoppedCopy) throw new Error("Migration requires a stopped-writer coordinator");
  const first = await inspectDataRootMigration(input);
  // The coordinator creates this receipt while freezing Desktop; all other blockers still stop immediately.
  checked({ ...first, blockers: first.blockers.filter(blocker => !["needs_desktop_export", "git_main_ownership_pending"].includes(blocker.code)) });
  input = { ...input, homeDir: await resolveManagedRealPath(input.homeDir) };
  return withDataRootLock(input.homeDir, async lock => {
    const previousSelector = readDataRootSelector(input.homeDir);
    if (previousSelector?.pendingMigration) throw new Error("Recover the pending migration first");
    if (await info(movedDataRootMarkerPath(first.sourceRoot))) throw new Error("Source root has already moved");
    const id = randomUUID(), parent = dirname(first.targetRoot), stagingRoot = join(parent, `.vykor-migration-${id}`);
    // Only owned adjacent locations are probed; no pending pointer before a durable journal exists.
    await mkdir(parent, { recursive: true }); await mkdir(stagingRoot, { mode: 0o700 });
    await securePrivateDirectory(stagingRoot);
    const probe = join(stagingRoot, ".write-probe"); await writeFile(probe, "probe", { flag: "wx", mode: 0o600 }); await rm(probe);
    const j: MigrationJournal = { version: 1, id, phase: "prepared", writersReleased: false, journalPath: join(parent, `.vykor-migration-${id}.json`), homeDir: input.homeDir, sourceRoot: first.sourceRoot, targetRoot: first.targetRoot, stagingRoot, backupRoot: join(dirname(first.sourceRoot), `.vykor-migration-${id}-backup`), mode: first.mode, previousSelector, parents: [], sourceTrees: [], stagingIdentity: await identity(stagingRoot), entries: [], moves: [], preparation: { sourceIdentity: await identity(first.sourceRoot), complete: false }, operation: "stop-writers" };
    j.preparation!.runtimeDirectories = [];
    for (const path of new Set([join(first.sourceRoot, "data"), ...first.sources.filter(source => source.origin === "runtime-data").map(source => source.from)])) {
      if (await info(path)) j.preparation!.runtimeDirectories.push({ path, identity: await identity(path) });
    }
    for (const path of new Set([input.homeDir, dirname(j.sourceRoot), parent])) j.parents.push({ path, identity: await identity(path) });
    await saveMigrationJournal(j);
    await lock.writeSelector({ version: 1, dataRoot: previousSelector?.dataRoot ?? j.sourceRoot, pendingMigration: { id, journalPath: j.journalPath } });
    let systemService: DaemonSystemService | undefined;
    try {
      let preparing = true, pendingPreparation: Promise<void> = Promise.resolve();
      const prepare = (action: () => Promise<void>) => {
        if (!preparing) return Promise.reject(new Error("Migration preparation handle expired"));
        return pendingPreparation = pendingPreparation.then(action);
      };
      let stopped: Awaited<ReturnType<DataRootMigrationCoordination["prepareStoppedCopy"]>>;
      try { stopped = await coordination.prepareStoppedCopy({ journalPath: j.journalPath, runtimeDirectories: Object.freeze(j.preparation!.runtimeDirectories!.map(item => item.path)),
        captureSystemService: service => prepare(async () => { await captureMigrationService(j, service); systemService = service; }),
        pauseSystemService: () => prepare(async () => { if (!systemService) throw new Error("Capture the service before pausing it"); await pauseMigrationService(j, systemService); }),
      }); }
      finally { preparing = false; await pendingPreparation; }
      const request = { ...input, sourceRoot: first.sourceRoot, targetRoot: first.targetRoot, ...(stopped.desktopExportPath ? { desktopExportPath: stopped.desktopExportPath } : {}) };
      let preview = await inspectDataRootMigration(request); checked({ ...preview, blockers: preview.blockers.filter(blocker => blocker.code !== "git_main_ownership_pending") });
      if (preview.requiredValidations.includes("host-documents-location") || preview.requiredValidations.includes("host-desktop-profile-location")) throw new Error("Migration requires host Documents and Desktop profile locations");
      if (preview.requiredValidations.includes("fresh-desktop-scan-after-freeze") && (!stopped.freshDesktopScanId || stopped.freshDesktopScanId !== preview.desktopScanId)) throw new Error("needs_desktop_export");
      const receipt = request.desktopExportPath ?? resolveUserDataPaths(preview.sourceRoot).legacyImportFilePath;
      if (await info(receipt)) {
        const scan = JSON.parse(await readFile(receipt, "utf8")).desktopScan;
        if (scan) request.legacy = { ...request.legacy, documentsDir: request.legacy?.documentsDir ?? scan.documentsDir, userDataDir: request.legacy?.userDataDir ?? scan.userDataDir };
      }
      j.sourceTrees.push({ path: j.sourceRoot, tree: await treeIdentity(j.sourceRoot) });
      j.preparation!.complete = true; j.operation = "copy"; await saveMigrationJournal(j);
      const snapshot = join(stagingRoot, ".database-snapshot"); await mkdir(snapshot);
      const sourceDatabase = preview.databases[0]; let cwdPaths: string[] = [];
      const snapshotDigests = new Map(preview.entries.filter(entry => entry.kind === "file").map(entry => [entry.source, entry.digest]));
      if (sourceDatabase) {
        for (const file of [sourceDatabase.path, sourceDatabase.walPath, sourceDatabase.shmPath].filter((file): file is string => !!file)) {
          const entry = preview.entries.find(entry => samePath(entry.source, file)); if (!entry) throw new Error("Database snapshot is outside the inventory");
          await copyEntry(entry, join(snapshot, `sessions.db${file.slice(sourceDatabase.path.length)}`));
        }
        const managedRoots = [...preview.sources.filter(source => ["workspace", "channel", "worktree", "user-root"].includes(source.kind)).map(source => source.from), ...(request.legacy?.documentsDir ? [join(request.legacy.documentsDir, "Vykor")] : [])];
        const inspected = await inspectDataRootMigrationFromStoppedCopy(request, join(snapshot, "sessions.db"), managedRoots);
        cwdPaths = inspected.registrations.cwdPaths; preview = inspected.preview; checked(preview);
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
      j.gitWorktrees = preview.gitWorktrees;
      for (const source of preview.sources) if (!preview.sources.some(other => !samePath(other.from, source.from) && isWithinManagedPath(source.from, other.from))) {
        if (!samePath(source.from, j.sourceRoot) && (await lstat(source.from)).isDirectory()) j.sourceTrees.push({ path: source.from, tree: await treeIdentity(source.from) });
      }
      // Standalone custom DB/files are also represented by their final entries and checked after copy.
      await saveMigrationJournal(j);
      const capacity = await statfs(stagingRoot); if (capacity.bavail * capacity.bsize < preview.bytes) throw new Error("Insufficient migration space");
      await checkSources(j); await copyInventory(preview, j); await checkSources(j);
      for (const entry of j.entries) if (entry.kind === "file" && await fileDigest(entry.source) !== entry.digest) throw new Error("Migration source changed");
      j.operation = "rewrite"; await saveMigrationJournal(j); await rewriteCopy(j, cwdPaths);
      await stageMigrationService(j, systemService);
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
        await repairMigrationGit(j);
        await installMigrationService(j, systemService);
        let active = true;
        let pending: Promise<unknown> = Promise.resolve();
        const requireActive = () => { if (!active) throw new Error("Migration coordination handle expired"); };
        try { await coordination.withInstalledCopy({ journalPath: j.journalPath,
          validateInNewProcess: async invocation => { requireActive(); const operation = pending.then(() => validateMigrationInNewProcess(j, invocation)); pending = operation; return operation; },
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
  const pending = selector?.pendingMigration;
  if (pending) {
    if (pending.id !== j.id || !samePath(pending.journalPath, path)) throw new Error("Migration journal is not selected by this home");
    return j;
  }
  const restoring = j.operation === "restore-selector" && JSON.stringify(selector) === JSON.stringify(j.previousSelector);
  const published = j.phase === "committed" && j.writersReleased && selector && samePath(selector.dataRoot, j.targetRoot);
  if (!j.recovered && !restoring && !published) throw new Error("Migration journal is not selected by this home");
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
    if (j.gitWorktrees?.length && j.gitRepair?.state !== "repaired") throw new Error("Migration Git repair is not verified");
    if (j.gitRepair) await verifyMigrationGitTrees(j, j.targetRoot);
    await sameTree(j.targetRoot, j.stagedTree); await assertJournalPaths(j);
    for (const source of j.sourceTrees) await sameTree(j.mode === "same-root" && samePath(source.path, j.sourceRoot) ? j.backupRoot : source.path, source.tree);
    await checkStandaloneSources(j);
    j.operation = "commit-selector"; await saveMigrationJournal(j);
    await lock.writeSelector({ version: 1, dataRoot: j.targetRoot, pendingMigration: { id: j.id, journalPath: j.journalPath } });
    const old = j.mode === "same-root" ? j.backupRoot : j.sourceRoot;
    j.oldMarkerCreatedDirectories = [];
    for (const directory of ["data", "data/migrations"] as const) {
      if (await info(join(old, directory))) await identity(join(old, directory));
      else j.oldMarkerCreatedDirectories.push(directory);
    }
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
    if (j.writersReleased && !readDataRootSelector(j.homeDir)?.pendingMigration) return result(j);
    if (!j.writersReleased) { if (!j.stagedTree) throw new Error("Migration target identity missing"); await sameTree(j.targetRoot, j.stagedTree); await verifyMigrationGitTrees(j, j.targetRoot); }
    j.writersReleased = true; await saveMigrationJournal(j);
    await lock.writeSelector({ version: 1, dataRoot: j.targetRoot }); return result(j);
}

/** Recovery preserves every copy. An ambiguous identity stops before any rename or selector restoration. */
export async function recoverDataRootMigration(path: string, options: { homeDir: string; systemService?: DaemonSystemService }): Promise<DataRootMigrationResult> {
  const restored = await withDataRootRecoveryLock(options.homeDir, async lock => {
    const record = await readMigrationJournal(path, options.homeDir);
    // A released source can contain new writes or a new pending migration. Only finish our selector once.
    const j = record.recoveryWritersReleased ? record : await selectedJournal(path, options.homeDir);
    if (j.writersReleased) throw new Error("Migration writers were released; repair the current target or perform a reverse migration");
    if (j.recoveryWritersReleased) {
      const pending = readDataRootSelector(j.homeDir)?.pendingMigration;
      if (pending?.id === j.id && samePath(pending.journalPath, j.journalPath)) {
        const expected = j.preparation?.sourceIdentity ?? j.sourceTrees.find(source => samePath(source.path, j.sourceRoot))?.tree.identity;
        if (await identity(j.sourceRoot) !== expected) throw new Error("Restored source identity changed");
        await restoreSelector(lock, j);
      }
      j.recovered = true; j.phase = "failed"; j.operation = "complete"; await saveMigrationJournal(j); return result(j);
    }
    if (j.recovered) return result(j);
    j.operation = "inspect-recovery";
    try {
      await assertJournalPaths(j);
      await restoreValidationDatabase(j);
      if (j.preparation && !j.preparation.complete) {
        if (await identity(j.sourceRoot) !== j.preparation.sourceIdentity || await identity(j.stagingRoot) !== j.stagingIdentity
          || (await readdir(j.stagingRoot)).length || await info(j.backupRoot)) throw new Error("Unknown early migration preparation contents");
        for (const runtime of j.preparation.runtimeDirectories ?? []) if (await identity(runtime.path) !== runtime.identity) throw new Error("Early source runtime identity changed");
        await restoreMigrationService(j, options.systemService);
        j.recoveryWritersReleased = true; j.serviceResumeStatus = "pending";
        j.operation = "restore-selector"; await saveMigrationJournal(j); await restoreSelector(lock, j);
        j.recovered = true; j.phase = "failed"; j.operation = "complete"; await saveMigrationJournal(j); return result(j);
      }
      const sourceTree = j.sourceTrees.find(source => samePath(source.path, j.sourceRoot))?.tree;
      if (!sourceTree) throw new Error("Migration source identity was not recorded");
      const oldPath = j.mode === "same-root" && await info(j.backupRoot) ? j.backupRoot : j.sourceRoot;
      const marker = movedDataRootMarkerPath(oldPath);
      const createdDirectories = (j.oldMarkerCreatedDirectories ?? []).map(directory => join(oldPath, directory));
      for (const [index, directory] of createdDirectories.entries()) {
        if (!await info(directory)) continue; // A prior creation or cleanup attempt may have stopped partway.
        await identity(directory);
        const expectedChild = basename(createdDirectories[index + 1] ?? marker);
        if ((await readdir(directory)).some(name => name !== expectedChild)) throw new Error("Unknown files in old marker directory chain");
      }
      if (await info(dirname(marker))) await identity(dirname(marker));
      const markerInfo = await info(marker);
      if (markerInfo) {
        if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error("Unknown moved-root marker");
        const value = JSON.parse(await readFile(marker, "utf8"));
        if (value.id !== j.id || value.targetRoot !== j.targetRoot || value.journalPath !== j.journalPath) throw new Error("Unknown moved-root marker");
      }
      const ignoredMarker = createdDirectories[0] ?? (markerInfo ? marker : undefined);
      if (!await verifyRestoredGitSource(j, j.sourceRoot, oldPath, ignoredMarker)) await sameTree(oldPath, sourceTree, ignoredMarker);
      for (const source of j.sourceTrees) if (!samePath(source.path, j.sourceRoot) && !await verifyRestoredGitSource(j, source.path, source.path)) await sameTree(source.path, source.tree);
      await checkStandaloneSources(j);
      const target = await info(j.targetRoot), staged = await info(j.stagingRoot);
      const installed = target && await identity(j.targetRoot) === j.stagingIdentity;
      if (staged && await identity(j.stagingRoot) !== j.stagingIdentity) throw new Error("Unknown migration staging identity");
      if (installed) {
        if (staged || !j.stagedTree) throw new Error("Ambiguous migration copies");
        if (j.gitRepair) await verifyMigrationGitTrees(j, j.targetRoot, true);
        else await sameTree(j.targetRoot, j.stagedTree);
      } else if (target && !(j.mode === "same-root" && samePath(oldPath, j.sourceRoot))) throw new Error("Unknown migration target identity");
      if (staged && j.stagedTree) {
        if (j.gitRepair) await verifyMigrationGitTrees(j, j.stagingRoot, true);
        else await sameTree(j.stagingRoot, j.stagedTree);
      }
      if (installed) { j.operation = "rollback-target"; await saveMigrationJournal(j); await rename(j.targetRoot, j.stagingRoot); }
      if (await info(marker)) await rm(marker);
      for (const directory of [...createdDirectories].reverse()) if (await info(directory)) await rmdir(directory);
      if (j.mode === "same-root" && samePath(oldPath, j.backupRoot)) { j.operation = "restore-source"; await saveMigrationJournal(j); await rename(j.backupRoot, j.sourceRoot); }
      await restoreMigrationGit(j);
      await checkSources(j);
      await restoreMigrationService(j, options.systemService);
      j.recoveryWritersReleased = true; j.serviceResumeStatus = "pending";
        j.operation = "restore-selector"; await saveMigrationJournal(j); await restoreSelector(lock, j);
      j.recovered = true; j.phase = "failed"; j.operation = "complete"; await saveMigrationJournal(j); return result(j);
    } catch {
      j.failedOperation ??= j.operation; j.phase = "rollback_failed"; await saveMigrationJournal(j); return result(j);
    }
  });
  if (!restored.recoveryWritersReleased || restored.phase === "rollback_failed") return restored;
  // Fresh short lock only surrounds immediate OS actions; never await daemon initialization here.
  return withDataRootRecoveryLock(options.homeDir, async () => {
    const j = await readMigrationJournal(path, options.homeDir);
    if (j.serviceResumeStatus === "complete" || j.serviceResumeStatus === "skipped") return result(j);
    const selector = readDataRootSelector(j.homeDir);
    if (JSON.stringify(selector) !== JSON.stringify(j.previousSelector) || await info(movedDataRootMarkerPath(j.sourceRoot))) j.serviceResumeStatus = "skipped";
    else {
      try {
        const expected = j.preparation?.sourceIdentity ?? j.sourceTrees.find(source => samePath(source.path, j.sourceRoot))?.tree.identity;
        if (await identity(j.sourceRoot) !== expected) throw new Error("Restored source identity changed");
        await resumeMigrationService(j, options.systemService); j.serviceResumeStatus = "complete";
      } catch { j.serviceResumeStatus = "failed"; }
    }
    await saveMigrationJournal(j); return result(j);
  });
}
async function restoreSelector(lock: DataRootLock, j: MigrationJournal): Promise<void> { await lock.restoreSelector(j.previousSelector); }
