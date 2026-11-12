import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as journalApi from "../data-root-migration-journal.js";
import { verifyMigrationGitTrees } from "../data-root-git.js";
import { createChildAgentWorktreeManager } from "../../../../agent-runtime/src/node/children/child-environment.js";
import { SessionDatabase } from "../../../../services/src/database/session-database.js";
import { sessions } from "../../../../services/src/session-runtime/schema.js";
import { readDataRootSelector } from "@vykor/host-config/paths";
import { hostPathToWslPath, wslPathToHostPath } from "@vykor/sandbox";
import { migrateDataRoot, recoverDataRootMigration, commitDataRootMigration } from "../data-root-migration.js";
import { inspectDataRootMigration } from "../data-root-sources.js";

const cleanup: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });
const file = (path: string, data: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const supportsCopiedMain = (version: string) => { const match = version.match(/git version (\d+)\.(\d+)/); return !!match && (+match[1]! > 2 || (+match[1]! === 2 && +match[2]! >= 48)); };
const nativeCopiedMain = supportsCopiedMain(execFileSync("git", ["--version"], { encoding: "utf8", windowsHide: true }));
const wslVersion = process.platform === "win32" ? spawnSync("wsl.exe", ["--distribution", "Debian", "--exec", "git", "--version"], { encoding: "utf8", windowsHide: true, timeout: 15000 }).stdout ?? "" : "";
const hasWslGit = /git version /.test(wslVersion);
function git(cwd: string, ...args: string[]) { return execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function wslGit(cwd: string, ...args: string[]) { return execFileSync("wsl.exe", ["--distribution", "Debian", "--exec", "git", "--no-optional-locks", "-C", hostPathToWslPath(cwd), ...args.map(arg => /^[a-z]:[\\/]/i.test(arg) ? hostPathToWslPath(arg) : arg)], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function fixture(ownedMain: boolean | "canonical" = false, sameRoot = false, crossVolume = false, wsl = false) {
  const run = wsl ? wslGit : git;
  const root = mkdtempSync(join(tmpdir(), "git-migration-")); cleanup.push(root);
  const sourceParent = crossVolume ? mkdtempSync("E:/t9-owned-git-") : root; if (crossVolume) cleanup.push(sourceParent);
  const source = join(sourceParent, "source"), target = sameRoot ? source : join(root, "target"), home = join(root, "home"), documents = join(root, "Documents"), userData = join(root, "Electron"); mkdirSync(home);
  const main = ownedMain === "canonical" ? join(source, "workspaces/owned-main") : ownedMain ? join(documents, "Vykor/owned-main") : join(root, "external-main");
  const tree = join(source, "worktrees/task"); mkdirSync(main, { recursive: true });
  run(main, "init", "-b", "main"); run(main, "config", "user.name", "Migration fixture"); run(main, "config", "user.email", "fixture@localhost");
  file(join(main, "tracked.txt"), "base\n"); run(main, "add", "tracked.txt"); run(main, "commit", "-m", "fixture");
  run(main, "worktree", "add", "-b", "task", tree, "HEAD");
  file(join(tree, "tracked.txt"), "staged\n"); run(tree, "add", "tracked.txt"); file(join(tree, "tracked.txt"), "staged plus unstaged\n"); file(join(tree, "untracked.txt"), "keep untracked\n");
  const db = SessionDatabase.open({ path: join(source, "data/session-runtime/sessions.db") });
  db.orm.insert(sessions).values({ id: "s", cwd: ownedMain ? main : join(source, "workspaces/chat"), title: "fixture", model: "m", status: "idle", metadataJson: JSON.stringify({ desktop: { workspaceMode: "outside_project" } }), createdAt: 1, updatedAt: 1 }).run(); db.close();
  if (ownedMain || wsl) file(join(userData, "git-settings.json"), JSON.stringify({ version: 1, preferences: { defaultScope: "uncommitted", viewMode: "unified", ignoreWhitespace: false, autoCleanup: false, defaultTaskLocation: "current", branchPrefix: "task-", worktreeRoot: source }, worktrees: [{ id: "w", projectId: "p", projectPath: main, path: tree, branch: "task", slug: "task", configDir: source, disposable: false, baseCommit: run(main, "rev-parse", "HEAD"), ...(wsl ? { environment: "wsl", distribution: "Debian" } : {}) }] }));
  const request = { homeDir: home, sourceRoot: source, targetRoot: target, environment: {}, legacy: { documentsDir: documents, userDataDir: userData } };
  const snapshot = () => ({ head: run(tree, "rev-parse", "HEAD"), branch: run(tree, "symbolic-ref", "HEAD"), status: run(tree, "status", "--porcelain=v1", "--untracked-files=all"), index: digest(join(main, ".git/worktrees/task/index")), tracked: digest(join(tree, "tracked.txt")), untracked: digest(join(tree, "untracked.txt")) });
  return { root, source, target, home, main, tree, request, before: snapshot(), snapshot };
}

it.each([false, true])("repairs an external main registration and restores dirty state (same root: %s)", async same => {
  const f = fixture(false, same), moved = join(f.target, "worktrees/task");
  const result = await migrateDataRoot(f.request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async handle => {
    expect(resolve(git(moved, "rev-parse", "--show-toplevel"))).toBe(moved);
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(moved.replaceAll("\\", "/"));
    expect(git(moved, "status", "--porcelain=v1", "--untracked-files=all")).toBe(f.before.status);
    expect(digest(join(f.main, ".git/worktrees/task/index"))).toBe(f.before.index);
    await handle.commit();
  } });
  expect(result.phase).toBe("committed");
  const restored = await recoverDataRootMigration(result.journalPath, { homeDir: f.home });
  expect(restored.phase).toBe("failed");
  expect(f.snapshot()).toEqual(f.before); expect(readDataRootSelector(f.home)).toBeUndefined();
  expect(JSON.parse(readFileSync(result.journalPath, "utf8")).recovered).toBe(true);
});

it.runIf(nativeCopiedMain).each([false, true])("moves a legacy owned main using stopped DB evidence and restores the original main (same root: %s)", async same => {
  const f = fixture(true, same), moved = join(f.target, "worktrees/task"), movedMain = join(f.target, "workspaces/owned-main");
  const result = await migrateDataRoot(f.request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async handle => {
    expect(resolve(git(moved, "rev-parse", "--path-format=absolute", "--git-common-dir"))).toBe(join(movedMain, ".git"));
    expect(git(moved, "status", "--porcelain=v1", "--untracked-files=all")).toBe(f.before.status);
    const saved = JSON.parse(readFileSync(join(f.target, "data/desktop/git-settings.json"), "utf8")); expect(saved.worktrees[0].projectPath).toBe(movedMain);
    await handle.commit();
  } });
  expect(result.phase).toBe("committed");
  const recovered = await recoverDataRootMigration(result.journalPath, { homeDir: f.home }); expect(recovered.phase).toBe("failed");
  expect(f.snapshot()).toEqual(f.before); expect(JSON.parse(readFileSync(result.journalPath, "utf8")).recovered).toBe(true);
});

it("blocks locked worktrees with their path and performs no fsmonitor/index writes during inspection", async () => {
  const f = fixture(), sentinel = join(f.root, "fsmonitor-was-run"), hook = join(f.root, "fsmonitor.sh");
  file(hook, `#!/bin/sh\necho ran > '${sentinel.replaceAll("\\", "/")}'\n`); git(f.main, "config", "core.fsmonitor", hook);
  const index = digest(join(f.main, ".git/worktrees/task/index"));
  git(f.main, "worktree", "lock", f.tree);
  const preview = await inspectDataRootMigration(f.request);
  expect(preview.blockers).toContainEqual(expect.objectContaining({ code: "git_worktree_locked", path: f.tree }));
  expect(digest(join(f.main, ".git/worktrees/task/index"))).toBe(index); expect(existsSync(sentinel)).toBe(false);
});

it.runIf(process.platform === "win32" && existsSync("E:/"))("repairs a real E-to-C copied worktree without claiming E marker commit", async () => {
  const f = fixture(false, false, true); expect(statSync(f.source).dev).not.toBe(statSync(f.root).dev);
  const result = await migrateDataRoot(f.request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async () => {
    const moved = join(f.target, "worktrees/task"); expect(resolve(git(moved, "rev-parse", "--show-toplevel"))).toBe(moved);
    expect(git(moved, "status", "--porcelain=v1", "--untracked-files=all")).toBe(f.before.status);
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(moved.replaceAll("\\", "/"));
  } });
  expect(result.phase).toBe("verified"); expect((await recoverDataRootMigration(result.journalPath, { homeDir: f.home })).phase).toBe("failed"); expect(f.snapshot()).toEqual(f.before);
});

it.each(nativeCopiedMain ? [false, true] : [true])("recovers a moved canonical main after verifier failure and a lost repair completion record (same root: %s)", async same => {
  const f = fixture("canonical", same);
  const result = await migrateDataRoot(f.request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async () => { throw new Error("verification refused"); } });
  expect(result.phase).toBe("failed");
  const journal = JSON.parse(readFileSync(result.journalPath, "utf8"));
  expect(journal.gitRepair.state).toBe("repaired");
  journal.gitRepair.state = "intent"; writeFileSync(result.journalPath, JSON.stringify(journal));
  expect((await recoverDataRootMigration(result.journalPath, { homeDir: f.home })).phase).toBe("failed");
  expect(f.snapshot()).toEqual(f.before); expect(readDataRootSelector(f.home)).toBeUndefined();
  expect((await recoverDataRootMigration(result.journalPath, { homeDir: f.home })).phase).toBe("failed");
});

it("refuses independent commit without Git repair and retains unrelated changed target bytes on recovery", async () => {
  const f = fixture();
  const result = await migrateDataRoot(f.request, { prepareStoppedCopy: async () => ({}) });
  expect(result.phase).toBe("verified");
  await expect(commitDataRootMigration(result.journalPath, { homeDir: f.home })).rejects.toThrow(/Git repair/);
  expect((await recoverDataRootMigration(result.journalPath, { homeDir: f.home })).phase).toBe("failed");
  const second = fixture();
  const changed = await migrateDataRoot(second.request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async handle => {
    file(join(second.target, "worktrees/task/untracked.txt"), "unrelated mutation");
    await handle.commit();
  } });
  expect(changed.phase).toBe("failed");
  expect((await recoverDataRootMigration(changed.journalPath, { homeDir: second.home })).phase).toBe("rollback_failed");
  expect(readFileSync(join(second.target, "worktrees/task/untracked.txt"), "utf8")).toBe("unrelated mutation");
  expect(readDataRootSelector(second.home)?.pendingMigration).toBeDefined();
});

it.runIf(nativeCopiedMain)("keeps an unproven Git main protected despite a host workspace hint and blocks missing mains", async () => {
  const f = fixture(true);
  const db = SessionDatabase.open({ path: join(f.source, "data/session-runtime/sessions.db") });
  db.orm.delete(sessions).run(); db.close();
  Object.assign(f.request.legacy, { workspacePaths: [f.main] });
  const result = await migrateDataRoot(f.request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async () => { throw new Error("must not install"); } });
  expect(result.phase).toBe("failed"); expect(existsSync(f.target)).toBe(false); expect(f.snapshot()).toEqual(f.before);
  expect((await recoverDataRootMigration(result.journalPath, { homeDir: f.home })).phase).toBe("failed");
  // Only an owned temporary main is removed to exercise the unavailable-main blocker.
  rmSync(f.main, { recursive: true });
  expect((await inspectDataRootMigration(f.request)).blockers).toContainEqual(expect.objectContaining({ code: "git_worktree_unavailable", path: f.tree }));
});

it("does not absorb changes between installed verification and the Git intent snapshot", async () => {
  const f = fixture(), save = journalApi.saveMigrationJournal;
  let injected = false;
  vi.spyOn(journalApi, "saveMigrationJournal").mockImplementation(async journal => {
    await save(journal);
    if (!injected && journal.phase === "verified" && journal.operation === "verify") {
      injected = true; file(join(f.target, "worktrees/task/untracked.txt"), "not part of Git repair");
    }
  });
  const result = await migrateDataRoot(f.request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async () => {} });
  expect(injected).toBe(true); expect(result.phase).toBe("failed");
  expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.tree.replaceAll("\\", "/"));
});

it("blocks relocating a main that still owns an unmanaged external worktree", async () => {
  const f = fixture("canonical"), external = join(f.root, "external-linked");
  git(f.main, "worktree", "add", "-b", "external", external, "HEAD");
  const preview = await inspectDataRootMigration(f.request);
  expect(preview.blockers).toContainEqual(expect.objectContaining({ code: "git_main_has_unmanaged_worktrees", path: f.tree }));
});

it.each([false, true])("repairs a real child manager worktree without Desktop settings (database-only nested root: %s)", async nested => {
  const f = fixture(), child = await createChildAgentWorktreeManager({ cwd: f.main, configDir: nested ? join(f.source, "allocated") : f.source }).create("team/child");
  if (nested) {
    const db = SessionDatabase.open({ path: join(f.source, "data/session-runtime/sessions.db") });
    db.orm.insert(sessions).values({ id: "child", cwd: child.path, title: "child", model: "m", status: "idle", metadataJson: JSON.stringify({ desktop: { worktree: { path: child.path, branch: child.branch } } }), createdAt: 1, updatedAt: 1 }).run(); db.close();
  }
  file(join(child.path, "tracked.txt"), "child staged\n"); git(child.path, "add", "tracked.txt");
  file(join(child.path, "tracked.txt"), "child unstaged\n"); file(join(child.path, "child-untracked.txt"), "keep");
  const status = git(child.path, "status", "--porcelain=v1", "--untracked-files=all"), index = resolve(git(child.path, "rev-parse", "--path-format=absolute", "--git-path", "index")), beforeIndex = digest(index);
  const moved = join(f.target, child.path.slice(f.source.length + 1));
  const result = await migrateDataRoot(f.request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async () => {
    expect(resolve(git(moved, "rev-parse", "--show-toplevel"))).toBe(moved);
    expect(git(moved, "status", "--porcelain=v1", "--untracked-files=all")).toBe(status);
    expect(digest(index)).toBe(beforeIndex);
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(moved.replaceAll("\\", "/"));
  } });
  expect(result.phase).toBe("verified");
  expect((await recoverDataRootMigration(result.journalPath, { homeDir: f.home })).phase).toBe("failed");
  expect(git(child.path, "status", "--porcelain=v1", "--untracked-files=all")).toBe(status); expect(digest(index)).toBe(beforeIndex);
});

it("rejects a journal that substitutes a business file for a permitted Git pointer", async () => {
  const f = fixture();
  const result = await migrateDataRoot(f.request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async () => {} });
  expect(result.phase).toBe("verified");
  const journal = JSON.parse(readFileSync(result.journalPath, "utf8"));
  journal.gitRepair.pointers[0].path = join(f.target, "worktrees/task/untracked.txt");
  writeFileSync(result.journalPath, JSON.stringify(journal));
  await expect(recoverDataRootMigration(result.journalPath, { homeDir: f.home })).rejects.toThrow(/pointer/);
  expect(existsSync(f.target)).toBe(true); expect(readDataRootSelector(f.home)?.pendingMigration?.id).toBe(result.id);
});

it("refuses commit if another Git repair restored the old external registration", async () => {
  const f = fixture(); let boundedCheckRefused = false;
  const result = await migrateDataRoot(f.request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async handle => {
    git(f.main, "worktree", "repair", "--", f.tree);
    try { await verifyMigrationGitTrees(JSON.parse(readFileSync(handle.journalPath, "utf8")), f.target); } catch { boundedCheckRefused = true; }
    await handle.commit();
  } });
  expect(result.phase).toBe("failed");
  expect(readDataRootSelector(f.home)?.dataRoot).toBe(f.source);
  expect(boundedCheckRefused).toBe(true);
});

it("blocks a Desktop record whose main repository disagrees with real Git registration", async () => {
  const f = fixture(true), path = join(f.root, "Electron/git-settings.json"), settings = JSON.parse(readFileSync(path, "utf8"));
  settings.worktrees[0].projectPath = join(f.root, "wrong-main"); file(path, JSON.stringify(settings));
  expect((await inspectDataRootMigration(f.request)).blockers).toContainEqual(expect.objectContaining({ code: "git_worktree_registration_mismatch", path: f.tree }));
});

it.runIf(hasWslGit && !supportsCopiedMain(wslVersion))("uses the actual WSL Git version to block unsafe copied-main repair", async () => {
  const f = fixture("canonical", false, false, true);
  expect(wslGit(f.main, "--version")).toBe(wslVersion.trim());
  expect((await inspectDataRootMigration(f.request)).blockers).toContainEqual(expect.objectContaining({ code: "git_repair_requires_2_48", path: f.tree }));
  expect(f.snapshot()).toEqual(f.before);
});

it.runIf(hasWslGit)("repairs and restores a real dirty WSL worktree using its recorded distribution", async () => {
  const f = fixture(false, false, false, true), moved = join(f.target, "worktrees/task");
  const result = await migrateDataRoot(f.request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async handle => {
    expect(wslPathToHostPath(wslGit(moved, "rev-parse", "--show-toplevel"))).toBe(moved);
    expect(wslGit(moved, "status", "--porcelain=v1", "--untracked-files=all")).toBe(f.before.status);
    expect(digest(join(f.main, ".git/worktrees/task/index"))).toBe(f.before.index);
    expect(wslGit(f.main, "worktree", "list", "--porcelain")).toContain(hostPathToWslPath(moved));
    await handle.commit();
  } });
  expect(result.phase).toBe("committed");
  expect((await recoverDataRootMigration(result.journalPath, { homeDir: f.home })).phase).toBe("failed");
  expect(f.snapshot()).toEqual(f.before);
});

it.runIf(hasWslGit)("blocks conflicting default and explicit WSL distribution registrations before copying", async () => {
  const f = fixture(false, false, false, true), legacy = join(f.root, "Electron/git-settings.json");
  const settings = JSON.parse(readFileSync(legacy, "utf8")); delete settings.worktrees[0].distribution;
  settings.worktrees.push({ ...settings.worktrees[0], id: "duplicate", distribution: "not-the-default-distribution" }); file(legacy, JSON.stringify(settings));
  expect((await inspectDataRootMigration(f.request)).blockers).toContainEqual(expect.objectContaining({ code: "git_worktree_unavailable", path: f.tree }));
  expect(f.snapshot()).toEqual(f.before);
});
