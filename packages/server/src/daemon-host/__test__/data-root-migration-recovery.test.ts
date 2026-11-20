import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionDatabase } from "../../../../services/src/database/session-database.js";
import { SessionStore } from "@vykor/services";
import { readDataRootSelector, resolveDataRootSelection, writeDataRootSelector } from "@vykor/host-config/paths";
import * as services from "@vykor/services/data-root-relocation";
import * as api from "../data-root-migration.js";
import { DaemonSystemService } from "../system-service.js";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));
let root: string, source: string, target: string, home: string;
const request = () => ({ homeDir: home, sourceRoot: source, targetRoot: target, environment: {}, legacy: { documentsDir: join(root, "Documents"), userDataDir: join(root, "Electron") } });
const stopped = { prepareStoppedCopy: async () => ({}) };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "root-recovery-")); source = join(root, "source"); target = join(root, "target"); home = join(root, "home"); mkdirSync(home); SessionDatabase.open({ path: join(source, "data/session-runtime/sessions.db") }).close(); writeFileSync(join(source, "credentials.json"), '{"key":"sensitive"}'); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
it("persists the only journal and pending selector before stopping writers and recovers an interrupted preparation", async () => {
  let prepared = false, retained: Parameters<api.DataRootMigrationCoordination["prepareStoppedCopy"]>[0];
  const migrated = await api.migrateDataRoot(request(), { prepareStoppedCopy: async (context) => {
    retained = context;
    expect(context.journalPath).toBe(readDataRootSelector(home)?.pendingMigration?.journalPath);
    const journal = JSON.parse(readFileSync(context.journalPath, "utf8"));
    expect(journal.preparation.complete).toBe(false);
    expect(journal.sourceTrees).toEqual([]);
    prepared = true;
    throw new Error("private preparation failure");
  } });
  expect(prepared).toBe(true); expect(migrated.phase).toBe("failed");
  expect(migrated).toMatchObject({ operation: "stop-writers", failedOperation: "stop-writers" });
  await expect(retained!.pauseSystemService()).rejects.toThrow(/expired/);
  const recovered = await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home });
  expect(recovered.phase).toBe("failed"); expect(readDataRootSelector(home)).toBeUndefined();
  expect(recovered).toMatchObject({ operation: "complete", failedOperation: "stop-writers" });
  expect(existsSync(join(source, "data/session-runtime/sessions.db"))).toBe(true);
  expect(readFileSync(migrated.journalPath, "utf8")).not.toContain("private preparation failure");
});
it("preserves unknown files left in early preparation and keeps startup blocked", async () => {
  const migrated = await api.migrateDataRoot(request(), { prepareStoppedCopy: async ({ journalPath }) => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    writeFileSync(join(journal.stagingRoot, "unknown"), "preserve");
    throw new Error("interrupted");
  } });
  expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("rollback_failed");
  expect(readDataRootSelector(home)?.pendingMigration?.id).toBe(migrated.id);
});
it.each([false, true])("privately backs up service definitions before pause and records a restore failure=%s", async failRestore => {
  const config = join(home, ".config/systemd/user/dev.vykor.daemon.service");
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  const original = `[Service]\nEnvironment=SECRET=SERVICE_PRIVATE_SENTINEL\nExecStart="/original" "--data-root" "${source.replaceAll("\\", "\\\\")}"\n`;
  writeFileSync(config, original);
  let installing = false, restoring = false;
  const service = new DaemonSystemService({ platform: "linux", homeDir: home, logsDir: join(source, "data/logs"), invocation: { command: "/usr/bin/node", args: ["/app/main.js", "--data-root", source], cwd: "/app" }, runCommand: (_command, args) => {
    if (args.includes("show")) return { status: 0, stdout: `FragmentPath=${config}\nDropInPaths=\nNeedDaemonReload=no\n`, stderr: "" };
    if (args.includes("is-active")) return { status: 0, stdout: "inactive", stderr: "" };
    if (restoring && failRestore || installing && args.includes("daemon-reload")) return { status: 1, stdout: "", stderr: "COMMAND_PRIVATE_SENTINEL" };
    return { status: 0, stdout: "", stderr: "" };
  } });
  const migrated = await api.migrateDataRoot(request(), { prepareStoppedCopy: async context => {
    await context.captureSystemService(service);
    const journal = readFileSync(context.journalPath, "utf8");
    expect(journal).not.toContain("SERVICE_PRIVATE_SENTINEL");
    expect(JSON.parse(journal).systemService.state).toBe("captured");
    await context.pauseSystemService(); installing = true;
    return {};
  }, withInstalledCopy: async handle => { await handle.commit(); } });
  expect(migrated.phase).toBe("failed");
  expect(readFileSync(config, "utf8")).not.toBe(original);
  installing = false; restoring = true;
  const recovered = await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home, systemService: service });
  expect(recovered.phase).toBe(failRestore ? "rollback_failed" : "failed");
  if (!failRestore) { expect(readFileSync(config, "utf8")).toBe(original); expect(readDataRootSelector(home)).toBeUndefined(); }
  else expect(readDataRootSelector(home)?.pendingMigration?.id).toBe(migrated.id);
  const journal = readFileSync(migrated.journalPath, "utf8");
  expect(journal).not.toContain("SERVICE_PRIVATE_SENTINEL"); expect(journal).not.toContain("COMMAND_PRIVATE_SENTINEL");
});
it("releases restored source writes before service resume and never replays old rollback over new work", async () => {
  const service = new DaemonSystemService({ platform: "linux", homeDir: home, logsDir: join(source, "data/logs"), invocation: { command: "/node", args: ["--data-root", source], cwd: root }, runCommand: () => ({ status: 0, stdout: "inactive", stderr: "" }) });
  const migrated = await api.migrateDataRoot(request(), { prepareStoppedCopy: async c => { await c.captureSystemService(service); await c.pauseSystemService(); throw new Error("stop interrupted"); } });
  const resume = vi.spyOn(service, "resumeMigrationSnapshot").mockImplementation(() => { expect(readDataRootSelector(home)).toBeUndefined(); throw new Error("resume failed"); });
  const recovered = await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home, systemService: service });
  expect(recovered).toMatchObject({ phase: "failed", recoveryWritersReleased: true, serviceResumeStatus: "failed" });
  writeFileSync(join(source, "new-user-data"), "new valid write");
  const next = { version: 1 as const, dataRoot: source, pendingMigration: { id: "next-migration", journalPath: join(root, "next.json") } };
  await writeDataRootSelector(home, next);
  expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home, systemService: service })).serviceResumeStatus).toBe("skipped");
  expect(resume).toHaveBeenCalledTimes(1); expect(readDataRootSelector(home)).toEqual(next);
  expect(readFileSync(join(source, "new-user-data"), "utf8")).toBe("new valid write");
});
it("finishes source selection forward after interrupted recovery release persistence", async () => {
  await writeDataRootSelector(home, { version: 1, dataRoot: source });
  const migrated = await api.migrateDataRoot(request(), stopped), rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(to) === join(home, ".vykor-root.json")) throw new Error("selector interrupted"); return rename(from, to); });
  const first = await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home });
  expect(first).toMatchObject({ recoveryWritersReleased: true });
  expect(readDataRootSelector(home)?.pendingMigration?.id).toBe(migrated.id);
  vi.restoreAllMocks();
  expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("failed");
  expect(readDataRootSelector(home)).toEqual({ version: 1, dataRoot: source });
});
it("opens the actual target in a trusted child under pending without registry or background activation", async () => {
  const sourceStore = new SessionStore({ path: join(source, "data/session-runtime/sessions.db") });
  sourceStore.sessions.create({ id: "pending-session", cwd: join(root, "external-project"), model: "test" });
  sourceStore.runs.createRun({ id: "pending-run", sessionId: "pending-session" }); sourceStore.close();
  const cli = fileURLToPath(new URL("../../../../../apps/cli/src/index.ts", import.meta.url));
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  let validated = false, validationError: unknown;
  const migrated = await api.migrateDataRoot(request(), { ...stopped, withInstalledCopy: async handle => {
    const before = readFileSync(join(target, "data/session-runtime/sessions.db"));
    const child = await handle.validateInNewProcess({ command: process.execPath, args: ["--import", loader, cli, "--internal-data-root-validation"], timeoutMs: 45000 }).catch(error => { validationError = error; throw error; });
    expect(child.pid).not.toBe(process.pid);
    expect(child.storePath).toBe(join(target, "data/session-runtime/sessions.db"));
    expect(existsSync(join(target, "data/daemon/registry.json"))).toBe(false);
    expect(readFileSync(join(target, "data/session-runtime/sessions.db"))).toEqual(before);
    validated = true;
    await handle.commit(); await handle.markWritersReleased();
  } });
  expect(validationError).toBeUndefined(); expect(validated, readFileSync(migrated.journalPath, "utf8")).toBe(true); expect(migrated).toMatchObject({ phase: "committed", writersReleased: true });
}, 60000);
it.each([false, true])("recovers only known runtime ownership after real validation child death; changed business=%s", async changed => {
  const cli = fileURLToPath(new URL("../../../../../apps/cli/src/index.ts", import.meta.url)), loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  let baseline: string[] = [];
  const sqlite = createRequire(import.meta.url).resolve("better-sqlite3");
  const modify = changed ? `const db = new (require(${JSON.stringify(sqlite)}))(require('node:path').join(process.env.VYKOR_CONFIG_DIR, 'data/session-runtime/sessions.db')); db.prepare("INSERT INTO session(id, cwd, title, metadata_json, model, status, created_at, updated_at) VALUES ('unknown-business', '/', 'preserve', '{}', 'test', 'idle', 1, 1)").run(); db.close();` : "";
  const script = `process.argv = [process.execPath, ${JSON.stringify(cli)}, '--internal-data-root-validation']; process.send = () => { ${modify} process.kill(process.pid, 'SIGKILL'); }; import(${JSON.stringify(pathToFileURL(cli).href)});`;
  const migrated = await api.migrateDataRoot(request(), { ...stopped, withInstalledCopy: async handle => {
    baseline = readdirSync(target, { recursive: true }).map(String).sort();
    await handle.validateInNewProcess({ command: process.execPath, args: ["--import", loader, "-e", script], timeoutMs: 45000 });
  } });
  expect(migrated.phase).toBe("failed");
  const journal = JSON.parse(readFileSync(migrated.journalPath, "utf8")); expect(journal.validation.state).toBe("started");
  expect(readdirSync(target, { recursive: true }).map(String).filter(p => !p.endsWith("sessions.db-wal") && !p.endsWith("sessions.db-shm")).sort()).toEqual(baseline);
  if (changed) {
    const before = readFileSync(join(target, "data/session-runtime/sessions.db-wal"));
    expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("rollback_failed");
    expect(readFileSync(join(target, "data/session-runtime/sessions.db-wal"))).toEqual(before);
  } else {
    expect(services.digestDataRootCopy(join(target, "data/session-runtime/sessions.db"), { stoppedValidationPid: journal.validation.pid })).toBe(journal.validation.logicalDigest);
    expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("failed");
    expect(readDataRootSelector(home)).toBeUndefined();
  }
}, 60000);
it("does not adopt changes made while preparing the verified database baseline", async () => {
  const copy = fs.copyFile;
  vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
    const value = await copy(...args);
    if (String(args[1]).endsWith("database.db")) writeFileSync(join(target, "credentials.json"), "unknown-baseline-change");
    return value;
  });
  const migrated = await api.migrateDataRoot(request(), { ...stopped, withInstalledCopy: async handle => { await handle.validateInNewProcess({ command: "must-not-spawn", args: [] }); } });
  expect(JSON.parse(readFileSync(migrated.journalPath, "utf8")).validation).toBeUndefined();
  expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("rollback_failed");
  expect(readFileSync(join(target, "credentials.json"), "utf8")).toBe("unknown-baseline-change");
});
it("keeps the target and pending while its owned validation process has not closed", async () => {
  const script = "process.on('message', () => {}); process.on('disconnect', () => {}); setInterval(() => {}, 1000);";
  let pid: number | undefined;
  try {
    const migrated = await api.migrateDataRoot(request(), { ...stopped, withInstalledCopy: async handle => { await handle.validateInNewProcess({ command: process.execPath, args: ["-e", script], timeoutMs: 300 }); } });
    pid = JSON.parse(readFileSync(migrated.journalPath, "utf8")).validation.pid;
    expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("rollback_failed");
    expect(readDataRootSelector(home)?.pendingMigration?.id).toBe(migrated.id); expect(existsSync(target)).toBe(true);
  } finally {
    if (pid) { process.kill(pid, "SIGKILL"); for (let count = 0; count < 100; count++) { try { process.kill(pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 20)); } }
  }
}, 30000);
it.each(["unknown-replacement", "after-db-rename"])("preserves validation restore evidence at %s", async point => {
  const migrated = await api.migrateDataRoot(request(), { ...stopped, withInstalledCopy: async handle => {
    await handle.validateInNewProcess({ command: process.execPath, args: ["-e", "process.on('message',()=>{});process.on('disconnect',()=>process.exit(0));"], timeoutMs: 300 });
  } });
  const journal = JSON.parse(readFileSync(migrated.journalPath,"utf8")), replacement = join(`${migrated.journalPath}.validation`, "restore.db");
  if (point === "unknown-replacement") writeFileSync(replacement,"unknown-control-content");
  else {
    const rename = fs.rename;
    vi.spyOn(fs,"rename").mockImplementation(async(from,to)=>{await rename(from,to);if(String(from)===replacement)throw new Error("interrupted after replacement");});
  }
  expect((await api.recoverDataRootMigration(migrated.journalPath,{homeDir:home})).phase).toBe("rollback_failed");
  vi.restoreAllMocks();
  if(point === "unknown-replacement") expect(readFileSync(replacement,"utf8")).toBe("unknown-control-content");
  else {expect((await api.recoverDataRootMigration(migrated.journalPath,{homeDir:home})).phase).toBe("failed");expect(readDataRootSelector(home)).toBeUndefined();}
});
it.each([false, true])("recovers a timed-out validation without overwriting unknown changes=%s", async changed => {
  const script = changed
    ? "process.on('message', c => { require('node:fs').writeFileSync(require('node:path').join(c.targetRoot, 'unknown-validation-file'), 'preserve'); process.exit(1); });"
    : "process.on('message', () => {}); process.on('disconnect', () => process.exit(0));";
  const migrated = await api.migrateDataRoot(request(), { ...stopped, withInstalledCopy: async handle => {
    await handle.validateInNewProcess({ command: process.execPath, args: ["-e", script], timeoutMs: 700 });
    await handle.commit(); await handle.markWritersReleased();
  } });
  expect(migrated).toMatchObject({ phase: "failed", writersReleased: false });
  const recovered = await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home });
  expect(recovered.phase).toBe(changed ? "rollback_failed" : "failed");
  if (changed) expect(readFileSync(join(target, "unknown-validation-file"), "utf8")).toBe("preserve");
  else expect(readDataRootSelector(home)).toBeUndefined();
}, 20000);
it.each(["copy", "rewrite", "backup", "installed"])("preserves source and recovers repeatedly after %s interruption", async point => {
  if (point === "backup") target = source;
  const before = readFileSync(join(source, "data/session-runtime/sessions.db"));
  if (point === "copy") { const original = fs.copyFile; let count = 0; vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => { if (++count === 3) throw new Error("injected secret"); return original(...args); }); }
  if (point === "rewrite") vi.spyOn(services, "verifyDataRootCopy").mockRejectedValueOnce(new Error("injected secret"));
  if (point === "backup") { const original = fs.rename; vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(to).endsWith("-backup")) { await original(from, to); throw new Error("interrupted after rename"); } return original(from, to); }); }
  const migrated = await api.migrateDataRoot(request(), stopped);
  expect(migrated.phase).toBe(point === "installed" ? "verified" : "failed");
  expect(() => resolveDataRootSelection({ homeDir: home, env: {} })).toThrow(/pending|lock/);
  if (point === "backup") expect(existsSync(source)).toBe(false);
  vi.restoreAllMocks();
  const recovered = await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home }); expect(recovered.phase).toBe("failed");
  expect(readFileSync(join(source, "data/session-runtime/sessions.db"))).toEqual(before); expect(readFileSync(join(source, "credentials.json"), "utf8")).toBe('{"key":"sensitive"}');
  expect(readDataRootSelector(home)).toBeUndefined(); expect(await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).toEqual(recovered);
  expect(readFileSync(migrated.journalPath, "utf8")).not.toContain("injected secret");
});
it("keeps a changed installed copy and refuses rollback instead of deleting unknown data", async () => {
  const migrated = await api.migrateDataRoot(request(), stopped); writeFileSync(join(target, "unknown.txt"), "new data");
  const recovered = await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home }); expect(recovered.phase).toBe("rollback_failed");
  expect(readFileSync(join(target, "unknown.txt"), "utf8")).toBe("new data"); expect(readDataRootSelector(home)?.pendingMigration?.id).toBe(migrated.id);
});
it("commits same-root selection with the moved marker only in its old backup, then refuses rollback after release", async () => {
  target = source;
  const migrated = await api.migrateDataRoot(request(), stopped); expect(migrated.phase).toBe("verified");
  await api.commitDataRootMigration(migrated.journalPath, { homeDir: home });
  expect(() => resolveDataRootSelection({ homeDir: home, env: {} })).toThrow(/pending/);
  const journal = JSON.parse(readFileSync(migrated.journalPath, "utf8"));
  expect(existsSync(join(source, "data/migrations/moved-root.json"))).toBe(false); expect(existsSync(join(journal.backupRoot, "data/migrations/moved-root.json"))).toBe(true);
  await api.markDataRootMigrationWritersReleased(migrated.journalPath, { homeDir: home });
  expect(resolveDataRootSelection({ homeDir: home, env: {} }).dataRoot).toBe(source);
  expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("committed");
  expect(resolveDataRootSelection({ homeDir: home, env: {} }).dataRoot).toBe(source);
});
it("can roll back after selection commit and survive a second interruption during recovery", async () => {
  target = source; const migrated = await api.migrateDataRoot(request(), stopped); await api.commitDataRootMigration(migrated.journalPath, { homeDir: home });
  const original = fs.rename; vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (String(from) === source) { await original(from, to); throw new Error("recover interrupted"); } return original(from, to); });
  expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("rollback_failed"); vi.restoreAllMocks();
  expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("failed"); expect(existsSync(source)).toBe(true); expect(readDataRootSelector(home)).toBeUndefined();
});
it("holds the lock through installed-copy coordination and expires its handle afterward", async () => {
  expect(api).toHaveProperty("migrateDataRoot"); let release!: () => void, entered!: () => void, handle: any;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const migration = api.migrateDataRoot(request(), { ...stopped, withInstalledCopy: async (value: any) => { handle = value; entered(); await gate; await value.commit(); } } as any);
  await ready; expect(readDataRootSelector(home)?.pendingMigration).toBeTruthy();
  let completed = false; const recovery = api.recoverDataRootMigration(handle.journalPath, { homeDir: home }).then(value => { completed = true; return value; });
  await Promise.resolve(); expect(completed).toBe(false); release(); await migration; expect((await recovery).phase).toBe("failed");
  await expect(handle.commit()).rejects.toThrow(/expired/);
});
it("detects a writer changing the source during copying and keeps both copies for inspection", async () => {
  const original = fs.copyFile;
  vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => { const value = await original(...args); if (String(args[0]).endsWith("credentials.json")) writeFileSync(join(source, "late-user-file.txt"), "changed source"); return value; });
  const migrated = await api.migrateDataRoot(request(), stopped); expect(migrated.phase).toBe("failed"); expect(existsSync(target)).toBe(false); vi.restoreAllMocks();
  expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("rollback_failed"); expect(readFileSync(join(source, "late-user-file.txt"), "utf8")).toBe("changed source");
});
it("rejects a substituted target junction during recovery without touching its outside contents", async () => {
  const migrated = await api.migrateDataRoot(request(), stopped), retained = join(root, "retained"), outside = join(root, "outside");
  await fs.rename(target, retained); mkdirSync(outside); writeFileSync(join(outside, "untouched"), "outside"); await fs.symlink(outside, target, "junction");
  await expect(api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).rejects.toThrow(/escaped|identity|unsafe/);
  expect(readFileSync(join(outside, "untouched"), "utf8")).toBe("outside"); expect(existsSync(retained)).toBe(true); expect(readDataRootSelector(home)?.pendingMigration).toBeTruthy();
});
it.each(["before", "after"])("recovers after interruption %s the selector publication", async when => {
  const migrated = await api.migrateDataRoot(request(), stopped), original = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === join(home, ".vykor-root.json")) { if (when === "after") await original(from, to); throw new Error("publication interrupted"); }
    return original(from, to);
  });
  await expect(api.commitDataRootMigration(migrated.journalPath, { homeDir: home })).rejects.toThrow("publication interrupted"); vi.restoreAllMocks();
  expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("failed"); expect(readDataRootSelector(home)).toBeUndefined(); expect(existsSync(source)).toBe(true);
});
it("detects a standalone legacy source link changed after copying but before installation", async () => {
  const originalTarget = join(root, "external-original"), replacement = join(root, "external-replacement"), legacyLink = join(root, "Documents/Vykor/user-link");
  mkdirSync(originalTarget); mkdirSync(replacement); mkdirSync(join(root, "Documents/Vykor"), { recursive: true }); await fs.symlink(originalTarget, legacyLink, "junction");
  const verify = services.verifyDataRootCopy;
  vi.spyOn(services, "verifyDataRootCopy").mockImplementationOnce(async path => { await verify(path); await fs.unlink(legacyLink); await fs.symlink(replacement, legacyLink, "junction"); });
  const migrated = await api.migrateDataRoot(request(), stopped); expect(migrated.phase).toBe("failed"); expect(existsSync(target)).toBe(false);
});
it.each(["different-root", "same-root"])("keeps the next %s migration selected when a published journal is retried", async mode => {
  const old = await api.migrateDataRoot(request(), stopped);
  await api.commitDataRootMigration(old.journalPath, { homeDir: home });
  const published = await api.markDataRootMigrationWritersReleased(old.journalPath, { homeDir: home });
  const publishedSelector = await fs.lstat(join(home, ".vykor-root.json"));
  expect(await api.markDataRootMigrationWritersReleased(old.journalPath, { homeDir: home })).toEqual(published);
  expect((await fs.lstat(join(home, ".vykor-root.json"))).ino).toBe(publishedSelector.ino);
  source = target; target = mode === "same-root" ? source : join(root, "third");
  const next = await api.migrateDataRoot(request(), stopped); expect(next.phase).toBe("verified");
  const selector = readDataRootSelector(home);
  for (const operation of [api.markDataRootMigrationWritersReleased, api.commitDataRootMigration, api.recoverDataRootMigration]) {
    await expect(operation(old.journalPath, { homeDir: home })).rejects.toThrow(/not selected/);
    expect(readDataRootSelector(home)).toEqual(selector);
    expect(() => resolveDataRootSelection({ homeDir: home, env: {} })).toThrow(/pending/);
  }
  expect((await api.recoverDataRootMigration(next.journalPath, { homeDir: home })).phase).toBe("failed");
  expect(resolveDataRootSelection({ homeDir: home, env: {} }).dataRoot).toBe(source);
});
it.each(["id", "journalPath"])("requires the pending %s as well as the other journal identifier", async field => {
  const migrated = await api.migrateDataRoot(request(), stopped);
  await api.commitDataRootMigration(migrated.journalPath, { homeDir: home });
  const selector = readDataRootSelector(home)!;
  selector.pendingMigration = { id: migrated.id, journalPath: migrated.journalPath, [field]: field === "id" ? "00000000-0000-4000-8000-000000000000" : join(root, "other-journal.json") };
  await writeDataRootSelector(home, selector);
  for (const operation of [api.markDataRootMigrationWritersReleased, api.commitDataRootMigration, api.recoverDataRootMigration]) {
    await expect(operation(migrated.journalPath, { homeDir: home })).rejects.toThrow(/not selected/);
    expect(readDataRootSelector(home)).toEqual(selector);
  }
});
async function interruptTargetRelease() {
  const migrated = await api.migrateDataRoot(request(), stopped);
  await api.commitDataRootMigration(migrated.journalPath, { homeDir: home });
  const rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === join(home, ".vykor-root.json")) throw new Error("release interrupted");
    return rename(from, to);
  });
  await expect(api.markDataRootMigrationWritersReleased(migrated.journalPath, { homeDir: home })).rejects.toThrow("release interrupted");
  vi.restoreAllMocks();
  expect(JSON.parse(readFileSync(migrated.journalPath, "utf8")).writersReleased).toBe(true);
  expect(readDataRootSelector(home)?.pendingMigration?.id).toBe(migrated.id);
  expect(() => resolveDataRootSelection({ homeDir: home, env: {} })).toThrow(/pending/);
  return migrated;
}
it("finishes its own interrupted target release through the local recover command", async () => {
  const migrated = await interruptTargetRelease();
  const cli = fileURLToPath(new URL("../../../../../apps/cli/src/index.ts", import.meta.url));
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", loader, cli, "data-root", "recover", "--journal", migrated.journalPath], {
    env: { ...process.env, HOME: home, USERPROFILE: home, VYKOR_CONFIG_DIR: undefined, VYKOR_DATA_DIR: undefined, VYKOR_CHANNELS_DIR: undefined, VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: undefined }, windowsHide: true, timeout: 45000,
  });
  expect(JSON.parse(stdout)).toMatchObject({ phase: "committed", writersReleased: true });
  expect(readDataRootSelector(home)?.pendingMigration).toBeUndefined();
  writeFileSync(join(target, "new-user-data"), "legitimate new target write");
  expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("committed");
  expect(readDataRootSelector(home)).toEqual({ version: 1, dataRoot: target });
  expect(readFileSync(join(target, "new-user-data"), "utf8")).toBe("legitimate new target write");
  expect(existsSync(join(source, "data/session-runtime/sessions.db"))).toBe(true);
}, 60000);
it.each(["new-pending", "wrong-root", "replaced-target"] as const)("preserves %s instead of forwarding an unrelated released journal", async kind => {
  const migrated = await interruptTargetRelease();
  const selected = readDataRootSelector(home)!;
  if (kind === "new-pending") selected.pendingMigration = { id: "next-migration", journalPath: join(root, "next.json") };
  if (kind === "wrong-root") selected.dataRoot = source;
  if (kind !== "replaced-target") await writeDataRootSelector(home, selected);
  else { await fs.rename(target, join(root, "retained-installed-target")); mkdirSync(target); }
  writeFileSync(join(target, "new-user-data"), "preserve current target");
  await expect(api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).rejects.toThrow(/selected|selection|identity|released|changed/i);
  expect(readDataRootSelector(home)).toEqual(selected);
  expect(readFileSync(join(target, "new-user-data"), "utf8")).toBe("preserve current target");
});
async function useExternalDatabase() {
  const databasePath = join(root, "custom/activity.sqlite");
  mkdirSync(join(root, "custom")); await fs.rename(join(source, "data/session-runtime/sessions.db"), databasePath);
  rmSync(join(source, "data"), { recursive: true });
  return { ...request(), legacy: { ...request().legacy, databasePath } };
}
it.each(["different-root", "same-root"])("restores the original tree without data after %s commit with an external database", async mode => {
  if (mode === "same-root") target = source;
  const input = await useExternalDatabase(), database = readFileSync(input.legacy.databasePath);
  const migrated = await api.migrateDataRoot(input, stopped); expect(migrated.phase).toBe("verified");
  expect((await api.commitDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("committed");
  const recovered = await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home });
  expect(recovered.phase).toBe("failed");
  expect(await fs.readdir(source)).toEqual(["credentials.json"]);
  expect(readFileSync(join(source, "credentials.json"), "utf8")).toBe('{"key":"sensitive"}');
  expect(readFileSync(input.legacy.databasePath)).toEqual(database);
  expect(readDataRootSelector(home)).toBeUndefined();
  expect(await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).toEqual(recovered);
});
it.each([
  ["different-root", "data"], ["different-root", "data/migrations"],
  ["same-root", "data"], ["same-root", "data/migrations"],
])("preserves unknown contents in %s newly created %s during recovery", async (mode, directory) => {
  if (mode === "same-root") target = source;
  const migrated = await api.migrateDataRoot(await useExternalDatabase(), stopped);
  await api.commitDataRootMigration(migrated.journalPath, { homeDir: home });
  const journal = JSON.parse(readFileSync(migrated.journalPath, "utf8")), oldPath = mode === "same-root" ? journal.backupRoot : source;
  const unknown = join(oldPath, directory, "unknown.txt"); writeFileSync(unknown, "keep unknown data");
  const selector = readDataRootSelector(home);
  expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("rollback_failed");
  expect(readFileSync(unknown, "utf8")).toBe("keep unknown data");
  expect(existsSync(join(oldPath, "data/migrations/moved-root.json"))).toBe(true);
  expect(existsSync(target)).toBe(true); expect(readDataRootSelector(home)).toEqual(selector);
});
it.each(["creation", "cleanup"])("recovers the owned marker chain after interrupted %s", async point => {
  if (point === "cleanup") target = source;
  const migrated = await api.migrateDataRoot(await useExternalDatabase(), stopped);
  const journal = JSON.parse(readFileSync(migrated.journalPath, "utf8")), oldPath = point === "cleanup" ? journal.backupRoot : source;
  const markerDirectory = join(oldPath, "data/migrations");
  if (point === "creation") {
    const mkdir = fs.mkdir;
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      if (String(args[0]) === markerDirectory) { await mkdir(join(oldPath, "data")); throw new Error("marker creation interrupted"); }
      return mkdir(...args);
    });
    await expect(api.commitDataRootMigration(migrated.journalPath, { homeDir: home })).rejects.toThrow("marker creation interrupted");
  } else {
    await api.commitDataRootMigration(migrated.journalPath, { homeDir: home });
    const rmdir = fs.rmdir;
    vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
      await rmdir(...args);
      if (String(args[0]) === markerDirectory) throw new Error("marker cleanup interrupted");
    });
    expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("rollback_failed");
  }
  vi.restoreAllMocks();
  expect(JSON.parse(readFileSync(migrated.journalPath, "utf8")).oldMarkerCreatedDirectories).toEqual(["data", "data/migrations"]);
  expect(await fs.readdir(join(oldPath, "data"))).toEqual([]);
  expect((await api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).phase).toBe("failed");
  expect(await fs.readdir(source)).toEqual(["credentials.json"]); expect(readDataRootSelector(home)).toBeUndefined();
});
it("refuses marker cleanup directories outside the recorded fixed chain", async () => {
  const migrated = await api.migrateDataRoot(await useExternalDatabase(), stopped);
  const journal = JSON.parse(readFileSync(migrated.journalPath, "utf8"));
  journal.oldMarkerCreatedDirectories = ["../custom"];
  writeFileSync(migrated.journalPath, JSON.stringify(journal));
  await expect(api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).rejects.toThrow(/marker directory chain/);
  expect(existsSync(join(root, "custom/activity.sqlite"))).toBe(true);
  expect(readDataRootSelector(home)?.pendingMigration?.id).toBe(migrated.id);
});
