import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { isCompleteAbsolutePath, isWithinManagedPath, relocateManagedPath, resolveManagedRealPath } from "@vykor/host-config/paths";
import { fileDigest, identity, info, samePath, saveMigrationJournal, treeIdentity, type MigrationJournal, type TreeIdentity } from "./data-root-migration-journal.js";
import type { DataRootMigrationPreview } from "./data-root-sources.js";
import { hostPathToWslPath, wslPathToHostPath } from "@vykor/sandbox";

const exec = promisify(execFile);
interface GitEnvironment { environment: "native" | "wsl"; distribution?: string }
const native: GitEnvironment = { environment: "native" };
const gitPath = (path: string, environment: GitEnvironment) => environment.environment === "wsl" ? hostPathToWslPath(path) : path;
function hostPath(path: string, environment: GitEnvironment): string {
  if (environment.environment === "native") return resolve(path);
  const host = wslPathToHostPath(path);
  if (!host || gitPath(host, environment) !== posix.normalize(path)) throw new Error("WSL Git path cannot be mapped to the managed host scope");
  return host;
}
const validDistribution = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\0\r\n]/.test(value) && !value.startsWith("-");
async function gitEnvironment(records: readonly RegisteredMigrationWorktree[]): Promise<GitEnvironment> {
  const first = records[0], environment = first?.environment ?? "native";
  if (!["native", "wsl"].includes(environment) || records.some(record => (record.environment ?? "native") !== environment || (record.distribution && first?.distribution && record.distribution !== first.distribution))) throw new Error("Conflicting Git execution environments");
  if (environment === "native") return native;
  if (process.platform !== "win32") throw new Error("WSL Git requires its Windows host");
  // Pin a default distribution before journaling so recovery never follows a later default change.
  const distribution = first?.distribution ?? (await exec("wsl.exe", ["--exec", "printenv", "WSL_DISTRO_NAME"], { windowsHide: true, timeout: 15000 })).stdout.trim();
  if (!validDistribution(distribution) || records.some(record => record.distribution && record.distribution !== distribution)) throw new Error("Invalid or conflicting WSL distribution");
  return { environment, distribution };
}
/** Only plumbing here: status can invoke user fsmonitor/clean filters even with optional locks disabled. */
async function git(cwd: string, args: string[], environment: GitEnvironment = native): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  const command = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", gitPath(cwd, environment), ...args];
  try {
    return (await exec(environment.environment === "wsl" ? "wsl.exe" : "git", environment.environment === "wsl"
      ? ["--distribution", environment.distribution!, "--exec", "env", "-u", "GIT_DIR", "-u", "GIT_WORK_TREE", "-u", "GIT_COMMON_DIR", "-u", "GIT_INDEX_FILE", "-u", "GIT_OBJECT_DIRECTORY", "-u", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_OPTIONAL_LOCKS=0", "git", ...command] : command,
    { env, windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  }
  catch { throw new Error("Git migration cannot verify worktree: " + cwd); }
}
export interface MigrationGitWorktree extends GitEnvironment {
  from: string; to: string; mainFrom: string; mainTo: string; name: string;
  head: string; branch: string; indexDigest: string;
}
export interface RegisteredMigrationWorktree { path: string; projectPath: string; branch: string; environment?: "native" | "wsl"; distribution?: string }
interface GitPointer extends GitEnvironment { path: string; digest: string; destination: string; marker: boolean; mode: number }
export interface MigrationGitRepair {
  state: "intent" | "repaired" | "restored";
  pointers: GitPointer[];
  targetTree: TreeIdentity;
  externalTrees: Array<{ path: string; tree: TreeIdentity }>;
  restoreTrees?: Array<{ path: string; tree: TreeIdentity }>;
  restorePointers?: GitPointer[];
}

/** Refuse arbitrary recovery/ignored paths: all mutable files derive from recorded worktree pairs. */
export function validateMigrationGitJournal(j: MigrationJournal): void {
  if (j.gitWorktrees === undefined && j.gitRepair === undefined) return;
  const trees = j.gitWorktrees;
  if (!Array.isArray(trees)) throw new Error("Invalid Git migration records");
  for (const tree of trees) {
    if (![tree.from, tree.to, tree.mainFrom, tree.mainTo].every(isCompleteAbsolutePath)
      || !["native", "wsl"].includes(tree.environment) || (tree.environment === "wsl" && !validDistribution(tree.distribution))
      || !/^(?!\.{1,2}$)[a-zA-Z0-9._+-]+$/.test(tree.name) || !/^[a-f0-9]{40,64}$/.test(tree.head)
      || !/^refs\/heads\/[^ \x00-\x20]+$/.test(tree.branch) || !/^[a-f0-9]{64}$/.test(tree.indexDigest)
      || !j.entries.some(entry => entry.kind === "file" && samePath(entry.source, join(tree.from, ".git")) && samePath(entry.target, join(tree.to, ".git")))
      || !samePath(relocateManagedPath(tree.from, j.moves), tree.to) || !samePath(relocateManagedPath(tree.mainFrom, j.moves), tree.mainTo)) throw new Error("Invalid Git migration worktree");
  }
  if (!j.gitRepair) return;
  const action = j.gitRepair;
  if (!["intent", "repaired", "restored"].includes(action.state) || !Array.isArray(action.pointers)
    || action.pointers.length !== trees.length * 2 || action.targetTree?.identity !== j.stagingIdentity || !Array.isArray(action.externalTrees)) throw new Error("Invalid Git migration intent");
  const expected = trees.flatMap(tree => [
    { path: join(tree.to, ".git"), destination: join(tree.mainTo, ".git/worktrees", tree.name), marker: true, environment: tree.environment, distribution: tree.distribution },
    { path: join(tree.mainTo, ".git/worktrees", tree.name, "gitdir"), destination: join(tree.to, ".git"), marker: false, environment: tree.environment, distribution: tree.distribution },
  ]);
  for (const [index, pointer] of action.pointers.entries()) {
    const want = expected[index]!;
    if (!samePath(pointer.path, want.path) || !samePath(pointer.destination, want.destination) || pointer.marker !== want.marker || !/^[a-f0-9]{64}$/.test(pointer.digest)
      || pointer.environment !== want.environment || pointer.distribution !== want.distribution
      || !Number.isInteger(pointer.mode) || pointer.mode < 0 || pointer.mode > 0o777) throw new Error("Invalid Git migration pointer");
  }
  const external = [...new Set(trees.map(tree => join(tree.mainTo, ".git")).filter(path => !isWithinManagedPath(path, j.targetRoot)))];
  if (action.externalTrees.length !== external.length || action.externalTrees.some((entry, index) => !samePath(entry.path, external[index]!))) throw new Error("Invalid external Git migration scope");
  if (action.restoreTrees !== undefined || action.restorePointers !== undefined) {
    const expectedPointers = trees.flatMap(tree => [
      { path: join(tree.from, ".git"), destination: join(tree.mainFrom, ".git/worktrees", tree.name), marker: true, environment: tree.environment, distribution: tree.distribution },
      { path: join(tree.mainFrom, ".git/worktrees", tree.name, "gitdir"), destination: join(tree.from, ".git"), marker: false, environment: tree.environment, distribution: tree.distribution },
    ]).filter(pointer => j.sourceTrees.some(source => isWithinManagedPath(pointer.path, source.path)));
    if (!Array.isArray(action.restoreTrees) || action.restoreTrees.length !== j.sourceTrees.length
      || action.restoreTrees.some((entry, index) => !samePath(entry.path, j.sourceTrees[index]!.path) || entry.tree.identity !== j.sourceTrees[index]!.tree.identity)
      || !Array.isArray(action.restorePointers) || action.restorePointers.length !== expectedPointers.length
      || action.restorePointers.some((entry, index) => !samePath(entry.path, expectedPointers[index]!.path) || !samePath(entry.destination, expectedPointers[index]!.destination)
        || entry.environment !== expectedPointers[index]!.environment || entry.distribution !== expectedPointers[index]!.distribution
        || entry.marker !== expectedPointers[index]!.marker || !/^[a-f0-9]{64}$/.test(entry.digest) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) throw new Error("Invalid Git restoration scope");
  }
}

async function pointer(path: string, marker: boolean, environment: GitEnvironment = native): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8192) throw new Error("Unsafe Git pointer");
  const text = await readFile(path, "utf8"), line = text.replace(/\r?\n$/, "");
  if (/[\0\r\n]/.test(line) || (marker && !line.startsWith("gitdir: "))) throw new Error("Invalid Git pointer");
  const value = marker ? line.slice(8) : line;
  return environment.environment === "wsl" ? hostPath(posix.resolve(posix.dirname(gitPath(path, environment)), value), environment) : resolve(dirname(path), value);
}
async function physical(path: string): Promise<void> {
  if (!samePath(await resolveManagedRealPath(path), path)) throw new Error("Git path contains a filesystem link");
}

/** Only known managed .git files from the inventory, plus explicit Desktop registrations. */
export async function inspectMigrationGit(preview: DataRootMigrationPreview, registered: readonly RegisteredMigrationWorktree[]): Promise<void> {
  const candidates = new Set([...registered.map(tree => tree.path), ...preview.entries
    .filter(entry => entry.kind === "file" && basename(entry.source) === ".git").map(entry => dirname(entry.source))]);
  for (const from of candidates) {
    try {
      const records = registered.filter(tree => samePath(tree.path, from));
      const environment = await gitEnvironment(records);
      const to = relocateManagedPath(from, preview.moves);
      if (!isWithinManagedPath(to, preview.targetRoot)) throw new Error("Worktree has no managed destination");
      await physical(from);
      const admin = await pointer(join(from, ".git"), true, environment); await physical(admin);
      const common = hostPath(await git(from, ["rev-parse", "--path-format=absolute", "--git-common-dir"], environment), environment);
      const mainFrom = dirname(common), name = basename(admin);
      if (!samePath(common, join(mainFrom, ".git")) || !samePath(admin, join(common, "worktrees", name)) || !/^[a-zA-Z0-9._+-]+$/.test(name)) throw new Error("Unsupported Git layout");
      await identity(mainFrom); await identity(common);
      const branch = await git(from, ["symbolic-ref", "HEAD"], environment);
      let mismatched = false;
      for (const record of records) if (!samePath(await resolveManagedRealPath(record.projectPath), mainFrom) || "refs/heads/" + record.branch !== branch) mismatched = true;
      if (mismatched) { preview.blockers.push({ code: "git_worktree_registration_mismatch", path: from, message: "Desktop registration disagrees with the actual main repository or branch: " + from }); continue; }
      const mainTo = relocateManagedPath(mainFrom, preview.moves);
      if (isWithinManagedPath(mainFrom, preview.sourceRoot) || !samePath(mainTo, mainFrom)) {
        let unmanaged = false;
        for (const name of await readdir(join(common, "worktrees"))) {
          const registered = dirname(await pointer(join(common, "worktrees", name, "gitdir"), false, environment));
          if (![...candidates].some(path => samePath(path, registered))) unmanaged = true;
        }
        if (unmanaged) { preview.blockers.push({ code: "git_main_has_unmanaged_worktrees", path: from, message: "The relocating main repository also owns worktrees outside this migration: " + from }); continue; }
      }
      if (!samePath(hostPath(await git(mainFrom, ["rev-parse", "--show-toplevel"], environment), environment), mainFrom)
        || !samePath(await pointer(join(admin, "gitdir"), false, environment), join(from, ".git"))) throw new Error("Git registration disagrees");
      if (await info(join(admin, "locked")) || await info(join(admin, "index.lock")) || await info(join(common, "index.lock"))) {
        preview.blockers.push({ code: "git_worktree_locked", path: from, message: "Unlock and close writers for this worktree before migration: " + from }); continue;
      }
      const version = (await git(mainFrom, ["--version"], environment)).match(/git version (\d+)\.(\d+)/);
      if (!version || (+version[1]! < 2 || (+version[1]! === 2 && +version[2]! < 30))) throw new Error("Git repair is unavailable");
      // Older repair follows the still-valid retained main's backlink instead of the copied main.
      if (!samePath(mainFrom, mainTo) && +version[1]! === 2 && +version[2]! < 48) {
        preview.blockers.push({ code: "git_repair_requires_2_48", path: from, message: "Copying this main repository with its worktree requires Git 2.48 or newer: " + from }); continue;
      }
      preview.gitWorktrees.push({ from, to, mainFrom, mainTo, name, ...environment,
        head: await git(from, ["rev-parse", "HEAD"], environment), branch, indexDigest: await fileDigest(join(admin, "index")) });
    } catch { preview.blockers.push({ code: "git_worktree_unavailable", path: from, message: "The main repository or safe Git repair is unavailable for worktree: " + from }); }
  }
}

function current(path: string, j: MigrationJournal, root: string): string { return isWithinManagedPath(path, j.targetRoot) ? join(root, relative(j.targetRoot, path)) : path; }
function allowed(j: MigrationJournal, root: string): string[] { return j.gitRepair!.pointers.map(p => current(p.path, j, root)); }
function equal(a: TreeIdentity, b: TreeIdentity): boolean { return a.identity === b.identity && a.digest === b.digest && a.files === b.files && a.bytes === b.bytes; }
async function verifyWorktree(tree: MigrationGitWorktree, reverse: boolean): Promise<void> {
  const path = reverse ? tree.from : tree.to, main = reverse ? tree.mainFrom : tree.mainTo, admin = join(main, ".git/worktrees", tree.name);
  await physical(path); await physical(main); await physical(admin);
  if (!samePath(await pointer(join(path, ".git"), true, tree), admin) || !samePath(await pointer(join(admin, "gitdir"), false, tree), join(path, ".git"))
    || !samePath(hostPath(await git(path, ["rev-parse", "--show-toplevel"], tree), tree), path)
    || !samePath(hostPath(await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], tree), tree), join(main, ".git"))
    || await git(path, ["rev-parse", "HEAD"], tree) !== tree.head || await git(path, ["symbolic-ref", "HEAD"], tree) !== tree.branch
    || await fileDigest(join(admin, "index")) !== tree.indexDigest) throw new Error("Git worktree verification failed: " + path);
}

/** Check every non-pointer byte before accepting bounded Git-produced pointer changes. */
export async function verifyMigrationGitTrees(j: MigrationJournal, root: string, recovering = false): Promise<void> {
  if (!j.gitRepair) return;
  const ignored = allowed(j, root);
  if (!equal(await treeIdentity(root, undefined, ignored), j.gitRepair.targetTree)) throw new Error("Unrelated target files changed during Git repair");
  for (const external of j.gitRepair.externalTrees) {
    if (!equal(await treeIdentity(external.path, undefined, ignored), external.tree)) throw new Error("Unrelated Git registration files changed");
  }
  for (const p of j.gitRepair.pointers) {
    const path = current(p.path, j, root); await physical(path);
    if (((await lstat(path)).mode & 0o777) !== p.mode) throw new Error("Git pointer permissions changed");
    if (!samePath(await pointer(path, p.marker, p), p.destination)) {
      if (!recovering) throw new Error("Git registration no longer points to the installed worktree");
      if (await fileDigest(path) === p.digest) continue;
      const original = j.gitWorktrees?.find(tree => samePath(p.path, join(tree.mainTo, ".git/worktrees", tree.name, "gitdir")));
      if (!original || !samePath(await pointer(path, false, p), join(original.from, ".git"))) throw new Error("Unknown Git pointer contents");
    }
  }
}

/** Called only by the migration core while holding its stable home lock and pending marker. */
export async function repairMigrationGit(j: MigrationJournal): Promise<void> {
  if (!j.gitWorktrees?.length) return;
  if (!j.stagedTree || !equal(await treeIdentity(j.targetRoot), j.stagedTree)) throw new Error("Installed target changed before Git repair");
  const pointers: GitPointer[] = [], externalTrees: MigrationGitRepair["externalTrees"] = [];
  for (const tree of j.gitWorktrees) {
    await verifyWorktree(tree, true);
    for (const [path, destination, marker] of [[join(tree.to, ".git"), join(tree.mainTo, ".git/worktrees", tree.name), true], [join(tree.mainTo, ".git/worktrees", tree.name, "gitdir"), join(tree.to, ".git"), false]] as const) {
      await physical(path); pointers.push({ path, destination, marker, digest: await fileDigest(path), mode: (await lstat(path)).mode & 0o777, environment: tree.environment, distribution: tree.distribution });
    }
  }
  const ignored = pointers.map(p => p.path);
  if (!equal(await treeIdentity(j.targetRoot), j.stagedTree)) throw new Error("Installed target changed while preparing Git repair");
  for (const common of new Set(j.gitWorktrees.map(tree => join(tree.mainTo, ".git")).filter(path => !isWithinManagedPath(path, j.targetRoot)))) externalTrees.push({ path: common, tree: await treeIdentity(common, undefined, ignored) });
  const targetTree = await treeIdentity(j.targetRoot, undefined, ignored);
  if (!equal(await treeIdentity(j.targetRoot), j.stagedTree)) throw new Error("Installed target changed while snapshotting Git repair");
  j.gitRepair = { state: "intent", pointers, targetTree, externalTrees };
  j.operation = "git-repair"; await saveMigrationJournal(j);
  for (const tree of j.gitWorktrees) {
    await git(tree.mainTo, ["worktree", "repair", "--", gitPath(tree.to, tree)], tree);
    await verifyWorktree(tree, false);
  }
  await verifyMigrationGitTrees(j, j.targetRoot);
  j.stagedTree = await treeIdentity(j.targetRoot); j.gitRepair.state = "repaired"; await saveMigrationJournal(j);
}

/** Directories have already been restored; this ordering also supports same-root owned mains. */
export async function restoreMigrationGit(j: MigrationJournal): Promise<void> {
  if (!j.gitRepair || j.gitRepair.state === "restored") return;
  if (!j.gitRepair.restoreTrees) {
    const pointers: GitPointer[] = [];
    for (const tree of j.gitWorktrees ?? []) {
      for (const [path, destination, marker] of [[join(tree.from, ".git"), join(tree.mainFrom, ".git/worktrees", tree.name), true], [join(tree.mainFrom, ".git/worktrees", tree.name, "gitdir"), join(tree.from, ".git"), false]] as const) {
        if (!j.sourceTrees.some(source => isWithinManagedPath(path, source.path))) continue;
        await physical(path); pointers.push({ path, destination, marker, digest: await fileDigest(path), mode: (await lstat(path)).mode & 0o777, environment: tree.environment, distribution: tree.distribution });
      }
    }
    const restoreTrees = await Promise.all(j.sourceTrees.map(async source => ({ path: source.path, tree: await treeIdentity(source.path, undefined, pointers.map(p => p.path)) })));
    for (const source of j.sourceTrees) if (!equal(await treeIdentity(source.path), source.tree)) throw new Error("Original source changed before Git restoration");
    j.gitRepair.restorePointers = pointers; j.gitRepair.restoreTrees = restoreTrees;
  }
  j.operation = "git-restore"; await saveMigrationJournal(j);
  for (const tree of j.gitWorktrees ?? []) {
    await git(tree.mainFrom, ["worktree", "repair", "--", gitPath(tree.from, tree)], tree);
    await verifyWorktree(tree, true);
  }
  await verifyMigrationGitTrees(j, j.stagingRoot, true);
  j.gitRepair.state = "restored"; await saveMigrationJournal(j);
}

/** Git repair can rewrite an identical old .git file, changing its timestamp. Preserve the original
 * complete source baseline and accept only these explicitly journaled restoration-pointer changes. */
export async function verifyRestoredGitSource(j: MigrationJournal, recordedPath: string, actualPath: string, ignoredMarker?: string): Promise<boolean> {
  const expected = j.gitRepair?.restoreTrees?.find(source => samePath(source.path, recordedPath));
  if (!expected) return false;
  if (!samePath(recordedPath, actualPath)) throw new Error("Git restoration source is not installed");
  const pointers = j.gitRepair!.restorePointers!;
  if (!equal(await treeIdentity(actualPath, ignoredMarker, pointers.map(p => p.path)), expected.tree)) throw new Error("Unrelated original files changed during Git restoration");
  for (const p of pointers.filter(p => isWithinManagedPath(p.path, recordedPath))) {
    await physical(p.path);
    if (((await lstat(p.path)).mode & 0o777) !== p.mode || !samePath(await pointer(p.path, p.marker, p), p.destination)) throw new Error("Original Git pointer restoration failed");
  }
  return true;
}
