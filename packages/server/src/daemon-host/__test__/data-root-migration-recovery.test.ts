import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionDatabase } from "../../../../services/src/database/session-database.js";
import { readDataRootSelector, resolveDataRootSelection } from "@vykor/host-config/paths";
import * as services from "@vykor/services/data-root-relocation";
import * as api from "../data-root-migration.js";
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));
let root: string, source: string, target: string, home: string;
const request = () => ({ homeDir: home, sourceRoot: source, targetRoot: target, environment: {}, legacy: { documentsDir: join(root, "Documents"), userDataDir: join(root, "Electron") } });
const stopped = { prepareStoppedCopy: async () => ({}) };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "root-recovery-")); source = join(root, "source"); target = join(root, "target"); home = join(root, "home"); mkdirSync(home); SessionDatabase.open({ path: join(source, "data/session-runtime/sessions.db") }).close(); writeFileSync(join(source, "credentials.json"), '{"key":"sensitive"}'); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
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
  await expect(api.recoverDataRootMigration(migrated.journalPath, { homeDir: home })).rejects.toThrow(/released/);
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
