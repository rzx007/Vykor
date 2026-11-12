import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inspectDataRootMigration } from "../data-root-sources.js";
import { readLegacyDataLocation } from "../data-location.js";
import { relocateManagedPath } from "@vykor/host-config/paths";
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

let base: string, home: string, sourceRoot: string, targetRoot: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "root-sources-")); home = join(base, "home");
  sourceRoot = join(home, "old-root"); targetRoot = join(home, "new-root");
  mkdirSync(sourceRoot, { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); });
function file(path: string, value = "owned data") { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
const request = () => ({ homeDir: home, sourceRoot, targetRoot, environment: {} });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function seedDb(path: string, wal = false) {
  mkdirSync(dirname(path), { recursive: true });
  const require = createRequire(resolve("../services/package.json"));
  const module = require.resolve("better-sqlite3");
  const script = `const Database=require(process.argv[1]);const db=new Database(process.argv[2]);${wal ? "db.pragma('journal_mode=WAL');db.pragma('wal_autocheckpoint=0');" : ""}db.exec("CREATE TABLE sessions(id TEXT);INSERT INTO sessions VALUES('committed')");${wal ? "process.exit(0)" : "db.close()"}`;
  const child = spawnSync(process.execPath, ["-e", script, module, path], { windowsHide: true, encoding: "utf8" });
  if (child.status !== 0) throw new Error(child.stderr);
}
function snapshot(path: string): unknown {
  return readdirSync(path, { withFileTypes: true }).map(entry => [entry.name, entry.isDirectory() ? snapshot(join(path, entry.name)) : digest(readFileSync(join(path, entry.name)).toString("base64"))]);
}

it("lists every selected source once, with custom database sidecars and separate runtime mappings", async () => {
  const data = join(base, "split"), documents = join(base, "relocated-documents"), userData = join(base, "electron");
  const db = join(data, "my-chat.sqlite"); seedDb(db, true);
  file(join(data, "attachments", "blobs", "a")); file(join(data, "attachment-session-resources", "s"));
  file(join(data, "notes", "note.md")); file(join(data, "storage-policy.json"), "{}"); file(join(data, "usage-settings.json"), "{}"); file(join(data, "logs", "log.txt"));
  file(join(data, "attachments", "images", "cached.png"));
  file(join(sourceRoot, "unknown-user-file")); file(join(sourceRoot, "data", "daemon", "registry.json"), '{"token":"PRIVATE"}');
  const work = join(documents, "Vykor", "day", "chat"); file(join(work, "a.txt"));
  file(join(documents, "Vykor", "channels", "telegram", "chat", "b.txt")); file(join(documents, "Vykor", "loose.txt"));
  file(join(home, ".vykor", "output_styles", "custom.md")); file(join(base, "images", "one.png"));
  file(join(userData, "worktrees", "task", "result.txt")); file(join(userData, "window-preferences.json"));
  const result = await inspectDataRootMigration({ ...request(), environment: { VYKOR_DATA_DIR: data, VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: join(base, "images") }, legacy: { databasePath: db, documentsDir: documents, userDataDir: userData, workspacePaths: [work, work] } });
  expect(result.blockers).toEqual([]);
  const target = (suffix: string) => join(targetRoot, suffix);
  expect(result.entries.find(entry => entry.source === db)?.target).toBe(target("data/session-runtime/sessions.db"));
  expect(result.entries.find(entry => entry.source === `${db}-wal`)?.target).toBe(target("data/session-runtime/sessions.db-wal"));
  expect(result.entries.find(entry => entry.source === join(data, "notes", "note.md"))?.target).toBe(target("data/session-runtime/notes/note.md"));
  expect(result.entries.find(entry => entry.source === join(data, "logs", "log.txt"))?.target).toBe(target("data/logs/log.txt"));
  expect(result.entries.find(entry => entry.source.endsWith("cached.png"))?.target).toBe(target("data/attachments/images/cached.png"));
  expect(result.entries.find(entry => entry.source === join(work, "a.txt"))?.target).toBe(target("workspaces/day/chat/a.txt"));
  expect(result.entries.find(entry => entry.source.endsWith("loose.txt"))?.target).toBe(target("workspaces/legacy/loose.txt"));
  expect(result.entries.filter(entry => entry.source.endsWith("b.txt"))).toHaveLength(1);
  expect(result.entries.some(entry => /registry.json|window-preferences/.test(entry.source))).toBe(false);
  expect(new Set(result.entries.map(entry => entry.source)).size).toBe(result.entries.length);
  expect(result.requiredValidations).toContain("sqlite-on-stopped-copy");
  expect(result.databases[0]).toMatchObject({ path: db, walPath: `${db}-wal`, inspection: "file-only" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

it("does not create SHM, checkpoint WAL or write anything when inspecting committed WAL records", async () => {
  const db = join(sourceRoot, "data", "session-runtime", "sessions.db"); seedDb(db, true);
  rmSync(`${db}-shm`, { force: true });
  const before = snapshot(base);
  const preview = await inspectDataRootMigration(request());
  expect(preview.blockers).toEqual([]);
  expect(preview.databases).toMatchObject([{ path: db, walPath: `${db}-wal`, inspection: "file-only" }]);
  expect(snapshot(base)).toEqual(before);
});

it.each(["{", '{"version":2,"location":{}}', '{"version":1,"location":{"directory":"relative"}}'])("rejects damaged old location records: %s", async content => {
  const location = join(base, "runtime-data-location.json"); file(location, content);
  await expect(readLegacyDataLocation(location)).rejects.toThrow(/location/i);
  const result = await inspectDataRootMigration({ ...request(), legacy: { dataLocationPath: location } });
  expect(result.blockers).toContainEqual(expect.objectContaining({ code: "invalid_data_location", path: location }));
});

it("reports damaged settings, selectors and SQLite headers without returning their contents", async () => {
  file(join(sourceRoot, "settings.json"), "PRIVATE broken"); file(join(home, ".vykor-root.json"), '{"version":42}');
  file(join(sourceRoot, "data", "session-runtime", "sessions.db"), "PRIVATE broken sqlite");
  const preview = await inspectDataRootMigration(request());
  expect(preview.blockers.map(item => item.code)).toEqual(expect.arrayContaining(["invalid_settings", "invalid_selector", "invalid_database"]));
  expect(JSON.stringify(preview)).not.toContain("PRIVATE");
});

it("blocks distinct databases, nonempty targets and different content mapped onto the same filename", async () => {
  seedDb(join(sourceRoot, "data", "session-runtime", "sessions.db"));
  const data = join(base, "split"); seedDb(join(data, "session-runtime", "sessions.db"));
  file(join(data, "session-runtime", "sessions.db-wal"), "different database state");
  file(join(sourceRoot, "output_styles", "a.md"), "one"); file(join(home, ".vykor", "output_styles", "a.md"), "two");
  file(join(targetRoot, "keep"));
  const preview = await inspectDataRootMigration({ ...request(), environment: { VYKOR_DATA_DIR: data } });
  expect(preview.blockers.map(item => item.code)).toEqual(expect.arrayContaining(["database_conflict", "target_not_empty", "content_conflict"]));
});

it("accepts same-root upgrades but rejects disk/home/project ancestors and nested targets", async () => {
  file(join(sourceRoot, "keep"));
  expect((await inspectDataRootMigration({ ...request(), targetRoot: sourceRoot })).mode).toBe("same-root");
  expect((await inspectDataRootMigration({ ...request(), targetRoot: sourceRoot })).blockers).toEqual([]);
  for (const unsafe of [home, dirname(home)]) {
    const preview = await inspectDataRootMigration({ ...request(), sourceRoot: unsafe });
    expect(preview.blockers.map(item => item.code)).toContain("unsafe_root");
  }
  expect((await inspectDataRootMigration({ ...request(), projectPaths: [join(sourceRoot, "real-project")] })).blockers.map(item => item.code)).toContain("unsafe_root");
  expect((await inspectDataRootMigration({ ...request(), targetRoot: join(sourceRoot, "nested") })).blockers.map(item => item.code)).toContain("overlapping_roots");
});

it("does not traverse junctions; preserves external links and records managed link relocation", async () => {
  const outside = join(base, "external-project"); file(join(outside, "keep.txt")); file(join(sourceRoot, "skills", "a.md"));
  symlinkSync(outside, join(sourceRoot, "external-link"), "junction"); symlinkSync(join(sourceRoot, "skills"), join(sourceRoot, "managed-link"), "junction");
  const preview = await inspectDataRootMigration({ ...request(), projectPaths: [outside] });
  expect(preview.blockers).toEqual([]);
  expect(preview.entries.some(entry => entry.source.includes("keep.txt"))).toBe(false);
  expect(preview.links.find(link => link.path.endsWith("external-link"))?.action).toBe("preserve");
  expect(preview.links.find(link => link.path.endsWith("managed-link"))).toMatchObject({ action: "relocate", target: join(targetRoot, "skills") });
  const alias = join(base, "alias"); symlinkSync(sourceRoot, alias, "junction");
  const aliased = await inspectDataRootMigration({ ...request(), legacy: { documentsDir: alias } });
  expect(new Set(aliased.entries.map(entry => entry.source)).size).toBe(aliased.entries.length);
  symlinkSync(outside, join(base, "unsafe-target"), "junction");
  expect((await inspectDataRootMigration({ ...request(), targetRoot: join(base, "unsafe-target", "new") })).blockers.map(item => item.code)).toContain("unsafe_junction");
});

it("reports capacity and permission failures without probing by writing a file", async () => {
  file(join(sourceRoot, "a"), "12345");
  const before = snapshot(base);
  vi.spyOn(fs, "statfs").mockResolvedValue({ bavail: 0, bsize: 4096 } as never);
  vi.spyOn(fs, "access").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
  const preview = await inspectDataRootMigration(request());
  expect(preview.blockers.map(item => item.code)).toEqual(expect.arrayContaining(["insufficient_space", "target_not_writable"]));
  expect(snapshot(base)).toEqual(before);
});

it("requires a whole-profile export including empty scans and unresolved partial acknowledgement", async () => {
  const userData = join(base, "desktop"); file(join(userData, "Local Storage", "leveldb", "000001.log"), "PRIVATE BROWSER");
  const manifest = join(sourceRoot, "data", "desktop", "legacy-import.json");
  const preview = () => inspectDataRootMigration({ ...request(), legacy: { userDataDir: userData } });
  expect((await preview()).blockers.map(item => item.code)).toContain("needs_desktop_export");
  file(manifest, JSON.stringify({ version: 1, sources: {}, desktopScan: { version: 1, id: "scan-empty", userDataDir: userData, sources: {} } }));
  expect((await preview()).blockers).toEqual([]);
  const partial = { sourceDigest: "a".repeat(64), targetDigest: "b".repeat(64), revision: 1, status: "partial", reason: "session-not-found", unresolvedSessionIds: ["missing"] };
  const content = { version: 1, sources: { composer: partial }, desktopScan: { version: 1, id: "scan-partial", userDataDir: userData, sources: { composer: partial.sourceDigest } } };
  file(manifest, JSON.stringify(content));
  expect((await preview()).blockers.map(item => item.code)).toContain("needs_desktop_export");
  file(manifest, JSON.stringify({ ...content, sources: { composer: { ...partial, retainedSourceAcknowledged: true } } }));
  expect((await preview()).blockers).toEqual([]);
  expect((await preview()).requiredValidations).toContain("fresh-desktop-scan-after-freeze");
  file(manifest, JSON.stringify({ ...content, desktopScan: { ...content.desktopScan, sources: { composer: "c".repeat(64) } } }));
  expect((await preview()).blockers.map(item => item.code)).toContain("needs_desktop_export");
  expect(JSON.stringify(await preview())).not.toContain("PRIVATE BROWSER");
});

it("blocks an original fixed old environment root but not the temporary CLI root", async () => {
  const original = { homeDir: home, explicitRoot: sourceRoot, environment: { VYKOR_CONFIG_DIR: sourceRoot } };
  expect((await inspectDataRootMigration({ ...request(), rootInputs: original })).blockers.map(item => item.code)).toContain("fixed_root_environment");
  expect((await inspectDataRootMigration({ ...request(), rootInputs: { ...original, environment: {} } })).blockers).toEqual([]);
});

it("does not follow generated channel or database-resource junctions outside their owner", async () => {
  const docs = join(base, "documents"), outside = join(base, "private-project");
  file(join(outside, "do-not-copy.txt")); mkdirSync(join(docs, "Vykor"), { recursive: true });
  symlinkSync(outside, join(docs, "Vykor", "channels"), "junction");
  const db = join(sourceRoot, "data", "session-runtime", "sessions.db"); seedDb(db);
  symlinkSync(outside, join(dirname(db), "attachments"), "junction");
  const preview = await inspectDataRootMigration({ ...request(), legacy: { documentsDir: docs } });
  expect(preview.blockers.map(item => item.code)).toContain("unsafe_junction");
  expect(preview.entries.some(entry => entry.source.endsWith("do-not-copy.txt"))).toBe(false);
});

it("leaves registered real projects inside the old Documents area in place", async () => {
  const docs = join(base, "documents"), project = join(docs, "Vykor", "real-project");
  file(join(project, "source.ts")); file(join(docs, "Vykor", "loose.txt"));
  const preview = await inspectDataRootMigration({ ...request(), projectPaths: [project], legacy: { documentsDir: docs } });
  expect(preview.entries.some(entry => entry.source.endsWith("source.ts"))).toBe(false);
  expect(relocateManagedPath(join(project, "source.ts"), preview.moves)).toBe(join(project, "source.ts"));
  expect(preview.entries.some(entry => entry.source.endsWith("loose.txt"))).toBe(true);
});

it("preserves unknown Documents links without scanning their external targets", async () => {
  const docs = join(base, "documents"), outside = join(base, "external"); file(join(outside, "private.txt"));
  mkdirSync(join(docs, "Vykor"), { recursive: true }); symlinkSync(outside, join(docs, "Vykor", "linked"), "junction");
  const preview = await inspectDataRootMigration({ ...request(), legacy: { documentsDir: docs } });
  expect(preview.blockers).toEqual([]);
  expect(preview.links).toContainEqual(expect.objectContaining({ path: join(docs, "Vykor", "linked"), action: "preserve" }));
  expect(preview.entries.some(entry => entry.source.endsWith("private.txt"))).toBe(false);
});

it("uses old worktreeRoot as configDir, preserving external project paths and browser preferences", async () => {
  const userData = join(base, "desktop"), manager = join(base, "old-manager"), project = join(base, "repository"), tree = join(manager, "worktrees", "task");
  file(join(tree, "result.txt")); file(join(project, "untouched.ts")); file(join(manager, "unrelated.txt"));
  file(join(userData, "git-settings.json"), JSON.stringify({ version: 1, preferences: { defaultScope: "uncommitted", viewMode: "unified", ignoreWhitespace: false, branchPrefix: "vykor/", defaultTaskLocation: "current", worktreeRoot: manager, autoCleanup: false }, worktrees: [{ id: "t", projectId: "p", projectPath: project, path: tree, branch: "task", slug: "task", configDir: manager, disposable: false, baseCommit: "abc" }] }));
  const preview = await inspectDataRootMigration({ ...request(), legacy: { userDataDir: userData } });
  expect(preview.blockers).toEqual([]);
  expect(preview.entries.find(item => item.source.endsWith("result.txt"))?.target).toBe(join(targetRoot, "worktrees", "task", "result.txt"));
  expect(preview.entries.some(item => /untouched.ts|unrelated.txt/.test(item.source))).toBe(false);
  expect(relocateManagedPath(project, preview.moves)).toBe(project);
});

it("includes registered worktrees from an earlier configDir after the preference changed", async () => {
  const userData = join(base, "desktop"), manager = join(base, "current-manager"), previous = join(base, "previous-manager"), project = join(base, "repository");
  const tree = join(previous, "worktrees", "retained-task"); file(join(tree, "kept.txt"));
  file(join(userData, "git-settings.json"), JSON.stringify({ version: 1, preferences: { defaultScope: "uncommitted", viewMode: "unified", ignoreWhitespace: false, branchPrefix: "vykor/", defaultTaskLocation: "current", worktreeRoot: manager, autoCleanup: false }, worktrees: [{ id: "t", projectId: "p", projectPath: project, path: tree, branch: "task", slug: "task", configDir: previous, disposable: false, baseCommit: "abc" }] }));
  const preview = await inspectDataRootMigration({ ...request(), legacy: { userDataDir: userData } });
  expect(preview.blockers).toEqual([]);
  expect(preview.entries.find(item => item.source.endsWith("kept.txt"))?.target).toBe(join(targetRoot, "worktrees", "retained-task", "kept.txt"));
});

it("reports malformed business manifest and git preferences instead of treating them as empty", async () => {
  const userData = join(base, "desktop");
  file(join(userData, "git-settings.json"), JSON.stringify({ version: 1, preferences: { worktreeRoot: null }, worktrees: [] }));
  file(join(sourceRoot, "data", "desktop", "legacy-import.json"), JSON.stringify({ version: 1, sources: { notes: { sourceDigest: "broken" } } }));
  const preview = await inspectDataRootMigration({ ...request(), legacy: { userDataDir: userData } });
  expect(preview.blockers.map(item => item.code)).toEqual(expect.arrayContaining(["invalid_desktop_export", "invalid_git_settings"]));
});

it("excludes active state even when the split runtime directory was named through an alias", async () => {
  const data = join(base, "data"), alias = join(base, "alias");
  file(join(data, "daemon", "registry.json"), '{"token":"PRIVATE"}'); file(join(data, "logs", "keep"));
  symlinkSync(data, alias, "junction");
  const preview = await inspectDataRootMigration({ ...request(), environment: { VYKOR_DATA_DIR: alias } });
  expect(preview.entries.some(item => item.source.endsWith("registry.json"))).toBe(false);
  expect(preview.entries.some(item => item.source.endsWith("keep"))).toBe(true);
});

it("rejects a whole secondary runtime scope that is the user home", async () => {
  file(join(home, "unrelated-private-file"));
  const preview = await inspectDataRootMigration({ ...request(), environment: { VYKOR_DATA_DIR: home } });
  expect(preview.blockers.map(item => item.code)).toContain("unsafe_source_scope");
  expect(preview.entries.some(item => item.source.endsWith("unrelated-private-file"))).toBe(false);
});

it("blocks unresolved composer exports even if the old profile storage directory is unavailable", async () => {
  file(join(sourceRoot, "data", "desktop", "legacy-import.json"), JSON.stringify({ version: 1, sources: { composer: { sourceDigest: "a".repeat(64), targetDigest: "b".repeat(64), revision: 1, status: "partial", reason: "session-not-found", unresolvedSessionIds: ["one"] } } }));
  const preview = await inspectDataRootMigration({ ...request(), legacy: { userDataDir: join(base, "missing-profile") } });
  expect(preview.blockers).toContainEqual(expect.objectContaining({ code: "needs_desktop_export", message: expect.stringContaining("Unresolved sessions: 1") }));
});

it("uses the host locations from an empty receipt to discover old data-location and channels", async () => {
  const docs = join(base, "OneDrive-docs"), userData = join(base, "desktop");
  const data = join(base, "custom-data"), database = join(data, "custom.sqlite"); seedDb(database);
  file(join(userData, "runtime-data-location.json"), JSON.stringify({ version: 1, location: { directory: data, storePath: database } }));
  file(join(docs, "Vykor", "channels", "a.txt"));
  file(join(sourceRoot, "data", "desktop", "legacy-import.json"), JSON.stringify({ version: 1, sources: {}, desktopScan: { version: 1, id: "empty", sources: {}, documentsDir: docs, userDataDir: userData } }));
  const preview = await inspectDataRootMigration(request());
  expect(preview.databases.map(item => item.path)).toContain(database);
  expect(preview.entries.find(item => item.source.endsWith("a.txt"))?.target).toBe(join(targetRoot, "channels", "a.txt"));
});

it("rejects incomplete optional locations before resolving or reading them", async () => {
  const preview = await inspectDataRootMigration({ ...request(), environment: { VYKOR_DATA_DIR: "relative-data" }, legacy: { documentsDir: "relative-documents", userDataDir: "relative-profile" } });
  expect(preview.blockers.map(item => item.code)).toContain("invalid_path");
  expect(preview.entries).toEqual([]);
});

it("does not duplicate a channel tree named through an explicit junction alias", async () => {
  const docs = join(base, "documents"), channels = join(docs, "Vykor", "channels"), alias = join(base, "channel-alias");
  file(join(channels, "a.txt")); symlinkSync(channels, alias, "junction");
  const preview = await inspectDataRootMigration({ ...request(), environment: { VYKOR_CHANNELS_DIR: alias }, legacy: { documentsDir: docs } });
  expect(preview.blockers).toEqual([]);
  expect(preview.entries.filter(item => item.source.endsWith("a.txt"))).toHaveLength(1);
});

it.runIf(process.platform !== "win32")("preserves case-sensitive source files and reports a collision when two sources map to one target", async () => {
  file(join(sourceRoot, "A.txt"), "one"); file(join(sourceRoot, "a.txt"), "two");
  const preview = await inspectDataRootMigration(request());
  expect(preview.blockers).toEqual([]);
  expect(preview.entries.filter(item => item.kind === "file")).toHaveLength(2);
});

it.runIf(process.platform === "win32")("blocks case-only collisions from independent sources", async () => {
  file(join(sourceRoot, "output_styles", "STYLE.md"), "one"); file(join(home, ".vykor", "output_styles", "style.md"), "one");
  expect((await inspectDataRootMigration(request())).blockers.map(item => item.code)).toContain("case_collision");
});

it("preserves the referent of an external relative symlink when moving to another parent", async () => {
  if (process.platform === "win32") return; // Windows junctions store absolute targets; covered above.
  const outside = join(home, "external"); file(join(outside, "keep.txt"));
  symlinkSync("../external", join(sourceRoot, "link"));
  const preview = await inspectDataRootMigration({ ...request(), targetRoot: join(base, "different", "root") });
  const link = preview.links.find(item => item.path.endsWith("link"))!;
  expect(resolve(dirname(join(base, "different", "root", "link")), link.target)).toBe(outside);
});
