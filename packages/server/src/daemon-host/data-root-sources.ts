import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, open, readFile, readdir, readlink, stat, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import {
  getInitializedDataRootInputs, isCompleteAbsolutePath, isWithinManagedPath, readDataRootSelector,
  relocateManagedPath, requireCompleteAbsolutePath, resolveManagedRealPath, resolveUserDataPaths,
  type InitializedDataRootInputs, type ManagedPathMove, type RootEnvironment,
} from "@vykor/host-config/paths";
import { loadSettingsFile } from "@vykor/host-config";
import { dataLocationFile, readLegacyDataLocation } from "./data-location.js";
import { inspectMigrationGit, type MigrationGitWorktree, type RegisteredMigrationWorktree } from "./data-root-git.js";
import { readDatabasePathRegistrations } from "@vykor/services/data-root-relocation";

export interface DataRootMigrationRequest {
  homeDir: string;
  sourceRoot: string;
  targetRoot: string;
  /** Existing legacy-import manifest produced by Desktop; never a LevelDB dump. */
  desktopExportPath?: string;
  environment?: RootEnvironment;
  rootInputs?: InitializedDataRootInputs;
  legacy?: {
    documentsDir?: string;
    userDataDir?: string;
    dataLocationPath?: string;
    databasePath?: string;
    /** Host's registered managed workspaces, including scheduled tasks with no project. */
    workspacePaths?: readonly string[];
    imageAttachmentCacheDir?: string;
  };
  projectPaths?: readonly string[];
}
export interface MigrationBlocker { code: string; path?: string; message: string }
export interface MigrationSourceEntry {
  source: string; target: string; kind: "file" | "directory" | "link"; bytes: number; digest?: string;
}
export interface DataRootMigrationPreview {
  sourceRoot: string; targetRoot: string; mode: "same-root" | "different-root";
  moves: ManagedPathMove[];
  sources: Array<ManagedPathMove & { origin: string }>;
  entries: MigrationSourceEntry[];
  links: Array<{ path: string; target: string; action: "preserve" | "relocate" }>;
  databases: Array<{ path: string; walPath?: string; shmPath?: string; inspection: "file-only" }>;
  blockers: MigrationBlocker[];
  gitWorktrees: MigrationGitWorktree[];
  files: number; bytes: number;
  /** Mandatory gates for T8/T10, not claims that these checks have passed. */
  requiredValidations: string[];
  writersToClose: string[];
  impacts: string[];
  desktopScanId?: string;
  registrationSnapshot: { workspaces: "not-provided" | "host-supplied"; projects: "not-provided" | "host-supplied" };
}

const pathKey = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const same = (a: string, b: string) => pathKey(a) === pathKey(b);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const supportedSource = (id: string) => /^(composer|notes|quick-notes|image-annotations:[a-f0-9]{64})$/.test(id);
const hashPattern = /^[a-f0-9]{64}$/;
async function metadata(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error(`Invalid JSON: ${path}`); }
}

/** File-only inventory. Never opens SQLite, creates a directory, acquires a lock or parses LevelDB. */
export async function inspectDataRootMigration(input: DataRootMigrationRequest): Promise<DataRootMigrationPreview> {
  return inspectSources(input, []);
}

/** Internal stopped-copy entry: ownership comes from SQLite, never a public request hint. */
export async function inspectDataRootMigrationFromStoppedCopy(input: DataRootMigrationRequest, databasePath: string, managedRoots: readonly string[]) {
  const registrations = readDatabasePathRegistrations(databasePath, { managedRoots });
  if (registrations.unsupported.length || registrations.schema !== "supported") throw new Error("Unsupported stopped-copy registrations");
  const documents = input.legacy?.documentsDir;
  const workspaces = documents ? registrations.workspacePaths.filter(path => isWithinManagedPath(path, join(documents, "Vykor")) && !isWithinManagedPath(path, join(documents, "Vykor/channels"))) : [];
  const preview = await inspectSources({ ...input, projectPaths: [...new Set([...(input.projectPaths ?? []), ...registrations.projectPaths])], legacy: { ...input.legacy, workspacePaths: [...new Set([...(input.legacy?.workspacePaths ?? []), ...workspaces])] } }, registrations.workspacePaths);
  return { preview, registrations };
}

async function inspectSources(input: DataRootMigrationRequest, ownedMains: readonly string[]): Promise<DataRootMigrationPreview> {
  const preview: DataRootMigrationPreview = {
    sourceRoot: input.sourceRoot, targetRoot: input.targetRoot, mode: "different-root", moves: [], sources: [], entries: [], links: [], databases: [],
    blockers: [], gitWorktrees: [], files: 0, bytes: 0,
    requiredValidations: ["sqlite-on-stopped-copy", "registered-paths-from-stopped-copy", "source-stability-after-stop", "target-write-permissions", "target-space-before-copy"],
    registrationSnapshot: { workspaces: input.legacy?.workspacePaths === undefined ? "not-provided" : "host-supplied", projects: input.projectPaths === undefined ? "not-provided" : "host-supplied" },
    writersToClose: ["daemon and auto-start supervisor", "SQLite and managed runs/terminals/uploads/plugins"],
    impacts: ["Temporary chats remain in memory and will be lost on restart; active temporary sessions must be handled before migration."],
  };
  const block = (code: string, path: string | undefined, message: string) => { preview.blockers.push({ code, ...(path ? { path } : {}), message }); };
  const check = async (code: string, path: string, action: () => Promise<unknown>) => {
    try {
      if (code !== "source_unreadable" && isWithinManagedPath(path, source) && !isWithinManagedPath(await resolveManagedRealPath(path), source)) {
        block("unsafe_junction", path, "A source path resolves outside its selected managed root."); return undefined;
      }
      return await action();
    } catch { block(code, path, `${code}: inspect the named source before migrating.`); return undefined; }
  };
  let home: string, source: string, target: string;
  try {
    home = requireCompleteAbsolutePath(input.homeDir, "homeDir");
    source = requireCompleteAbsolutePath(input.sourceRoot, "sourceRoot");
    target = requireCompleteAbsolutePath(input.targetRoot, "targetRoot");
    source = await resolveManagedRealPath(source);
    const actualTarget = await resolveManagedRealPath(target);
    // Explicit source aliases may identify the same data; a target junction may install outside the requested location.
    if (!same(actualTarget, target) && !same(actualTarget, source)) block("unsafe_junction", target, "Target resolves outside the explicitly selected physical path.");
    target = actualTarget;
    home = await resolveManagedRealPath(home);
  } catch { block("invalid_path", undefined, "homeDir, sourceRoot and targetRoot must be complete, accessible absolute paths."); return preview; }
  preview.sourceRoot = source; preview.targetRoot = target; preview.mode = same(source, target) ? "same-root" : "different-root";
  const paths = resolveUserDataPaths(target);
  const projects: string[] = [];
  const deferredGitMains: string[] = [], registeredTrees: RegisteredMigrationWorktree[] = [];
  for (const path of input.projectPaths ?? []) {
    await check("invalid_project_path", path, async () => { projects.push(await resolveManagedRealPath(path), resolve(path)); });
  }
  for (const root of [source, target]) {
    if (same(root, parse(root).root) || isWithinManagedPath(home, root) || projects.some(project => isWithinManagedPath(project, root)))
      block("unsafe_root", root, "A managed root cannot be a disk root, the user home or an ancestor of a real project.");
  }
  if (!same(source, target) && (isWithinManagedPath(source, target) || isWithinManagedPath(target, source)))
    block("overlapping_roots", target, "Source and target must not contain each other.");
  if (preview.blockers.some(item => ["unsafe_root", "overlapping_roots", "unsafe_junction"].includes(item.code))) return preview;
  if ((await metadata(source))?.isDirectory() !== true) { block("source_missing", source, "The selected source directory is unavailable."); return preview; }
  const rootInputs = input.rootInputs ?? getInitializedDataRootInputs();
  const env: RootEnvironment = input.environment ?? rootInputs?.environment ?? {};
  const optionalPaths = { ...Object.fromEntries(["VYKOR_CONFIG_DIR", "VYKOR_DATA_DIR", "VYKOR_CHANNELS_DIR", "VYKOR_IMAGE_ATTACHMENT_CACHE_DIR"].map(key => [key, env[key]])),
    documentsDir: input.legacy?.documentsDir, userDataDir: input.legacy?.userDataDir, databasePath: input.legacy?.databasePath,
    dataLocationPath: input.legacy?.dataLocationPath, imageAttachmentCacheDir: input.legacy?.imageAttachmentCacheDir };
  for (const [name, value] of Object.entries(optionalPaths)) if (value !== undefined && !isCompleteAbsolutePath(value))
    block("invalid_path", value, `${name} must be a complete absolute path.`);
  if (preview.blockers.some(item => item.code === "invalid_path")) return preview;
  const fixedRoot = rootInputs?.environment.VYKOR_CONFIG_DIR ?? env.VYKOR_CONFIG_DIR;
  if (fixedRoot !== undefined && (!isCompleteAbsolutePath(fixedRoot) || !same(await resolveManagedRealPath(fixedRoot), target)))
    block("fixed_root_environment", fixedRoot, "The original external VYKOR_CONFIG_DIR would override the new selector. Update that launch environment before committing.");
  for (const [name, expected] of Object.entries({ VYKOR_DATA_DIR: paths.dataDir, VYKOR_CHANNELS_DIR: paths.channelsDir, VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: paths.imageAttachmentCacheDir })) {
    const fixed = rootInputs?.environment[name as keyof InitializedDataRootInputs["environment"]];
    if (fixed !== undefined && (!isCompleteAbsolutePath(fixed) || !same(await resolveManagedRealPath(fixed), expected)))
      block("fixed_directory_environment", fixed, `The original external ${name} would keep an obsolete directory override active after migration.`);
  }
  await check("invalid_selector", join(home, ".vykor-root.json"), async () => { readDataRootSelector(home); });
  await check("invalid_settings", join(source, "settings.json"), () => loadSettingsFile(join(source, "settings.json")));
  const manifestPath = input.desktopExportPath ?? resolveUserDataPaths(source).legacyImportFilePath;
  let manifest: Record<string, any> | undefined;
  await check("invalid_desktop_export", manifestPath, async () => {
    requireCompleteAbsolutePath(manifestPath, "desktopExportPath");
    const value = await readJson(manifestPath);
    if (value !== undefined) {
      if (!record(value) || value.version !== 1 || !record(value.sources) || !Object.entries(value.sources).every(([id, value]) =>
        (supportedSource(id) || id === "git-settings") && validConfirmation(value))) throw new Error("manifest");
      manifest = value;
    }
  });
  const scan = manifest?.desktopScan;
  const hasBrowserSources = Object.keys(manifest?.sources ?? {}).some(supportedSource);
  const needDesktopExport = (path: string) => {
    const unresolved = Object.values(manifest?.sources ?? {}).filter((value): value is Record<string, any> => record(value) && value.status === "partial" && value.retainedSourceAcknowledged !== true)
      .reduce((count, value) => count + value.unresolvedSessionIds.length, 0);
    block("needs_desktop_export", path, `Open Desktop to scan/export all supported business keys, then handle unresolved composer sources and retry. Browser storage is never parsed by CLI.${unresolved ? ` Unresolved sessions: ${unresolved}; reason: session-not-found.` : ""}`);
  };
  const documents = input.legacy?.documentsDir ?? (record(scan) && isCompleteAbsolutePath(scan.documentsDir) ? scan.documentsDir : undefined);
  const userData = input.legacy?.userDataDir ?? (record(scan) && isCompleteAbsolutePath(scan.userDataDir) ? scan.userDataDir : undefined);
  const addSource = async (kind: ManagedPathMove["kind"], from: string, to: string, origin: string, scope = from) => {
    await check("invalid_source_path", from, async () => {
      const preserveLink = origin === "documents-unregistered" && (await metadata(from))?.isSymbolicLink();
      const canonical = preserveLink ? resolve(from) : await resolveManagedRealPath(from);
      const info = await metadata(canonical);
      if (!info) return;
      if (info.isDirectory() && (same(canonical, parse(canonical).root) || isWithinManagedPath(home, canonical)
        || (!same(canonical, source) && isWithinManagedPath(target, canonical)))) {
        block("unsafe_source_scope", from, "A whole secondary source cannot be a disk/home root or contain the migration target."); return;
      }
      if (!isWithinManagedPath(preserveLink ? await resolveManagedRealPath(dirname(from)) : canonical, await resolveManagedRealPath(scope))) {
        block("unsafe_junction", from, "A derived source resolves outside its selected managed scope."); return;
      }
      if (!isWithinManagedPath(to, target)) throw new Error("outside target");
      const existing = preview.sources.find(item => same(item.from, canonical));
      if (existing) {
        if (!same(existing.to, to)) block("source_alias_conflict", from, "The same physical source was assigned to different targets.");
        else if (!same(from, canonical) && !preview.moves.some(move => same(move.from, from))) preview.moves.push({ kind, from: resolve(from), to });
        return;
      }
      preview.sources.push({ kind, from: canonical, to, origin });
      preview.moves.push({ kind, from: canonical, to });
      if (!same(from, canonical)) preview.moves.push({ kind, from: resolve(from), to });
    });
  };
  await addSource("user-root", input.sourceRoot, target, "user-root");
  const dataDirs = [join(source, "data")];
  if (env.VYKOR_DATA_DIR) dataDirs.push(env.VYKOR_DATA_DIR);
  // Only a directly selected custom database grants an independent scope.
  // Derived paths keep their owner even after resolving directory aliases.
  const dbPaths: Array<{ path: string; required: boolean; scope?: string }> = [];
  if (input.legacy?.databasePath) dbPaths.push({ path: input.legacy.databasePath, required: true });
  const locationPaths = [dataLocationFile(join(source, "data")), ...(env.VYKOR_DATA_DIR ? [dataLocationFile(env.VYKOR_DATA_DIR)] : []),
    ...(input.legacy?.dataLocationPath ? [input.legacy.dataLocationPath] : []),
    ...(userData ? [join(userData, "runtime-data-location.json")] : [])];
  for (const locationPath of new Set(locationPaths)) await check("invalid_data_location", locationPath, async () => {
    requireCompleteAbsolutePath(locationPath, "data location");
    const location = await readLegacyDataLocation(locationPath);
    if (location) { dataDirs.push(location.directory); dbPaths.push({ path: location.storePath, required: true, scope: location.directory }); }
  });
  for (const directory of new Set(dataDirs)) {
    await addSource("runtime-data", directory, paths.dataDir, "runtime-data", same(directory, join(source, "data")) ? source : directory);
    dbPaths.push({ path: join(directory, "session-runtime", "sessions.db"), required: false, scope: directory });
    await addSource("runtime-data", join(directory, "attachments", "images"), paths.imageAttachmentCacheDir, "cli-default-image-cache", directory);
  }
  const seenDbs = new Set<string>();
  for (const selected of dbPaths) await check("invalid_database", selected.path, async () => {
    const path = await resolveManagedRealPath(selected.path);
    const scope = selected.scope ? await resolveManagedRealPath(selected.scope) : dirname(path);
    if (!isWithinManagedPath(path, scope)) {
      block("unsafe_junction", selected.path, "A derived database resolves outside its selected managed scope."); return;
    }
    const info = await metadata(path);
    if (!info) {
      if (selected.required || await metadata(`${path}-wal`)) block("database_missing", path, "The selected database is missing; sidecars are not an empty database.");
      return;
    }
    if (seenDbs.has(pathKey(path))) return;
    seenDbs.add(pathKey(path));
    const db: DataRootMigrationPreview["databases"][number] = { path, inspection: "file-only" };
    preview.databases.push(db);
    await addSource("runtime-data", path, paths.sessionsDatabasePath, "database", scope);
    for (const suffix of ["-wal", "-shm"] as const) if (await metadata(path + suffix)) {
      if (!isWithinManagedPath(await resolveManagedRealPath(path + suffix), scope)) {
        block("unsafe_junction", path + suffix, "A database sidecar resolves outside its selected managed scope."); continue;
      }
      if (suffix === "-wal") db.walPath = path + suffix; else db.shmPath = path + suffix;
      await addSource("runtime-data", path + suffix, paths.sessionsDatabasePath + suffix, "database-sidecar", scope);
    }
    for (const name of ["attachments", "attachment-session-resources", "notes", "storage-policy.json", "usage-settings.json"])
      await addSource("runtime-data", join(dirname(path), name), join(paths.sessionRuntimeDir, name), "database-resource", dirname(path));
    if (!info.isFile()) throw new Error("not a database file");
    await validateDatabaseHeader(path);
    if (db.walPath) await check("invalid_wal", db.walPath, () => validateWalHeader(db.walPath!));
  });
  if (documents) {
    const legacyRoot = join(documents, "Vykor");
    await addSource("channel", join(legacyRoot, "channels"), paths.channelsDir, "documents-channels", legacyRoot);
    for (const workspace of input.legacy?.workspacePaths ?? []) {
      if (!isWithinManagedPath(workspace, legacyRoot) || isWithinManagedPath(workspace, join(legacyRoot, "channels"))) {
        block("invalid_workspace_scope", workspace, "A registered ordinary workspace must be inside the supplied Documents/Vykor scope and outside channels."); continue;
      }
      const actual = await resolveManagedRealPath(workspace);
      if (!isWithinManagedPath(actual, await resolveManagedRealPath(legacyRoot))) { block("unsafe_junction", workspace, "Workspace escapes the managed Documents root."); continue; }
      await addSource("workspace", workspace, join(paths.workspacesDir, relative(legacyRoot, workspace)), "documents-workspace");
    }
  } else preview.requiredValidations.push("host-documents-location");
  if (env.VYKOR_CHANNELS_DIR) await addSource("channel", env.VYKOR_CHANNELS_DIR, paths.channelsDir, "channels-override");
  const images = input.legacy?.imageAttachmentCacheDir ?? env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR;
  if (images) await addSource("runtime-data", images, paths.imageAttachmentCacheDir, "cli-image-cache");
  await addSource("user-root", join(home, ".vykor", "output_styles"), paths.outputStylesDir, "fixed-output-styles");
  if (userData) {
    await check("invalid_desktop_profile", userData, async () => { requireCompleteAbsolutePath(userData, "userDataDir"); });
    const gitFile = join(userData, "git-settings.json");
    await check("invalid_git_settings", gitFile, async () => {
      const git = await readJson(gitFile);
      if (git === undefined) return;
      if (!validGitSettings(git)) throw new Error("git settings");
      const configDir = git.preferences.worktreeRoot ?? userData;
      requireCompleteAbsolutePath(configDir, "worktreeRoot");
      const worktrees = join(configDir, "worktrees");
      await addSource("worktree", worktrees, paths.worktreesDir, "desktop-worktrees", configDir);
      for (const item of git.worktrees) {
        if (!record(item) || !isCompleteAbsolutePath(item.path) || !isCompleteAbsolutePath(item.projectPath) || !isCompleteAbsolutePath(item.configDir)) throw new Error("worktree record");
        const registeredRoot = join(item.configDir, "worktrees");
        if (!isWithinManagedPath(item.path, registeredRoot)) block("unsafe_worktree", item.path, "Registered worktree is outside its recorded managed worktrees directory.");
        else await addSource("worktree", registeredRoot, paths.worktreesDir, "desktop-registered-worktrees", item.configDir);
        registeredTrees.push(item as RegisteredMigrationWorktree);
        await protectGitMain(item.projectPath);
      }
      const confirmed = manifest?.sources["git-settings"];
      if (confirmed && confirmed.sourceDigest !== await fileDigest(gitFile)) block("desktop_source_changed", gitFile, "The retained git-settings source has changed since import.");
      // An imported target may have legitimate newer edits; do not overwrite it with the retained source.
      if (!confirmed) await addSource("worktree", gitFile, paths.gitSettingsFilePath, "desktop-git-settings");
    });
    await addSource("worktree", join(userData, "worktrees"), paths.worktreesDir, "desktop-default-worktrees", userData);
    const browserExists = !!await metadata(join(userData, "Local Storage"));
    if (browserExists || scan !== undefined || hasBrowserSources) {
      preview.writersToClose.push("Desktop renderer and business-data writers");
      preview.requiredValidations.push("fresh-desktop-scan-after-freeze");
      if (!validDesktopScan(scan, manifest?.sources, userData)) needDesktopExport(userData);
      else preview.desktopScanId = scan.id;
    }
  } else {
    preview.requiredValidations.push("host-desktop-profile-location");
    if (hasBrowserSources) needDesktopExport(manifestPath);
  }
  async function protectGitMain(path: string) {
    const actual = await resolveManagedRealPath(path);
    if (ownedMains.some(owned => same(owned, path) && same(owned, actual))) return;
    if (isWithinManagedPath(path, source) || (documents && isWithinManagedPath(path, join(documents, "Vykor")))) {
      deferredGitMains.push(actual, resolve(path));
      block("git_main_ownership_pending", path, "The stopped database must prove that this Git main repository is an allocated managed workspace.");
    } else projects.push(actual, resolve(path));
  }
  await check("invalid_git_settings", resolveUserDataPaths(source).gitSettingsFilePath, async () => {
    const settings = await readJson(resolveUserDataPaths(source).gitSettingsFilePath);
    if (settings === undefined) return;
    if (!validGitSettings(settings)) throw new Error("git settings");
    for (const tree of settings.worktrees) { registeredTrees.push(tree); await protectGitMain(tree.projectPath); }
  });
  for (const root of [source, target]) if (projects.some(project => isWithinManagedPath(project, root)))
    block("unsafe_root", root, "The managed root contains a registered real project.");
  if (preview.blockers.some(item => item.code === "unsafe_root")) return preview;
  for (const item of preview.sources) if (projects.some(project => isWithinManagedPath(project, item.from)))
    block("unsafe_managed_scope", item.from, "A selected secondary managed scope contains a registered real project.");
  if (preview.blockers.some(item => item.code === "unsafe_managed_scope")) return preview;
  if (documents) {
    const legacyRoot = join(documents, "Vykor");
    // No broad Documents mapping may cover an external project. Split only its ancestors.
    const unregistered = async (directory: string): Promise<void> => {
      await check("invalid_documents_scope", directory, async () => {
        if (!(await metadata(directory))) return;
        for (const name of (await readdir(directory)).sort()) {
          const path = join(directory, name);
          if ([...projects, ...deferredGitMains].some(project => isWithinManagedPath(path, project)) || preview.sources.some(item => same(item.from, path))) continue;
          if (projects.some(project => isWithinManagedPath(project, path))) { await unregistered(path); continue; }
          await addSource("workspace", path, join(paths.workspacesDir, "legacy", relative(legacyRoot, path)), "documents-unregistered", legacyRoot);
        }
      });
    };
    await unregistered(legacyRoot);
  }

  const runtimeRoots = preview.sources.filter(item => item.origin === "runtime-data").map(item => item.from);
  const excluded = [...projects, ...deferredGitMains, join(source, "settings.json.lock"), join(source, "runtime-environment-secrets.json.lock"), ...runtimeRoots.flatMap(directory => ["registry.json", "registry.json.owner.lock", "registry.json.sdk-start.lock"].map(name => join(directory, "daemon", name)))];
  const visited = new Set<string>();
  const destinations = new Map<string, MigrationSourceEntry>();
  const walk = async (path: string): Promise<void> => {
    if (visited.has(pathKey(path)) || excluded.some(item => isWithinManagedPath(path, item))
      || /[\\/]\.vykor[\\/]settings\.json\.lock$/.test(path)
      || (path.endsWith(".manage.lock") && runtimeRoots.some(root => isWithinManagedPath(path, join(root, "memory"))))) return;
    visited.add(pathKey(path));
    await check("source_unreadable", path, async () => {
      const info = await lstat(path), destination = relocateManagedPath(path, preview.moves);
      const entry: MigrationSourceEntry = { source: path, target: destination, kind: info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : "file", bytes: info.isFile() ? info.size : 0 };
      if (entry.kind === "link") {
        const link = await readlink(path), original = await resolveManagedRealPath(resolve(dirname(path), link));
        const moved = relocateManagedPath(original, preview.moves);
        preview.links.push({ path, target: isAbsolute(link) ? moved : relative(dirname(destination), moved), action: same(original, moved) ? "preserve" : "relocate" });
        entry.digest = createHash("sha256").update(link).digest("hex");
      } else if (entry.kind === "file") {
        if (!info.isFile()) { block("unsupported_file_type", path, "Only directories, regular files and preserved symbolic links may be migrated."); return; }
        entry.digest = await fileDigest(path);
        const after = await lstat(path);
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) block("source_changed", path, "Source changed during read-only inspection; retry after its writer stops.");
      }
      const prior = destinations.get(pathKey(destination));
      if (prior) {
        if (prior.target !== destination) block("case_collision", destination, "Source names differ only by target filesystem case.");
        if (prior.kind !== entry.kind || (entry.kind !== "directory" && prior.digest !== entry.digest)) block("content_conflict", destination, "Different source contents would occupy the same destination.");
      } else destinations.set(pathKey(destination), entry);
      preview.entries.push(entry);
      if (entry.kind === "directory") {
        for (const name of (await readdir(path)).sort()) await walk(join(path, name));
      } else { preview.files++; preview.bytes += entry.bytes; }
    });
  };
  for (const item of preview.sources) await walk(item.from);
  await inspectMigrationGit(preview, registeredTrees);
  for (const tree of preview.gitWorktrees) {
    if ((isWithinManagedPath(tree.mainFrom, source) || !same(tree.mainFrom, tree.mainTo))
      && !ownedMains.some(path => same(path, tree.mainFrom))
      && !preview.blockers.some(blocker => blocker.code === "git_main_ownership_pending" && blocker.path === tree.mainFrom))
      block("git_main_ownership_pending", tree.mainFrom, "The stopped database must prove that this Git main repository is an allocated managed workspace.");
  }
  const databaseSignatures = new Set(preview.databases.map(db => [db.path, db.walPath].map(path => path ? preview.entries.find(entry => same(entry.source, path))?.digest : "").join(":")));
  if (databaseSignatures.size > 1) block("database_conflict", undefined, "Multiple different database/WAL datasets cannot be merged automatically.");
  if (!same(source, target)) await check("target_unreadable", target, async () => {
    const info = await metadata(target);
    if (info && (!info.isDirectory() || (await readdir(target)).length)) block("target_not_empty", target, "Nonempty target ownership is unconfirmed; no files will be written.");
  });
  let ancestor = dirname(target);
  while (!(await metadata(ancestor)) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  await check("target_not_writable", ancestor, () => access(ancestor, constants.W_OK | constants.X_OK));
  if (await metadata(target)) await check("target_not_writable", target, () => access(target, constants.W_OK | constants.X_OK));
  await check("target_space_unknown", ancestor, async () => {
    const capacity = await statfs(ancestor);
    if (capacity.bavail * capacity.bsize < preview.bytes) block("insufficient_space", ancestor, "Available space is smaller than the independently copied source bytes.");
  });
  return preview;
}

function validDesktopScan(scan: unknown, sources: unknown, userData: string): scan is Record<string, any> {
  if (!record(scan) || scan.version !== 1 || typeof scan.id !== "string" || !scan.id || !isCompleteAbsolutePath(scan.userDataDir)
    || !same(scan.userDataDir, userData) || !record(scan.sources) || !record(sources)) return false;
  return Object.entries(scan.sources).every(([id, digest]) => {
    const confirmation = sources[id];
    return supportedSource(id) && typeof digest === "string" && hashPattern.test(digest) && record(confirmation)
      && confirmation.sourceDigest === digest && ((confirmation.status ?? "confirmed") === "confirmed" || (confirmation.status === "partial" && confirmation.retainedSourceAcknowledged === true));
  });
}

function validConfirmation(value: unknown): boolean {
  return record(value) && typeof value.sourceDigest === "string" && hashPattern.test(value.sourceDigest)
    && typeof value.targetDigest === "string" && hashPattern.test(value.targetDigest) && Number.isSafeInteger(value.revision) && value.revision >= 0
    && (value.status === undefined || value.status === "confirmed" || value.status === "partial")
    && (value.unresolvedSessionIds === undefined || (Array.isArray(value.unresolvedSessionIds) && value.unresolvedSessionIds.length <= 10000
      && value.unresolvedSessionIds.every((id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 256)))
    && (value.status !== "partial" || (value.reason === "session-not-found" && Array.isArray(value.unresolvedSessionIds)))
    && (value.retainedSourceAcknowledged === undefined || typeof value.retainedSourceAcknowledged === "boolean");
}

function validGitSettings(value: unknown): value is Record<string, any> {
  if (!record(value) || value.version !== 1 || !record(value.preferences) || !Array.isArray(value.worktrees)) return false;
  const pref = value.preferences;
  return ["uncommitted", "staged", "unstaged"].includes(pref.defaultScope) && ["unified", "split"].includes(pref.viewMode)
    && typeof pref.ignoreWhitespace === "boolean" && typeof pref.autoCleanup === "boolean" && ["current", "worktree"].includes(pref.defaultTaskLocation)
    && typeof pref.branchPrefix === "string" && pref.branchPrefix.length <= 100 && !/[\s~^:?*\[\\\x00-\x1f]/.test(pref.branchPrefix)
    && !pref.branchPrefix.includes("..") && !pref.branchPrefix.includes("//") && !/^[-/]/.test(pref.branchPrefix)
    && (pref.worktreeRoot === null || isCompleteAbsolutePath(pref.worktreeRoot)) && value.worktrees.every((item: unknown) => record(item)
      && [item.id, item.projectId, item.branch, item.slug, item.baseCommit].every(field => typeof field === "string" && !!field)
      && [item.path, item.projectPath, item.configDir].every(isCompleteAbsolutePath) && typeof item.disposable === "boolean");
}

async function header(path: string, length: number): Promise<Buffer> {
  const file = await open(path, "r");
  try { const buffer = Buffer.alloc(length); const result = await file.read(buffer, 0, length, 0); if (result.bytesRead !== length) throw new Error("truncated header"); return buffer; }
  finally { await file.close(); }
}
async function validateDatabaseHeader(path: string): Promise<void> {
  const value = await header(path, 100), encoded = value.readUInt16BE(16), pageSize = encoded === 1 ? 65536 : encoded;
  if (value.subarray(0, 16).toString("ascii") !== "SQLite format 3\0" || pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0
    || (await stat(path)).size % pageSize !== 0) throw new Error("invalid SQLite header or page length");
}
async function validateWalHeader(path: string): Promise<void> {
  if ((await stat(path)).size === 0) return; // An existing empty WAL carries no committed frames.
  const value = await header(path, 32), magic = value.readUInt32BE(0), pageSize = value.readUInt32BE(8);
  if (![0x377f0682, 0x377f0683].includes(magic) || value.readUInt32BE(4) !== 3007000 || pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0)
    throw new Error("invalid WAL header");
  // A live writer can leave a partial final frame. Only stopped-copy SQLite may decide its commit visibility.
}
