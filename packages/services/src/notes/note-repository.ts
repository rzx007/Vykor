import { randomUUID } from "node:crypto";

import type {
  CreateNoteInput,
  NoteRecord,
  UpdateNoteInput,
} from "@vykor/protocol";
import { and, desc, eq } from "drizzle-orm";

import type { StorageContext } from "../database/storage-context.js";
import { notes } from "../session-runtime/schema.js";

export class NoteRevisionConflictError extends Error {
  constructor(
    readonly noteId: string,
    readonly expectedRevision: number,
  ) {
    super(`Note revision conflict: ${noteId} expected ${expectedRevision}`);
    this.name = "NoteRevisionConflictError";
  }
}

export class NoteRepository {
  constructor(private readonly storage: StorageContext) {}

  private get database() {
    return this.storage.database.orm;
  }

  create(
    input: CreateNoteInput,
    options: { id?: string; now?: number } = {},
  ): NoteRecord {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      const id = options.id ?? randomUUID();
      const now = options.now ?? Date.now();
      this.database
        .insert(notes)
        .values({
          id,
          content: input.content,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return this.get(id)!;
    });
  }

  get(id: string): NoteRecord | undefined {
    const row = this.database
      .select()
      .from(notes)
      .where(eq(notes.id, id))
      .get();
    return row ? noteFromRow(row) : undefined;
  }

  list(): NoteRecord[] {
    return this.database
      .select()
      .from(notes)
      .orderBy(desc(notes.updatedAt), desc(notes.createdAt))
      .all()
      .map(noteFromRow);
  }

  update(id: string, input: UpdateNoteInput, now = Date.now()): NoteRecord {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      const result = this.database
        .update(notes)
        .set({
          content: input.content,
          revision: input.expectedRevision + 1,
          updatedAt: now,
        })
        .where(
          and(eq(notes.id, id), eq(notes.revision, input.expectedRevision)),
        )
        .run();
      if (result.changes === 0) {
        if (!this.get(id)) throw new Error(`Note not found: ${id}`);
        throw new NoteRevisionConflictError(id, input.expectedRevision);
      }
      return this.get(id)!;
    });
  }

  remove(id: string): boolean {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      return (
        this.database.delete(notes).where(eq(notes.id, id)).run().changes > 0
      );
    });
  }
}

function noteFromRow(row: typeof notes.$inferSelect): NoteRecord {
  return {
    id: row.id,
    content: row.content,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
