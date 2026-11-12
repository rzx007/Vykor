import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url), api = require(process.env.VYKOR_RELOCATION_MODULE), Database = require(process.env.VYKOR_SQLITE_BINDING);
const inventory = JSON.parse(readFileSync(process.env.VYKOR_SCHEMA_INVENTORY, "utf8"));
const git = (cwd, ...args) => execFileSync("/usr/bin/git", ["--no-optional-locks", "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");

for (const [sameRoot, moveMain, interfered] of [[true, true, false], [false, false, false], [false, true, false], [false, false, true]]) test("POSIX Git dirty index, commit/recovery " + JSON.stringify({ sameRoot, moveMain, interfered }), async () => {
  const root = mkdtempSync("/tmp/vykor-t9-git-"), targetParent = sameRoot ? root : mkdtempSync("/dev/shm/vykor-t9-git-");
  try {
    if (!sameRoot) assert.notEqual(statSync(root).dev, statSync(targetParent).dev);
    const source = join(root, "source"), target = sameRoot ? source : join(targetParent, "target"), home = join(root, "home"), main = moveMain ? join(source, "workspaces/main") : join(root, "external-main"), tree = join(source, "worktrees/task");
    mkdirSync(main, { recursive: true }); mkdirSync(home);
    git(main, "init", "-b", "main"); git(main, "config", "user.name", "Fixture"); git(main, "config", "user.email", "fixture@localhost");
    writeFileSync(join(main, "tracked.txt"), "base\n"); git(main, "add", "tracked.txt"); git(main, "commit", "-m", "fixture");
    git(main, "worktree", "add", "-b", "task", tree, "HEAD");
    writeFileSync(join(tree, "tracked.txt"), "staged\n"); git(tree, "add", "tracked.txt");
    writeFileSync(join(tree, "tracked.txt"), "unstaged\n"); writeFileSync(join(tree, "untracked.txt"), "untracked\n");
    const snapshot = () => ({ head: git(tree, "rev-parse", "HEAD"), branch: git(tree, "symbolic-ref", "HEAD"), status: git(tree, "status", "--porcelain=v1", "--untracked-files=all"), index: digest(join(main, ".git/worktrees/task/index")), tracked: digest(join(tree, "tracked.txt")), untracked: digest(join(tree, "untracked.txt")) });
    const before = snapshot();
    mkdirSync(join(source, "data/session-runtime"), { recursive: true });
    const db = new Database(join(source, "data/session-runtime/sessions.db"));
    for (const item of inventory.schema.filter(item => item.type === "table")) db.exec(item.sql);
    for (const item of inventory.schema.filter(item => item.type === "index")) db.exec(item.sql);
    db.prepare("INSERT INTO session (id,cwd,title,model,status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run("owned", moveMain ? main : join(source, "workspaces/chat"), "fixture", "m", "idle", '{"desktop":{"workspaceMode":"outside_project"}}', 1, 2); db.close();
    const request = { homeDir: home, sourceRoot: source, targetRoot: target, environment: {}, legacy: { documentsDir: join(root, "Documents"), userDataDir: join(root, "Electron") } };
    const version = git(main, "--version").match(/git version (\d+)\.(\d+)/);
    if (!sameRoot && moveMain && +version[1] === 2 && +version[2] < 48) {
      await assert.rejects(api.migrateDataRoot(request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async () => { throw new Error("must be blocked"); } }), /did not finish/);
      assert.deepEqual(snapshot(), before);
      console.log("Git " + version[0] + ": copied-main repair blocked before any mutation; requires 2.48+");
      return;
    }
    let commitRefused = false;
    const result = await api.migrateDataRoot(request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async handle => {
      const moved = join(target, "worktrees/task"), movedMain = moveMain ? join(target, "workspaces/main") : main;
      assert.equal(git(moved, "rev-parse", "--path-format=absolute", "--git-common-dir"), join(movedMain, ".git"));
      assert.equal(git(moved, "status", "--porcelain=v1", "--untracked-files=all"), before.status);
      assert.equal(digest(join(movedMain, ".git/worktrees/task/index")), before.index);
      if (interfered) {
        git(main, "worktree", "repair", "--", tree);
        try { await handle.commit(); } catch { commitRefused = true; }
        return;
      }
      await handle.commit();
    } });
    const journal = JSON.parse(readFileSync(result.journalPath, "utf8"));
    if (interfered) { assert.equal(commitRefused, true); assert.equal(JSON.parse(readFileSync(join(home, ".vykor-root.json"), "utf8")).dataRoot, source); }
    assert.equal(result.phase, interfered ? "failed" : "committed", JSON.stringify({ operation: journal.operation, failedOperation: journal.failedOperation, gitState: journal.gitRepair?.state }));
    if (!sameRoot && !interfered) {
      // Kill a real recovery process after Git writes the old registration but before it reports success.
      const bin = join(root, "bin"); mkdirSync(bin);
      writeFileSync(join(bin, "git"), '#!/bin/sh\nlast=\nfor arg do last=$arg; done\n/usr/bin/git "$@"\ncode=$?\nif [ "$code" = 0 ] && [ "$last" = "$T9_STOP_PATH" ]; then kill -KILL "$PPID"; fi\nexit "$code"\n'); chmodSync(join(bin, "git"), 0o755);
      const script = 'const api=require(process.env.VYKOR_RELOCATION_MODULE);api.recoverDataRootMigration(process.env.T9_JOURNAL,{homeDir:process.env.T9_HOME}).then(()=>process.exit(3));';
      const killed = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, PATH: bin + ":" + process.env.PATH, T9_STOP_PATH: tree, T9_JOURNAL: result.journalPath, T9_HOME: home }, encoding: "utf8" });
      assert.equal(killed.signal, "SIGKILL", killed.stderr);
      const intent = JSON.parse(readFileSync(result.journalPath, "utf8")); assert.equal(intent.operation, "git-restore"); assert.ok(intent.gitRepair.restoreTrees.length);
    }
    const recovered = await api.recoverDataRootMigration(result.journalPath, { homeDir: home });
    assert.equal(recovered.phase, "failed"); assert.equal(JSON.parse(readFileSync(result.journalPath, "utf8")).recovered, true);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(await api.recoverDataRootMigration(result.journalPath, { homeDir: home }), recovered);
  } finally {
    assert.ok(root.startsWith("/tmp/vykor-t9-git-")); rmSync(root, { recursive: true, force: true });
    if (!sameRoot) { assert.ok(targetParent.startsWith("/dev/shm/vykor-t9-git-")); rmSync(targetParent, { recursive: true, force: true }); }
  }
});
