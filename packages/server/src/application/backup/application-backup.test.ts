import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "@vykor/services";
import { describe, expect, it } from "vitest";

import {
  createApplicationBackup,
  restoreApplicationBackup,
} from "./application-backup.js";

describe("application backup notes", () => {
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
        // with an old manifest label.
        Reflect.get(source, "storage").database.connection.exec(
          "DROP TABLE note_file_index; DELETE FROM __drizzle_migrations WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations);",
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
      const manifest = await createApplicationBackup({
        store: source,
        destination: backupPath,
      });
      expect(manifest.version).toBe(3);
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
      expect(restored.notes.list()).toEqual([
        {
          id: "note",
          content: "saved",
          revision: 2,
          createdAt: 10,
          updatedAt: 20,
        },
      ]);
    } finally {
      source?.close();
      restored?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
