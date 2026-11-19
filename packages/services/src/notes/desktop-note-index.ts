import { lstatSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { NoteIndex, NoteIndexEntry } from "./note-index.js";

const indexFile = "notes.sqlite";
const indexVersion = 1;
const columns = "id, revision, created_at AS createdAt, updated_at AS updatedAt, sha256, deleted_at AS deletedAt";

export function desktopNoteIndexPath(directory: string): string {
  const path = join(directory, indexFile);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("Desktop notes index must be a regular file");
  return path;
}

export class DesktopNoteIndex implements NoteIndex {
  private readonly database: Database.Database;
  private readonly readOne;
  private readonly readAll;
  private readonly write;
  private rollback: Array<() => void> | undefined;

  constructor(directory: string, readOnly = false) {
    const path = desktopNoteIndexPath(directory);
    const exists = !!lstatSync(path, { throwIfNoEntry: false });
    const database = new Database(path, { readonly: readOnly, fileMustExist: readOnly || exists });
    try {
      if (!exists && !readOnly) database.transaction(() => {
        database.exec(`CREATE TABLE IF NOT EXISTS note_file_index (
          id TEXT PRIMARY KEY NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          sha256 TEXT NOT NULL,
          deleted_at REAL
        ); PRAGMA user_version=${indexVersion};`);
      }).immediate();
      if (database.pragma("user_version", { simple: true }) !== indexVersion)
        throw new Error("Unsupported Desktop notes index version");
      this.readOne = database.prepare<[string], NoteIndexEntry>(`SELECT ${columns} FROM note_file_index WHERE id = ?`);
      this.readAll = database.prepare<[], NoteIndexEntry>(`SELECT ${columns} FROM note_file_index ORDER BY id`);
      this.write = database.prepare<NoteIndexEntry>(`INSERT INTO note_file_index (id, revision, created_at, updated_at, sha256, deleted_at)
        VALUES (@id, @revision, @createdAt, @updatedAt, @sha256, @deletedAt)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, created_at = excluded.created_at,
          updated_at = excluded.updated_at, sha256 = excluded.sha256, deleted_at = excluded.deleted_at`);
      this.database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  atomic<T>(work: () => T): T {
    const callbacks: Array<() => void> = [];
    this.rollback = callbacks;
    try {
      return this.database.transaction(work).immediate();
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const restore of callbacks.reverse()) {
        try { restore(); } catch (failure) { rollbackErrors.push(failure); }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Desktop note operation and rollback failed");
      throw error;
    } finally {
      this.rollback = undefined;
    }
  }

  deferUntilRollback(work: () => void): void { this.rollback!.push(work); }
  deferUntilCommit(work: () => void): void { work(); }
  get(id: string): NoteIndexEntry | undefined { return this.readOne.get(id); }
  entries(): NoteIndexEntry[] { return this.readAll.all(); }
  save(entry: NoteIndexEntry): void { this.write.run(entry); }

  verify(): void {
    if (this.database.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error("Desktop notes index is corrupt");
  }

  copyTo(path: string): void { this.database.prepare("VACUUM INTO ?").run(path); }

  close(): void { if (this.database.open) this.database.close(); }
}
