import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hasDesktopNotesImportReceipt, importLegacyNotes, NoteOrganizationReadOnlyError, NoteRevisionConflictError, openDesktopNoteRepository, validateDesktopNotes } from "../index.js";

let root: string, source: string, databasePath: string, notesDirectory: string, destination: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "desktop-notes-"));
  source = join(root, "old");
  databasePath = join(source, "sessions.db");
  notesDirectory = join(source, "notes");
  destination = join(root, "desktop", "notes");
  mkdirSync(source);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function legacyDatabase(path = databasePath): Database.Database {
  const db = new Database(path);
  db.exec(`CREATE TABLE note(id TEXT PRIMARY KEY, content TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER, properties TEXT);
    CREATE TABLE note_file_index(id TEXT PRIMARY KEY, revision INTEGER, created_at INTEGER, updated_at INTEGER, sha256 TEXT, deleted_at INTEGER);
    CREATE TABLE note_attachment(id TEXT PRIMARY KEY, original TEXT);
    INSERT INTO note_attachment VALUES('old-attachment', 'historical only');`);
  return db;
}

const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const migrate = (options?: Parameters<typeof importLegacyNotes>[1]) => importLegacyNotes({ databasePath, destination }, options);

it("creates and reopens an offline index and preserves external edits and conditional organization", async () => {
  const active = openDesktopNoteRepository(destination);
  const backup = join(root, "backup");
  try {
    active.repository.create({ content: "first" }, { id: "idea", now: 13 });
    active.repository.create({ content: "other" }, { id: "other", now: 14 });
    const initial = active.repository.organization();
    await active.repository.saveOrganization({ ...initial.organization, desktop: [...initial.organization.desktop].reverse() }, initial.etag);
    writeFileSync(join(destination, "idea.md"), "external change");
    expect(() => active.repository.update("idea", { content: "stale", expectedRevision: 1 })).toThrow(NoteRevisionConflictError);
    expect(active.repository.update("idea", { content: "updated", expectedRevision: 2 }, 25)).toMatchObject({ revision: 3, createdAt: 13, updatedAt: 25 });
    expect(active.repository.remove("other")).toBe(true);
    await active.backupTo(backup);
    validateDesktopNotes(backup);
    expect(hasDesktopNotesImportReceipt(backup)).toBe(true);
  } finally { active.close(); }
  const reopened = openDesktopNoteRepository(backup);
  try {
    expect(reopened.repository.list()).toEqual([{ id: "idea", content: "updated", revision: 3, createdAt: 13, updatedAt: 25 }]);
    expect(() => reopened.repository.create({ content: "resurrect" }, { id: "other" })).toThrow("already exists");
  } finally { reopened.close(); }
});

it("imports committed WAL rows, indexed Markdown, old embedded bodies and tombstones without touching source bytes", async () => {
  mkdirSync(notesDirectory);
  const db = legacyDatabase();
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.prepare("INSERT INTO note VALUES(?,?,?,?,?,?)").run("embedded", "in WAL", 4, 10, 20, null);
    db.prepare("INSERT INTO note VALUES(?,?,?,?,?,?)").run("removed", "deleted embedded content", 3, 9, 18, '{"deletedAt":33}');
    db.prepare("INSERT INTO note_file_index VALUES(?,?,?,?,?,?)").run("file", 5, 1, 2, hash("old"), null);
    db.prepare("INSERT INTO note_file_index VALUES(?,?,?,?,?,?)").run("tombstone", 7, 1, 2, hash("deleted"), 31);
    writeFileSync(join(notesDirectory, "file.md"), "new external body\r\n");
    writeFileSync(join(notesDirectory, "fresh.md"), "created by user externally");
    const futureOrganization = '{"version":99,"futureData":true}\n';
    writeFileSync(join(notesDirectory, "organization.json"), futureOrganization);
    const originals = [databasePath, `${databasePath}-wal`, join(notesDirectory, "file.md"), join(notesDirectory, "fresh.md"), join(notesDirectory, "organization.json")];
    const contents = originals.map(path => readFileSync(path));

    expect(await migrate()).toEqual({ status: "migrated" });
    expect(originals.map(path => readFileSync(path))).toEqual(contents);
    expect(readdirSync(destination, { withFileTypes: true }).filter(entry => !entry.isFile())).toEqual([]);
    expect(hasDesktopNotesImportReceipt(destination)).toBe(true);
    expect(readFileSync(join(destination, "organization.json"), "utf8")).toBe(futureOrganization);
    validateDesktopNotes(destination);

    const local = openDesktopNoteRepository(destination);
    try {
      expect(local.repository.get("embedded")).toEqual({ id: "embedded", content: "in WAL", revision: 4, createdAt: 10, updatedAt: 20 });
      expect(local.repository.get("file")).toMatchObject({ content: "new external body\r\n", revision: 6, createdAt: 1 });
      expect(local.repository.get("fresh")).toMatchObject({ content: "created by user externally", revision: 1 });
      expect(local.repository.get("removed")).toBeUndefined();
      expect(local.repository.get("tombstone")).toBeUndefined();
      const organization = local.repository.organization();
      expect(organization.readOnly).toBe(true);
      await expect(local.repository.saveOrganization(organization.organization, organization.etag)).rejects.toBeInstanceOf(NoteOrganizationReadOnlyError);
      local.repository.remove("embedded");
      local.repository.update("file", { content: "local edit", expectedRevision: 6 });
    } finally { local.close(); }
    const receipt = readFileSync(join(destination, "import-receipt.json"));
    expect(await migrate()).toEqual({ status: "already_migrated" });
    expect(readFileSync(join(destination, "import-receipt.json"))).toEqual(receipt);
    expect(existsSync(join(destination, "embedded.md"))).toBe(false);
    expect(readFileSync(join(destination, "file.md"), "utf8")).toBe("local edit");
  } finally { db.close(); }
});

it("repairs a damaged organization in staging while preserving its old bytes and the root source", async () => {
  mkdirSync(notesDirectory);
  writeFileSync(join(notesDirectory, "local.md"), "file only");
  writeFileSync(join(notesDirectory, "organization.json"), "broken organization");
  expect(await migrate()).toEqual({ status: "migrated" });
  const damageCopy = readdirSync(destination).find(name => name.startsWith("organization.corrupt-"));
  expect(damageCopy).toBeDefined();
  expect(readFileSync(join(destination, damageCopy!), "utf8")).toBe("broken organization");
  expect(readFileSync(join(notesDirectory, "organization.json"), "utf8")).toBe("broken organization");
  validateDesktopNotes(destination);
});

it("imports an embedded note database that predates organization metadata", async () => {
  const db = new Database(databasePath);
  try {
    db.exec(`CREATE TABLE note(id TEXT PRIMARY KEY, content TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER);
      INSERT INTO note VALUES('early', 'embedded body', 5, 10, 20);`);
  } finally { db.close(); }
  expect(await migrate()).toEqual({ status: "migrated" });
  const local = openDesktopNoteRepository(destination);
  try { expect(local.repository.get("early")).toEqual({ id: "early", content: "embedded body", revision: 5, createdAt: 10, updatedAt: 20 }); }
  finally { local.close(); }
});

it("keeps the previous organization snapshot when staging reconciles missing members", async () => {
  mkdirSync(notesDirectory);
  writeFileSync(join(notesDirectory, "fresh.md"), "file only");
  writeFileSync(join(notesDirectory, "organization.json"), '{"version":1,"desktop":[],"folders":{},"folderItems":{}}\n');
  const previous = '{"version":1,"desktop":[{"type":"note","id":"removed"}],"folders":{},"folderItems":{}}\n';
  writeFileSync(join(notesDirectory, "organization.previous.json"), previous);
  expect(await migrate()).toEqual({ status: "migrated" });
  expect(readFileSync(join(destination, "organization.previous.json"), "utf8")).toBe(previous);
  validateDesktopNotes(destination);
});

it("cleans interrupted stages and lets retry use a publication that already completed", async () => {
  mkdirSync(notesDirectory);
  writeFileSync(join(notesDirectory, "original.md"), "old");
  await expect(migrate({ beforeValidate: staged => unlinkSync(join(staged, "original.md")) })).rejects.toThrow(/incomplete|corrupt/i);
  expect(existsSync(destination)).toBe(false);
  await expect(migrate({ beforePublish: () => { throw new Error("stop before publish"); } })).rejects.toThrow("stop before publish");
  expect(existsSync(destination)).toBe(false);
  expect(readdirSync(join(root, "desktop"))).toEqual([]);
  await expect(migrate({ afterPublish: () => { throw new Error("exit after publish"); } })).rejects.toThrow("exit after publish");
  expect(await migrate()).toEqual({ status: "already_migrated" });
  expect(readFileSync(join(notesDirectory, "original.md"), "utf8")).toBe("old");
  expect(readFileSync(join(destination, "original.md"), "utf8")).toBe("old");
});

it("keeps the source untouched when the owner lease is lost before publish", async () => {
  mkdirSync(notesDirectory);
  writeFileSync(join(notesDirectory, "original.md"), "old");
  const owner = new AbortController();
  await expect(migrate({ signal: owner.signal, beforePublish: () => owner.abort(new Error("lost owner lease")) })).rejects.toThrow("lost owner lease");
  expect(existsSync(destination)).toBe(false);
  expect(readdirSync(join(root, "desktop"))).toEqual([]);
  expect(readFileSync(join(notesDirectory, "original.md"), "utf8")).toBe("old");
});

it("refuses to publish a stage containing unexpected files", async () => {
  await expect(migrate({ beforePublish: staged => mkdirSync(join(staged, "unexpected-copy")) })).rejects.toThrow(/stage contains an unexpected item/);
  expect(existsSync(destination)).toBe(false);
  expect(readdirSync(join(root, "desktop"))).toEqual([]);
});

it("serializes competing publication and reports incompatible independent notes", async () => {
  mkdirSync(notesDirectory);
  writeFileSync(join(notesDirectory, "legacy.md"), "old");
  const concurrent = await migrate({ beforePublish: async () => {
    expect(await migrate()).toEqual({ status: "migrated" });
  } });
  expect(concurrent).toEqual({ status: "already_migrated" });
  const index = readFileSync(join(destination, "notes.sqlite"));
  writeFileSync(join(notesDirectory, "legacy.md"), "different source");
  await expect(migrate()).rejects.toThrow(/conflict/i);
  expect(readFileSync(join(destination, "notes.sqlite"))).toEqual(index);

  const independent = join(root, "independent");
  const local = openDesktopNoteRepository(independent);
  try { local.repository.create({ content: "independent" }, { id: "kept" }); } finally { local.close(); }
  await expect(importLegacyNotes({ databasePath, destination: independent })).rejects.toThrow(/conflict/i);
  expect(readFileSync(join(independent, "kept.md"), "utf8")).toBe("independent");
});

it("publishes empty first use, fails closed on an unreadable source, and validates without creating a target", async () => {
  expect(() => validateDesktopNotes(destination)).toThrow();
  expect(existsSync(destination)).toBe(false);
  writeFileSync(databasePath, "not a database");
  await expect(migrate()).rejects.toThrow();
  expect(existsSync(destination)).toBe(false);
  unlinkSync(databasePath);
  expect(await migrate()).toEqual({ status: "empty" });
  expect(hasDesktopNotesImportReceipt(destination)).toBe(true);
  validateDesktopNotes(destination);
});
