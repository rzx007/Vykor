import {
  chmodSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore, mergeNotes } from "@vykor/services";
import { describe, expect, it, vi } from "vitest";

import {
  createApplicationBackup,
  restoreApplicationBackup,
  verifyApplicationBackup,
} from "../application-backup.js";

function checksumFiles(backup: string, files: string[]) {
  return Object.fromEntries(files.map(name => [name, createHash("sha256").update(readFileSync(join(backup, name))).digest("hex")]));
}

async function createVersionThreeFixture(store: SessionStore, backup: string) {
  const notes = join(backup, "notes");
  store.openLegacyNotes().backupTo(notes);
  await store.backupDatabase(join(backup, "database.sqlite"));
  writeFileSync(join(backup, "manifest.json"), JSON.stringify({
    version: 3, backupId: "legacy-markdown", createdAt: 1, database: "database.sqlite",
    directories: { notes: true, artifacts: false, memory: false, "execution-output": false, attachments: false },
    recovery: { reviveLiveProcesses: false, closeActiveRecordsOnStartup: true },
  }));
  const files = ["database.sqlite", "manifest.json", ...readdirSync(notes).map(name => `notes/${name}`)];
  writeFileSync(join(backup, "checksums.json"), JSON.stringify(checksumFiles(backup, files)));
  return files;
}

describe("application backup notes", () => {
  it("excludes notes from version 4 while preserving the live database and historical schema", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-daemon-backup-"));
    const source = new SessionStore({
      path: join(directory, "source", "sessions.db"),
    });
    let restored: SessionStore | undefined;
    try {
      const body = "historical-note-text-7a34d1";
      const attachment = Buffer.from("historical-note-attachment-977d4c");
      const connection = Reflect.get(source, "storage").database.connection;
      connection.prepare("INSERT INTO note(id,content,revision,created_at,updated_at) VALUES(?,?,?,?,?)").run("a", body, 3, 10, 20);
      connection.prepare("INSERT INTO note_attachment(id,note_id,name,media_type,size_bytes,created_at,data) VALUES(?,?,?,?,?,?,?)")
        .run("old-attachment", "a", "old.bin", "application/octet-stream", attachment.length, 10, attachment);
      const legacyNotes = source.openLegacyNotes();
      expect(legacyNotes.get("a")?.content).toBe(body);
      const file = join(legacyNotes.directory, "a.md");
      writeFileSync(file, "edited outside daemon");
      const openLegacyNotes = vi.spyOn(source, "openLegacyNotes");
      source.sessions.create({ id: "saved-session", cwd: directory, model: "test" });
      const backup = join(directory, "backup");
      const manifest = await createApplicationBackup({ store: source, destination: backup });
      expect(manifest).toMatchObject({ version: 4, scope: "daemon-only" });
      expect(manifest.directories).not.toHaveProperty("notes");
      expect(existsSync(join(backup, "notes"))).toBe(false);
      expect(openLegacyNotes).not.toHaveBeenCalled();
      expect(readFileSync(file, "utf8")).toBe("edited outside daemon");
      expect(connection.prepare("SELECT content FROM note WHERE id='a'").get()).toEqual({ content: body });
      expect(connection.prepare("SELECT revision FROM note_file_index WHERE id='a'").get()).toEqual({ revision: 3 });
      expect(connection.prepare("SELECT data FROM note_attachment WHERE id='old-attachment'").get()).toEqual({ data: attachment });
      const database = readFileSync(join(backup, "database.sqlite"));
      expect(database.includes(Buffer.from(body))).toBe(false);
      expect(database.includes(attachment)).toBe(false);
      expect(verifyApplicationBackup(backup)).toEqual(manifest);
      const restoredPath = join(directory, "restored", "sessions.db");
      restoreApplicationBackup({ source: backup, storePath: restoredPath });
      expect(existsSync(join(directory, "restored", "notes"))).toBe(false);
      restored = new SessionStore({ path: restoredPath });
      expect(restored.sessions.get("saved-session")?.id).toBe("saved-session");
      const copied = Reflect.get(restored, "storage").database.connection;
      for (const table of ["note", "note_file_index", "note_attachment"]) {
        expect(copied.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      mkdirSync(join(backup, "notes"));
      expect(() => verifyApplicationBackup(backup)).toThrow(/notes/i);
    } finally {
      source.close();
      restored?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([1, 2])(
    "restores a version %i database-only backup without mixing existing notes",
    async (version) => {
      const directory = mkdtempSync(join(tmpdir(), "vk-old-note-backup-"));
      const backup = join(directory, "backup");
      mkdirSync(backup);
      const source = new SessionStore({
        path: join(directory, "source", "sessions.db"),
      });
      let restored: SessionStore | undefined;
      try {
        Reflect.get(source, "storage")
          .database.connection.prepare(
            "INSERT INTO note(id,content,revision,created_at,updated_at) VALUES(?,?,?,?,?)",
          )
          .run("legacy", "legacy idea", 3, 10, 20);
        const legacyConnection = Reflect.get(source, "storage").database.connection;
        legacyConnection.prepare("INSERT INTO note(id,content,revision,created_at,updated_at,properties) VALUES(?,?,?,?,?,?)")
          .run("deleted", "must stay deleted", 4, 10, 20, JSON.stringify({ deletedAt: 30 }));
        const attachment = Buffer.from("preserve original legacy attachment");
        legacyConnection.prepare("INSERT INTO note_attachment(id,note_id,name,media_type,size_bytes,created_at,data) VALUES(?,?,?,?,?,?,?)")
          .run("legacy-attachment", "legacy", "legacy.bin", "application/octet-stream", attachment.length, 20, attachment);
        // Reproduce the real pre-file-storage schema, not a current-schema DB
        // with an old manifest label. Delete every migration row from
        // 0006_note_file_index onward (when=1791186378776, per meta/_journal.json)
        // so restore re-runs 0006 and recreates the table. Deleting only the
        // newest row would leave 0006 recorded after later migrations were
        // added, so the table would never be recreated.
        // Remove the later tables still present in the current schema. 0010
        // already removed the 0009 tables; restore recreates and removes them
        // again while replaying those migrations.
        Reflect.get(source, "storage").database.connection.exec(
          `DROP TABLE tool_result;
           DROP TABLE session_plugin_app;
           DROP TABLE note_file_index;
           DELETE FROM __drizzle_migrations WHERE created_at >= 1791186378776;`,
        );
        await source.backupDatabase(join(backup, "database.sqlite"));
        writeFileSync(
          join(backup, "manifest.json"),
          JSON.stringify({
            version,
            database: "database.sqlite",
            backupId: "legacy",
            createdAt: 1,
            directories: {
              artifacts: false,
              memory: false,
              "execution-output": false,
              attachments: false,
            },
            recovery: {
              reviveLiveProcesses: false,
              closeActiveRecordsOnStartup: true,
            },
          }),
        );
        const hashes = Object.fromEntries(
          ["database.sqlite", "manifest.json"].map((name) => [
            name,
            createHash("sha256")
              .update(readFileSync(join(backup, name)))
              .digest("hex"),
          ]),
        );
        writeFileSync(join(backup, "checksums.json"), JSON.stringify(hashes));
        const originalDatabase = readFileSync(join(backup, "database.sqlite"));
        expect(verifyApplicationBackup(backup).version).toBe(version);
        const existingStore = join(directory, "existing.db");
        writeFileSync(existingStore, "occupied database");
        expect(() =>
          restoreApplicationBackup({
            source: backup,
            storePath: existingStore,
          }),
        ).toThrow("already exists");
        expect(readFileSync(join(backup, "database.sqlite"))).toEqual(
          originalDatabase,
        );
        const occupiedPath = join(directory, "occupied", "sessions.db");
        const occupiedNotes = join(directory, "occupied", "notes");
        mkdirSync(occupiedNotes, { recursive: true });
        writeFileSync(join(occupiedNotes, "legacy.md"), "occupied idea");
        expect(() =>
          restoreApplicationBackup({ source: backup, storePath: occupiedPath }),
        ).toThrow("not empty");
        expect(existsSync(occupiedPath)).toBe(false);
        expect(readFileSync(join(occupiedNotes, "legacy.md"), "utf8")).toBe(
          "occupied idea",
        );
        const path = join(directory, "restored", "sessions.db");
        restoreApplicationBackup({ source: backup, storePath: path });
        expect(readFileSync(join(backup, "database.sqlite"))).toEqual(
          originalDatabase,
        );
        restored = new SessionStore({ path });
        expect(Reflect.get(restored, "storage").database.connection.prepare("SELECT data FROM note_attachment WHERE id='legacy-attachment'").get())
          .toEqual({ data: attachment });
        expect(Reflect.get(restored, "storage").database.connection.prepare("SELECT properties FROM note WHERE id='deleted'").get())
          .toEqual({ properties: JSON.stringify({ deletedAt: 30 }) });
        expect(restored.openLegacyNotes().list()).toEqual([
          {
            id: "legacy",
            content: "legacy idea",
            revision: 3,
            createdAt: 10,
            updatedAt: 20,
          },
        ]);
        expect(
          readFileSync(
            join(directory, "restored", "notes", "legacy.md"),
            "utf8",
          ),
        ).toBe("legacy idea");
      } finally {
        source.close();
        restored?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("verifies a read-only historical backup and restores writable state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-read-only-backup-"));
    const source = new SessionStore({ path: join(directory, "source", "sessions.db") });
    const backup = join(directory, "backup");
    const db = join(backup, "database.sqlite");
    const note = join(backup, "notes", "readonly.md");
    try {
      source.openLegacyNotes().create({ content: "preserve bytes" }, { id: "readonly" });
      // Version 3 archives predate migration 0008. Verification must migrate
      // a writable copy before checking the Markdown index.
      Reflect.get(source, "storage").database.connection.exec(
        `DROP TABLE tool_result;
         DROP TABLE session_plugin_app;
         DELETE FROM __drizzle_migrations WHERE created_at >= 1792515110875;`,
      );
      await createVersionThreeFixture(source, backup);
      const originals = [readFileSync(db), readFileSync(note)];
      for (const path of [db, note]) chmodSync(path, 0o444);

      expect(verifyApplicationBackup(backup).version).toBe(3);
      const storePath = join(directory, "restored", "sessions.db");
      restoreApplicationBackup({ source: backup, storePath });
      const restoredNote = join(directory, "restored", "notes", "readonly.md");
      expect(readFileSync(restoredNote)).toEqual(originals[1]);
      for (const path of [storePath, restoredNote]) expect(statSync(path).mode & 0o200).toBe(0o200);
      for (const [index, path] of [db, note].entries()) {
        expect(readFileSync(path)).toEqual(originals[index]);
        expect(statSync(path).mode & 0o200).toBe(0);
      }
    } finally {
      source.close();
      for (const path of [db, note]) if (existsSync(path)) chmodSync(path, 0o600);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing notes directory during restore", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-note-restore-conflict-"));
    const source = new SessionStore({
      path: join(directory, "source", "sessions.db"),
    });
    try {
      source.openLegacyNotes().create({ content: "source idea" });
      const backup = join(directory, "backup");
      await createVersionThreeFixture(source, backup);
      const notes = join(directory, "restored", "notes");
      mkdirSync(notes, { recursive: true });
      writeFileSync(join(notes, "keep.md"), "keep this idea");
      expect(() =>
        restoreApplicationBackup({
          source: backup,
          storePath: join(directory, "restored", "sessions.db"),
        }),
      ).toThrow("not empty");
      expect(readFileSync(join(notes, "keep.md"), "utf8")).toBe(
        "keep this idea",
      );
    } finally {
      source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("backs up and restores global notes with their revisions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-note-backup-"));
    const sourcePath = join(directory, "source", "sessions.db");
    const backupPath = join(directory, "backup");
    const restoredPath = join(directory, "restored", "sessions.db");
    let source: SessionStore | undefined;
    let restored: SessionStore | undefined;
    try {
      source = new SessionStore({ path: sourcePath });
      const created = source.openLegacyNotes().create(
        { content: "before backup" },
        { id: "note", now: 10 },
      );
      source.openLegacyNotes().update(
        created.id,
        { content: "saved", expectedRevision: 1 },
        20,
      );
      source.openLegacyNotes().create(
        { content: "second idea" },
        { id: "second", now: 10 },
      );
      const first = source.openLegacyNotes().organization();
      const organization = mergeNotes(first.organization, {
        activeNoteId: "second",
        targetNoteId: "note",
        folderId: "f1",
        folderName: "备份分类",
        now: 20,
      });
      await source.openLegacyNotes().saveOrganization(organization, first.etag);
      const files = await createVersionThreeFixture(source, backupPath);
      const hashes = checksumFiles(backupPath, files);
      expect(verifyApplicationBackup(backupPath).version).toBe(3);
      expect(
        JSON.parse(
          readFileSync(join(backupPath, "notes", "organization.json"), "utf8"),
        ),
      ).toEqual(organization);
      expect(
        JSON.parse(
          readFileSync(
            join(backupPath, "notes", "organization.previous.json"),
            "utf8",
          ),
        ),
      ).toEqual(first.organization);
      expect(readFileSync(join(backupPath, "notes", "note.md"), "utf8")).toBe(
        "saved",
      );
      source.close();
      source = undefined;

      restoreApplicationBackup({ source: backupPath, storePath: restoredPath });
      expect(checksumFiles(backupPath, files)).toEqual(hashes);
      restored = new SessionStore({ path: restoredPath });
      expect(
        readFileSync(join(directory, "restored", "notes", "note.md"), "utf8"),
      ).toBe("saved");
      expect(restored.openLegacyNotes().organization().organization).toEqual(organization);
      expect(restored.openLegacyNotes().list()).toContainEqual({
        id: "note",
        content: "saved",
        revision: 2,
        createdAt: 10,
        updatedAt: 20,
      });
    } finally {
      source?.close();
      restored?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("rejects version 3 Markdown that disagrees with the stored index even if its portable checksum matches", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-note-index-backup-"));
    const source = new SessionStore({ path: join(directory, "source", "sessions.db") });
    try {
      source.openLegacyNotes().create({ content: "indexed content" }, { id: "a" });
      const backup = join(directory, "backup");
      const files = await createVersionThreeFixture(source, backup);
      writeFileSync(join(backup, "notes", "a.md"), "different content");
      const hashes = checksumFiles(backup, files);
      writeFileSync(join(backup, "checksums.json"), JSON.stringify(hashes));
      expect(() => verifyApplicationBackup(backup)).toThrow("Note backup is incomplete or corrupt: a");
      const target = join(directory, "restored", "sessions.db");
      expect(() => restoreApplicationBackup({ source: backup, storePath: target })).toThrow("Note backup is incomplete or corrupt: a");
      expect(existsSync(target)).toBe(false);
      expect(checksumFiles(backup, files)).toEqual(hashes);
    } finally {
      source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("restores older version 3 backups with no organization file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-old-v3-organization-"));
    const source = new SessionStore({
      path: join(directory, "source", "sessions.db"),
    });
    let restored: SessionStore | undefined;
    try {
      source.openLegacyNotes().create({ content: "idea" }, { id: "a" });
      const backup = join(directory, "backup");
      await createVersionThreeFixture(source, backup);
      unlinkSync(join(backup, "notes", "organization.json"));
      const checksums = JSON.parse(
        readFileSync(join(backup, "checksums.json"), "utf8"),
      );
      delete checksums["notes/organization.json"];
      writeFileSync(join(backup, "checksums.json"), JSON.stringify(checksums));
      const path = join(directory, "restored", "sessions.db");
      restoreApplicationBackup({ source: backup, storePath: path });
      expect(
        existsSync(join(directory, "restored", "notes", "organization.json")),
      ).toBe(false);
      restored = new SessionStore({ path });
      expect(restored.openLegacyNotes().organization().organization.desktop).toEqual([
        { type: "note", id: "a" },
      ]);
    } finally {
      source.close();
      restored?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("copies future organization bytes but rejects restore and verification as incompatible", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-future-organization-"));
    const source = new SessionStore({
      path: join(directory, "source", "sessions.db"),
    });
    try {
      source.openLegacyNotes().create({ content: "idea" }, { id: "a" });
      const future = '{"version":2,"unrecognized":"preserve"}\n';
      writeFileSync(join(source.openLegacyNotes().directory, "organization.json"), future);
      const backup = join(directory, "backup");
      await createVersionThreeFixture(source, backup);
      expect(
        readFileSync(join(backup, "notes", "organization.json"), "utf8"),
      ).toBe(future);
      expect(() => verifyApplicationBackup(backup)).toThrow("升级应用");
      const target = join(directory, "restored", "sessions.db");
      expect(() =>
        restoreApplicationBackup({ source: backup, storePath: target }),
      ).toThrow("升级应用");
      expect(existsSync(target)).toBe(false);
    } finally {
      source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
