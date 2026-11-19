import { dirname, join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { StorageContext } from "../database/storage-context.js";
import { notes, noteFileIndex } from "../session-runtime/schema.js";
import type { NoteIndex } from "./note-index.js";
import { NoteRepository } from "./note-repository.js";

/** Compatibility access for the historical session index and embedded rows. */
export function openLegacyNoteRepository(storage: StorageContext): NoteRepository {
  const database = storage.database.orm;
  const index: NoteIndex = {
    atomic: work => storage.atomic(() => {
      storage.assertWritable();
      database.run(sql`UPDATE note_file_index SET revision = revision WHERE 0`);
      return work();
    }),
    deferUntilRollback: work => storage.coordinator?.deferUntilRollback(work),
    deferUntilCommit: work => {
      if (storage.coordinator) storage.coordinator.deferUntilCommit(work);
      else work();
    },
    get: id => database.select().from(noteFileIndex).where(eq(noteFileIndex.id, id)).get(),
    entries: () => {
      const exists = database.get(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='note_file_index'`);
      return exists ? database.select().from(noteFileIndex).all() : [];
    },
    save: entry => {
      const { id, ...metadata } = entry;
      database.insert(noteFileIndex).values(entry).onConflictDoUpdate({ target: noteFileIndex.id, set: metadata }).run();
    },
  };
  return new NoteRepository(join(dirname(storage.database.path), "notes"), index, () =>
    database.select().from(notes).all().map(({ properties, ...note }) => ({ ...note, deletedAt: properties?.deletedAt ?? null })),
  );
}
