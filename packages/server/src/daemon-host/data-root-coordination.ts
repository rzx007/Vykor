import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { securePrivateDirectory } from "@vykor/host-config";
import { readPersistentSessionIdsFromCopy } from "@vykor/services/data-root-relocation";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getInitializedDataRootInputs, listDataRootWriters, readDataRootSelector, resolveUserDataPaths, withDataRootLock, type DataRootWriter } from "@vykor/host-config/paths";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@vykor/protocol";
import { readDaemonRegistry, sameDaemonRegistration, type DaemonRegistry } from "../daemon/paths.js";
import { daemonPidAlive, stopRegisteredDaemon } from "./lifecycle.js";
import { acquireRegistryLease } from "./registry-lease.js";
import { migrateDataRoot, recoverDataRootMigration, type DataRootMigrationResult } from "./data-root-migration.js";
import { inspectDataRootMigration, type DataRootMigrationRequest } from "./data-root-sources.js";
import type { MigrationValidationInvocation } from "./data-root-validation.js";
import type { DaemonServiceInvocation, DaemonSystemService } from "./system-service.js";
import { resumeMigrationService } from "./data-root-service.js";
import { captureLegacyDesktopSources, restoreLegacyDesktopSources, type LegacyDesktopSourceReceipt } from "./data-root-legacy-receipt.js";
import { fileDigest, identity, readMigrationJournal, samePath } from "./data-root-migration-journal.js";

export class DataRootWritersBusyError extends Error {
  readonly code = "data_root_writers_busy";
  constructor(readonly writers: Array<Pick<DataRootWriter, "kind" | "pid"> & { path?: string }>) {
    super(`数据根仍有写入者：${writers.map(writer => `${writer.kind} PID ${writer.pid}`).join("、")}。请正常关闭后重试。`);
  }
}
export interface DataRootRuntimeCoordination {
  systemService: DaemonSystemService;
  validation: MigrationValidationInvocation;
  /** Host supplies its packaged normal entry with an explicit target --data-root. */
  target: DaemonServiceInvocation;
  prepareDesktop?(): Promise<{ freshDesktopScanId: string; desktopExportPath: string }>;
  timeoutMs?: number;
}
export interface DataRootRuntimeBlocker { code: "writers_busy" | "daemon_busy" | "control_unavailable" | "daemon_identity_changed"; pid?: number; path?: string }
function readControlledRegistry(path: string): DaemonRegistry | undefined {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !samePath(realpathSync(path), path)) throw new Error();
    const value = readDaemonRegistry(path);
    if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== "string" || !value.token
      || typeof value.url !== "string" || typeof value.storePath !== "string") throw new Error();
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Cannot verify migration daemon registration"); }
}
function sourceDaemon(directories: readonly string[], databasePath?: string) {
  const live = directories.map(directory => ({ file: join(directory, "daemon/registry.json"), registry: readControlledRegistry(join(directory, "daemon/registry.json")) }))
    .filter((entry): entry is { file: string; registry: DaemonRegistry } => !!entry.registry && daemonPidAlive(entry.registry.pid));
  if (live.length > 1) throw new DataRootWritersBusyError(live.map(({ file, registry }) => ({ kind: "daemon", pid: registry.pid, path: file })));
  if (live[0] && (!databasePath || !samePath(live[0].registry.storePath, databasePath))) throw new Error("Source daemon dataset does not match the inspected database");
  return live[0];
}
const headers = (registry: DaemonRegistry) => ({ authorization: `Bearer ${registry.token}`, [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION) });
async function identityMatches(registry: DaemonRegistry): Promise<boolean> {
  try {
    const url = new URL(registry.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:" || !registry.token) return false;
    const response = await fetch(new URL("/debug/process", url), { headers: headers(registry), redirect: "error", signal: AbortSignal.timeout(5000) });
    return response.ok && (await response.json() as { pid?: number }).pid === registry.pid;
  } catch { return false; }
}
async function writers(input: DataRootMigrationRequest, allowDesktop: boolean, daemonPid?: number) {
  const result: DataRootWriter[] = [];
  for (const root of new Set([input.sourceRoot, input.targetRoot])) for (const writer of await listDataRootWriters(root)) {
    if (root === input.sourceRoot && writer.kind === "daemon" && writer.pid === daemonPid) continue;
    if (root === input.sourceRoot && allowDesktop && writer.kind === "desktop" && writer.pid === process.pid) continue;
    result.push(writer);
  }
  return result;
}

/** Local maintenance only. Never initializes another store or reads source SQLite. */
export interface PreparedLegacyDesktopSessionLookup {
  lookup(ids: readonly string[]): Promise<Record<string, "persistent" | "memory" | "unknown">>;
  legacySources?: LegacyDesktopSourceReceipt;
}
export async function prepareLegacyDesktopSessionLookup(input: DataRootMigrationRequest): Promise<PreparedLegacyDesktopSessionLookup> {
  return withDataRootLock(input.homeDir, async () => {
    input = await restoreLegacyDesktopSources(input);
    if (readDataRootSelector(input.homeDir)?.pendingMigration) throw new Error("Recover the pending migration before exporting Desktop business data");
    const preview = await inspectDataRootMigration(input);
    const permitted = new Set(["needs_desktop_export", "git_main_ownership_pending", "fixed_root_environment", "fixed_directory_environment", "target_not_empty", "insufficient_space"]);
    if (preview.blockers.some(item => !permitted.has(item.code)) || preview.databases.length !== 1) throw new Error("Cannot verify the unique legacy Desktop dataset; inspect its sources first");
    const database = preview.databases[0]!;
    const directories = [...new Set([join(preview.sourceRoot, "data"), ...preview.sources.filter(source => source.origin === "runtime-data").map(source => source.from)])];
    const source = sourceDaemon(directories, database.path), busy = await writers(input, false, source?.registry.pid);
    if (busy.length) throw new DataRootWritersBusyError(busy);
    const legacySources = await captureLegacyDesktopSources(input, preview);
    if (source) {
      if (!await identityMatches(source.registry)) throw new Error("Cannot verify the legacy source daemon");
      return { legacySources, lookup: async ids => {
        if (ids.length > 500 || ids.some(id => typeof id !== "string" || !id || id.length > 256)) throw new Error("Invalid legacy session IDs");
        if (!sameDaemonRegistration(readControlledRegistry(source.file), source.registry) || !await identityMatches(source.registry)) throw new Error("Legacy source daemon identity changed");
        const classes: Record<string, "persistent" | "memory" | "unknown"> = Object.create(null);
        for (const id of new Set(ids)) {
          const response = await fetch(new URL(`/sessions/${encodeURIComponent(id)}`, source.registry.url), { headers: headers(source.registry), redirect: "error", signal: AbortSignal.timeout(5000) });
          if (response.status === 404) { classes[id] = "unknown"; continue; }
          if (!response.ok) throw new Error("Legacy source session lookup failed");
          const value = await response.json() as { session?: { id?: string; storage?: string } };
          if (value.session?.id !== id || (value.session.storage !== undefined && !["persistent", "memory"].includes(value.session.storage))) throw new Error("Invalid legacy session classification");
          classes[id] = value.session.storage === "memory" ? "memory" : "persistent";
        }
        if (!sameDaemonRegistration(readControlledRegistry(source.file), source.registry) || !await identityMatches(source.registry)) throw new Error("Legacy source daemon identity changed");
        return classes;
      } };
    }
    const directory = await mkdtemp(join(input.homeDir, ".vykor-desktop-export-"));
    await securePrivateDirectory(directory);
    const directoryIdentity = await identity(directory);
    // The home lease blocks writer admission; source daemon discovery and writer drain happened above.
    // Keep a failed/changed copy for diagnosis; only a verified owned successful copy is removed.
    const expected: Array<{ path: string; identity: string; digest: string }> = [];
    for (const path of [database.path, database.walPath, database.shmPath].filter((path): path is string => !!path)) {
      const entry = preview.entries.find(entry => entry.source === path && entry.kind === "file");
      if (!entry?.digest) throw new Error("Legacy database is outside the verified inventory");
      const before = await fileIdentity(path);
      if (await fileDigest(path) !== entry.digest) throw new Error("Legacy database changed before export");
      const target = join(directory, `sessions.db${path.slice(database.path.length)}`);
      await copyFile(path, target);
      if (await fileDigest(target) !== entry.digest) throw new Error("Legacy export copy digest mismatch");
      expected.push({ path, identity: before, digest: entry.digest });
    }
    const persistent = new Set(readPersistentSessionIdsFromCopy(join(directory, "sessions.db")));
    for (const entry of expected) if (await fileIdentity(entry.path) !== entry.identity || await fileDigest(entry.path) !== entry.digest) throw new Error("Legacy source changed during export preparation");
    if (await identity(directory) !== directoryIdentity) throw new Error("Legacy export temporary directory identity changed");
    await rm(directory, { recursive: true });
    return { legacySources, lookup: async ids => {
      if (ids.length > 500 || ids.some(id => typeof id !== "string" || !id || id.length > 256)) throw new Error("Invalid legacy session IDs");
      return Object.fromEntries([...new Set(ids)].map(id => [id, persistent.has(id) ? "persistent" as const : "unknown" as const]));
    } };
  });
}
async function fileIdentity(path: string): Promise<string> {
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink() || !samePath(realpathSync(path), path)) throw new Error("Legacy database file identity is unsafe");
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
}

/** Product coordinator. The file-layer core still supports deliberate prepare-only embedding. */
export async function migrateDataRootAndRestart(input: DataRootMigrationRequest, options: DataRootRuntimeCoordination): Promise<DataRootMigrationResult & { startup: "ready" | "failed" | "not-started"; blockers?: DataRootRuntimeBlocker[] }> {
  const preview = await inspectDataRootMigration(input);
  const runtimeDirectories = [...new Set([join(preview.sourceRoot, "data"), ...preview.sources.filter(source => source.origin === "runtime-data").map(source => source.from)])];
  const dataset = preview.databases.length === 1 ? preview.databases[0]!.path : undefined;
  const originalSource = sourceDaemon(runtimeDirectories, dataset), original = originalSource?.registry;
  const busy = await writers(input, !!options.prepareDesktop, original?.pid);
  if (busy.length) throw new DataRootWritersBusyError(busy.map(({ pid, kind }) => ({ pid, kind })));
  const rootFlag = options.target.args.findIndex(arg => arg === "--data-root");
  if (!(rootFlag >= 0 && options.target.args[rootFlag + 1] === input.targetRoot) && !options.target.args.includes(`--data-root=${input.targetRoot}`)) throw new Error("New daemon entry must explicitly select the migration target");
  const registryPath = originalSource?.file ?? resolveUserDataPaths(input.sourceRoot).daemonRegistryFilePath;
  const blockers: DataRootRuntimeBlocker[] = [];
  const migrated = await migrateDataRoot(input, {
    async prepareStoppedCopy(context) {
      const currentSource = sourceDaemon([...new Set([join(preview.sourceRoot, "data"), ...context.runtimeDirectories])], dataset);
      const busy = await writers(input, !!options.prepareDesktop, currentSource?.registry.pid);
      if (busy.length) { blockers.push(...busy.map(({ pid, path }) => ({ code: "writers_busy" as const, pid, path }))); throw new DataRootWritersBusyError(busy); }
      const leases: Array<() => Promise<void>> = [];
      const compromised = new AbortController();
      try {
        // Nonwaiting control acquisition: an SDK owner never waits on this held home lock.
        const sourceFiles = [...new Set([join(preview.sourceRoot, "data"), ...context.runtimeDirectories])].map(directory => join(directory, "daemon/registry.json"));
        for (const file of new Set([...sourceFiles, resolveUserDataPaths(input.targetRoot).daemonRegistryFilePath])) {
          if (!await lstat(dirname(file)).then(value => value.isDirectory() && !value.isSymbolicLink(), error => { if (error.code === "ENOENT") return false; throw error; })) continue;
          try { leases.push(await acquireRegistryLease(file, "control", () => { compromised.abort(new Error("Migration control lease compromised")); })); }
          catch { blockers.push({ code: "control_unavailable", path: file }); throw new Error("Migration registry control is unavailable"); }
          if (!sourceFiles.some(source => samePath(source, file))) {
            const target = readControlledRegistry(file);
            if (target && daemonPidAlive(target.pid)) { blockers.push({ code: "daemon_busy", pid: target.pid, path: file }); throw new DataRootWritersBusyError([{ kind: "daemon", pid: target.pid, path: file }]); }
          }
        }
        await context.captureSystemService(options.systemService);
        const desktop = options.prepareDesktop ? await options.prepareDesktop() : {};
        const current = currentSource?.registry;
        if (current && daemonPidAlive(current.pid)) {
          if (current.pid === process.pid || !original || !sameDaemonRegistration(current, original) || !await identityMatches(current)) { blockers.push({ code: "daemon_identity_changed", pid: current.pid }); throw new Error("Cannot verify the source daemon process"); }
          const response = await fetch(new URL("/maintenance/prepare-root-migration", current.url), { method: "POST", headers: headers(current), signal: AbortSignal.any([compromised.signal, AbortSignal.timeout(60000)]) });
          if (!response.ok || (await response.json() as { prepared?: boolean }).prepared !== true) { blockers.push({ code: "daemon_busy", pid: current.pid }); throw new Error("Source daemon still has active runs, uploads, terminals or plugin work"); }
          if (!sameDaemonRegistration(readControlledRegistry(registryPath), current)) throw new Error("Source daemon registration changed while draining");
        }
        await context.pauseSystemService();
        const afterPause = sourceDaemon([...new Set([join(preview.sourceRoot, "data"), ...context.runtimeDirectories])], dataset);
        if (afterPause && (!current || !samePath(afterPause.file, registryPath) || !sameDaemonRegistration(afterPause.registry, current))) {
          blockers.push({ code: "daemon_identity_changed", pid: afterPause.registry.pid }); throw new Error("Source daemon changed before stop");
        }
        await stopRegisteredDaemon(async candidate => !!current && sameDaemonRegistration(candidate, current), registryPath);
        for (const file of sourceFiles) if (await lstat(dirname(file)).then(() => true, () => false)) {
          const releaseOwner = await acquireRegistryLease(file, "owner", () => {}); await releaseOwner();
        }
        const remainingSource = sourceDaemon([...new Set([join(preview.sourceRoot, "data"), ...context.runtimeDirectories])], dataset);
        if (remainingSource) { blockers.push({ code: "daemon_busy", pid: remainingSource.registry.pid }); throw new Error("Source daemon is still running"); }
        const remaining = await writers(input, false);
        if (remaining.length) throw new DataRootWritersBusyError(remaining);
        compromised.signal.throwIfAborted();
        return desktop;
      } finally { for (const release of leases.reverse()) await release(); }
    },
    async withInstalledCopy(handle) {
      await handle.validateInNewProcess(options.validation);
      await handle.commit();
      await handle.markWritersReleased();
    },
  });
  if (!migrated.writersReleased) {
    const recovered = await recoverDataRootMigration(migrated.journalPath, { homeDir: input.homeDir, systemService: options.systemService });
    return { ...recovered, startup: "not-started", ...(blockers.length ? { blockers } : {}) };
  }
  // Ordinary initialization/ownership must happen after the core releases its home lock.
  try {
    await withDataRootLock(input.homeDir, async () => {
      const journal = await readMigrationJournal(migrated.journalPath, input.homeDir), selector = readDataRootSelector(input.homeDir);
      if (!selector || selector.pendingMigration || !samePath(selector.dataRoot, input.targetRoot) || await identity(input.targetRoot) !== journal.stagingIdentity) throw new Error("A later root selection superseded this startup");
      await resumeMigrationService(journal, options.systemService, true);
    });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: input.homeDir, USERPROFILE: input.homeDir };
    const originalInputs = input.rootInputs ?? getInitializedDataRootInputs();
    for (const key of ["VYKOR_CONFIG_DIR", "VYKOR_DATA_DIR", "VYKOR_CHANNELS_DIR", "VYKOR_IMAGE_ATTACHMENT_CACHE_DIR"] as const)
      env[key] = originalInputs?.environment[key] ?? input.environment?.[key];
    const child = spawn(options.target.command, options.target.args, { cwd: options.target.cwd, env, detached: true, stdio: "ignore", windowsHide: true });
    let failed = false; child.once("error", () => { failed = true; }); child.unref();
    const deadline = Date.now() + (options.timeoutMs ?? 45000), file = resolveUserDataPaths(input.targetRoot).daemonRegistryFilePath;
    while (!failed && Date.now() < deadline) {
      const registry = readControlledRegistry(file);
      if (registry && registry.pid !== original?.pid && registry.token !== original?.token
        && registry.storePath === resolveUserDataPaths(input.targetRoot).sessionsDatabasePath && await identityMatches(registry)) return { ...migrated, startup: "ready" };
      await sleep(100);
    }
  } catch { /* Release is irreversible: report forward repair, never restore old data. */ }
  return { ...migrated, startup: "failed" };
}
