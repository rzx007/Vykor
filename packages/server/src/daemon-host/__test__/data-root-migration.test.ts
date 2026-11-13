import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installLocalNativePlugin } from "../../../../plugins/src/installation/installer.js";
import { writeNativeAppFixture } from "../../../../plugins/src/__test__/helpers/native-app.js";
import { SessionDatabase } from "../../../../services/src/database/session-database.js";
import * as tables from "../../../../services/src/session-runtime/schema.js";
import { getProjectDirectoryKey, readDataRootSelector } from "@vykor/host-config/paths";
import { securePrivateDirectory, securePrivateFile } from "@vykor/host-config";

let root: string, source: string, target: string, home: string;
const file = (path: string, data: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const database = () => join(source, "data/session-runtime/sessions.db");
const request = () => ({ homeDir: home, sourceRoot: source, targetRoot: target, environment: { PRIVATE_SENTINEL: "never-journal-environment" }, legacy: { documentsDir: join(root, "Documents"), userDataDir: join(root, "Electron") } });
const stopped = { prepareStoppedCopy: async () => ({}) };
const api = async (): Promise<any> => { const api = await import("../data-root-migration.js").catch(() => ({})); expect(api).toHaveProperty("migrateDataRoot"); return api; };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "root-migration-")); source = join(root, "source"); target = join(root, "target"); home = join(root, "home"); mkdirSync(home);
  const db = SessionDatabase.open({ path: database() });
  db.orm.insert(tables.sessions).values({ id: "session", cwd: join(source, "workspaces/chat"), title: "title", model: "m", status: "idle", metadataJson: "{}", createdAt: 1, updatedAt: 2 }).run(); db.close();
  file(join(source, "credentials.json"), '{"providers":{"test":{"apiKey":"never-journal-secret"}}}');
  file(join(source, "unknown/user.lock"), "keep unknown lock"); file(join(source, "skills/tool.sh"), "executable");
  file(join(source, "data/daemon/registry.json"), '{"token":"never-copy-active-token"}');
  file(join(source, "data/memory/remember.md"), "never-journal-body"); utimesSync(join(source, "data/memory/remember.md"), 1_500_000_000, 1_500_000_000);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("copies only the final inventory, keeps original bytes/times and installs independent relocated data", async () => {
  const before = digest(database()), credentials = digest(join(source, "credentials.json"));
  const result = await (await api()).migrateDataRoot(request(), stopped);
  expect(result.phase).toBe("verified"); expect(result.writersReleased).toBe(false);
  expect(digest(database())).toBe(before); expect(digest(join(source, "credentials.json"))).toBe(credentials);
  expect(readFileSync(join(target, "unknown/user.lock"), "utf8")).toBe("keep unknown lock"); expect(existsSync(join(target, "data/daemon/registry.json"))).toBe(false);
  expect(statSync(join(target, "data/memory/remember.md")).mtimeMs).toBe(1_500_000_000_000);
  expect(statSync(join(target, "credentials.json")).ino).not.toBe(statSync(join(source, "credentials.json")).ino);
  const copy = SessionDatabase.open({ path: join(target, "data/session-runtime/sessions.db"), fileMustExist: true });
  expect(copy.orm.select().from(tables.sessions).all()).toMatchObject([{ id: "session", cwd: join(target, "workspaces/chat") }]); copy.close();
  expect(readDataRootSelector(home)?.pendingMigration?.id).toBe(result.id);
  const journal = readFileSync(result.journalPath, "utf8"); for (const text of ["never-journal-secret", "never-journal-body", "never-journal-environment", "never-copy-active-token"]) expect(journal).not.toContain(text);
});

it.each(["workspace", "channel", "legacy-documents", "recovery"])("keeps %s memory and rules readable without persistent session registrations", async kind => {
  const db = SessionDatabase.open({ path: database() });
  db.orm.delete(tables.sessions).run(); db.close();
  const oldCwd = kind === "legacy-documents" ? join(root, "Documents/Vykor/memory-only")
    : join(source, kind === "channel" ? "channels/connector/chat" : "workspaces/memory-only/nested");
  const nextCwd = kind === "legacy-documents" ? join(target, "workspaces/legacy/memory-only")
    : join(target, kind === "channel" ? "channels/connector/chat" : "workspaces/memory-only/nested");
  file(join(oldCwd, "keep.txt"), "managed workspace");
  const directories = [["local_rules/projects", false], ["data/memory", true], ["data/session-memory", false]] as const;
  for (const [directory, folded] of directories)
    file(join(source, directory, getProjectDirectoryKey(oldCwd, folded), "fact.md"), "explicitly retained fact");
  const result = await (await api()).migrateDataRoot(request(), stopped);
  expect(result.phase).toBe("verified");
  expect(readFileSync(join(nextCwd, "keep.txt"), "utf8")).toBe("managed workspace");
  for (const [directory, folded] of directories) {
    expect(readFileSync(join(target, directory, getProjectDirectoryKey(nextCwd, folded), "fact.md"), "utf8")).toBe("explicitly retained fact");
    expect(readFileSync(join(source, directory, getProjectDirectoryKey(oldCwd, folded), "fact.md"), "utf8")).toBe("explicitly retained fact");
  }
  if (kind === "recovery") {
    const recovered = await (await api()).recoverDataRootMigration(result.journalPath, { homeDir: home });
    expect(recovered).toMatchObject({ phase: "failed", recoveryWritersReleased: true });
    expect(readDataRootSelector(home)).toBeUndefined();
    expect(await (await api()).recoverDataRootMigration(result.journalPath, { homeDir: home })).toEqual(recovered);
    for (const [directory, folded] of directories)
      expect(readFileSync(join(source, directory, getProjectDirectoryKey(oldCwd, folded), "fact.md"), "utf8")).toBe("explicitly retained fact");
  }
});

it.each(["canonical", "custom"])("uses committed %s WAL records and protects a schedule-only project during the second inventory", async kind => {
  const project = join(root, "Documents/Vykor/real-project"); file(join(project, "keep.txt"), "project");
  const chosen = kind === "custom" ? join(root, "custom/activity.sqlite") : database();
  if (kind === "custom") { mkdirSync(dirname(chosen)); renameSync(database(), chosen); }
  const writer = SessionDatabase.open({ path: chosen });
  try {
    writer.orm.insert(tables.scheduledTasks).values({ id: "future", name: "task", prompt: "text", recurrence: "0 * * * *", recurrenceFormat: "cron", timezone: "UTC", status: "active", destination: "standalone", projectPathsJson: JSON.stringify([project]), executionMode: "local", skillNamesJson: "[]", pluginNamesJson: "[]", permissionProfileJson: "{}", overlapPolicy: "skip", missedRunPolicy: "skip", createdBy: "user", runCount: 0, createdAt: 1, updatedAt: 2 }).run();
    const input = request(); if (kind === "custom") Object.assign(input.legacy, { databasePath: chosen });
    const result = await (await api()).migrateDataRoot(input, stopped); expect(result.phase).toBe("verified");
    expect(existsSync(join(target, "workspaces/legacy/real-project"))).toBe(false); expect(readFileSync(join(project, "keep.txt"), "utf8")).toBe("project");
    const db = SessionDatabase.open({ path: join(target, "data/session-runtime/sessions.db"), fileMustExist: true }); expect(db.orm.select().from(tables.scheduledTasks).all()[0]?.projectPathsJson).toBe(JSON.stringify([project])); db.close();
  } finally { writer.close(); }
});

it("refuses malformed credentials without repairing them or committing the selection", async () => {
  file(join(source, "credentials.json"), '{"never-journal-broken-secret"');
  const result = await (await api()).migrateDataRoot(request(), stopped);
  expect(result.phase).toBe("failed"); expect(existsSync(target)).toBe(false); expect(readFileSync(join(source, "credentials.json"), "utf8")).toBe('{"never-journal-broken-secret"');
  expect(readFileSync(result.journalPath, "utf8")).not.toContain("never-journal-broken-secret");
});

it.each(["blob", "note", "plugin"])("reopens real %s resources and rejects damaged copies before installation", async resource => {
  if (resource === "blob") {
    const hash = createHash("sha256").update("good").digest("hex"), db = SessionDatabase.open({ path: database() });
    db.orm.insert(tables.attachmentAssets).values({ id: "asset", displayName: "file", sha256: hash, sizeBytes: 4, status: "ready", createdAt: 1, updatedAt: 2 }).run(); db.close();
    file(join(source, "data/session-runtime/attachments/blobs", hash.slice(0, 2), hash), "bad!");
  } else if (resource === "note") {
    file(join(source, "data/session-runtime/notes/note.md"), "note"); file(join(source, "data/session-runtime/notes/organization.json"), '{"version":999}');
  } else {
    const plugin = join(root, "plugin"); await writeNativeAppFixture(plugin);
    const result = await installLocalNativePlugin({ sourcePath: plugin, scope: "user", cwd: root, approvedPermissions: ["ui:invoke-own-tools", "ui:render"], cacheDir: join(source, "plugins/cache"), storePath: join(source, "plugins/installed.json") }); expect(result.status).toBe("installed");
    const store = JSON.parse(readFileSync(join(source, "plugins/installed.json"), "utf8")), installed = Object.values(store.plugins)[0] as any;
    file(join(installed.cachePath, "ui/panel.html"), "changed");
  }
  const result = await (await api()).migrateDataRoot(request(), stopped); expect(result.phase).toBe("failed"); expect(existsSync(target)).toBe(false);
});

it.runIf(process.platform === "win32")("copies between real C and E volumes without renaming the source across volumes", async () => {
  const crossRoot = mkdtempSync("E:/t8-owned-volume-");
  try {
    cpSync(source, join(crossRoot, "source"), { recursive: true }); source = join(crossRoot, "source"); expect(statSync(root).dev).not.toBe(statSync(crossRoot).dev);
    const result = await (await api()).migrateDataRoot(request(), stopped); expect(result.phase).toBe("verified");
    expect(readFileSync(join(target, "unknown/user.lock"), "utf8")).toBe("keep unknown lock"); expect(existsSync(database())).toBe(true);
    try { expect((await (await api()).commitDataRootMigration(result.journalPath, { homeDir: home })).phase).toBe("committed"); }
    catch (error) {
      expect((error as Error).message).toMatch(/private/);
      console.info("E-to-C reached verified; source moved-marker ACL refused commit; recovering.");
      expect((await (await api()).recoverDataRootMigration(result.journalPath, { homeDir: home })).phase).toBe("failed"); expect(readDataRootSelector(home)).toBeUndefined(); expect(existsSync(database())).toBe(true);
    }
  } finally { rmSync(crossRoot, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("refuses an owned target parent with a real Deny ACL before writing a pending selector", async () => {
  const parent = join(root, "denied"); mkdirSync(parent); target = join(parent, "target");
  const ps = (script: string, extra: Record<string, string> = {}) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ${script}`], { encoding: "utf8", windowsHide: true, env: { ...process.env, T8_ACL_PATH: parent, ...extra } }).trim();
  const acl = ps("[IO.Directory]::GetAccessControl($env:T8_ACL_PATH).GetSecurityDescriptorSddlForm('Access')");
  try {
    ps("$a=[IO.Directory]::GetAccessControl($env:T8_ACL_PATH); $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($u,'WriteData,AppendData','Deny')); [IO.Directory]::SetAccessControl($env:T8_ACL_PATH,$a)");
    await expect((await api()).migrateDataRoot(request(), stopped)).rejects.toThrow(/permissions|preflight/); expect(readDataRootSelector(home)).toBeUndefined(); expect(existsSync(database())).toBe(true);
  } finally { ps("$a=[IO.Directory]::GetAccessControl($env:T8_ACL_PATH); $a.SetSecurityDescriptorSddlForm($env:T8_ACL_SDDL,'Access'); [IO.Directory]::SetAccessControl($env:T8_ACL_PATH,$a)", { T8_ACL_SDDL: acl }); }
});

it.runIf(process.platform === "win32")("checks E-volume private file and directory permissions without changing any existing parent ACL", async () => {
  const owned = mkdtempSync("E:/t8-owned-acl-"), probe = join(owned, "file.json"), directory = join(owned, "private-directory"); writeFileSync(probe, "{}"); mkdirSync(directory);
  try {
    const checks: Record<string, string> = {};
    for (const [name, action] of [["file", () => securePrivateFile(probe)], ["directory", () => securePrivateDirectory(directory)]] as const) {
      try { await action(); checks[name] = "private ACL verified"; } catch (error) { checks[name] = `SetAccessControl refused (${(error as Error & { cause?: { code?: number } }).cause?.code})`; }
    }
    console.info("Owned E-volume permission probe:", checks);
    target = join(owned, "target");
    if (checks.directory?.startsWith("SetAccessControl")) { await expect((await api()).migrateDataRoot(request(), stopped)).rejects.toThrow(/permissions/); expect(readDataRootSelector(home)).toBeUndefined(); expect(existsSync(database())).toBe(true); }
    else expect((await (await api()).migrateDataRoot(request(), stopped)).phase).toBe("verified");
  } finally { rmSync(owned, { recursive: true, force: true }); }
});
it("waits for a fresh frozen Desktop export and rechecks its receipt before any business copy", async () => {
  const userDataDir = join(root, "Electron"), documentsDir = join(root, "Documents"), desktopExportPath = join(source, "data/desktop/legacy-import.json"); mkdirSync(join(userDataDir, "Local Storage"), { recursive: true });
  const result = await (await api()).migrateDataRoot(request(), { prepareStoppedCopy: async () => {
    file(desktopExportPath, JSON.stringify({ version: 1, sources: {}, desktopScan: { version: 1, id: "fresh-scan", userDataDir, documentsDir, sources: {} } }));
    return { freshDesktopScanId: "fresh-scan", desktopExportPath };
  } });
  expect(result.phase).toBe("verified");
});
it("does not treat a missing database as proof of empty registrations", async () => {
  rmSync(database()); const result = await (await api()).migrateDataRoot(request(), stopped);
  expect(result.phase).toBe("failed"); expect(existsSync(target)).toBe(false); expect(existsSync(database())).toBe(false);
});
