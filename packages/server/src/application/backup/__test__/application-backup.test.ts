import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
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

describe("application backup notes", () => {
  it("aligns backup hashes and revisions with external edits before and during database copying", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-external-note-backup-"));
    const source = new SessionStore({
      path: join(directory, "source", "sessions.db"),
    });
    let restored: SessionStore | undefined;
    try {
      source.notes.create({ content: "original" }, { id: "a" });
      const file = join(source.notes.directory, "a.md");
      writeFileSync(file, "edited before backup");
      const copyDatabase = source.backupDatabase.bind(source);
      const backupDatabase = vi
        .spyOn(source, "backupDatabase")
        .mockImplementation(async (destination) => {
          const result = await copyDatabase(destination);
          writeFileSync(file, "edited while database was copied");
          return result;
        });
      const backup = join(directory, "backup");
      try {
        await createApplicationBackup({ store: source, destination: backup });
      } finally {
        backupDatabase.mockRestore();
      }
      expect(() => verifyApplicationBackup(backup)).not.toThrow();
      const restoredPath = join(directory, "restored", "sessions.db");
      restoreApplicationBackup({ source: backup, storePath: restoredPath });
      restored = new SessionStore({ path: restoredPath });
      expect(() => restored!.notes.validateFiles()).not.toThrow();
      expect(restored.notes.get("a")).toMatchObject({
        content: "edited while database was copied",
        revision: 3,
      });
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
        expect(restored.notes.list()).toEqual([
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

  it("does not overwrite an existing notes directory during restore", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-note-restore-conflict-"));
    const source = new SessionStore({
      path: join(directory, "source", "sessions.db"),
    });
    try {
      source.notes.create({ content: "source idea" });
      const backup = join(directory, "backup");
      await createApplicationBackup({ store: source, destination: backup });
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
      const created = source.notes.create(
        { content: "before backup" },
        { id: "note", now: 10 },
      );
      source.notes.update(
        created.id,
        { content: "saved", expectedRevision: 1 },
        20,
      );
      source.notes.create(
        { content: "second idea" },
        { id: "second", now: 10 },
      );
      const first = source.notes.organization();
      const organization = mergeNotes(first.organization, {
        activeNoteId: "second",
        targetNoteId: "note",
        folderId: "f1",
        folderName: "备份分类",
        now: 20,
      });
      await source.notes.saveOrganization(organization, first.etag);
      const manifest = await createApplicationBackup({
        store: source,
        destination: backupPath,
      });
      expect(manifest.version).toBe(3);
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
      restored = new SessionStore({ path: restoredPath });
      expect(
        readFileSync(join(directory, "restored", "notes", "note.md"), "utf8"),
      ).toBe("saved");
      expect(restored.notes.organization().organization).toEqual(organization);
      expect(restored.notes.list()).toContainEqual({
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
  it("restores older version 3 backups with no organization file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-old-v3-organization-"));
    const source = new SessionStore({
      path: join(directory, "source", "sessions.db"),
    });
    let restored: SessionStore | undefined;
    try {
      source.notes.create({ content: "idea" }, { id: "a" });
      const backup = join(directory, "backup");
      await createApplicationBackup({ store: source, destination: backup });
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
      expect(restored.notes.organization().organization.desktop).toEqual([
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
      source.notes.create({ content: "idea" }, { id: "a" });
      const future = '{"version":2,"unrecognized":"preserve"}\n';
      writeFileSync(join(source.notes.directory, "organization.json"), future);
      const backup = join(directory, "backup");
      await createApplicationBackup({ store: source, destination: backup });
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
