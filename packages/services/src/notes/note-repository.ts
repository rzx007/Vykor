import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type {
  CreateNoteInput,
  NoteRecord,
  UpdateNoteInput,
} from "@vykor/protocol";
import { parseCreateNoteInput, parseUpdateNoteInput } from "@vykor/protocol";
import type { StorageContext } from "../database/storage-context.js";
import { notes, noteFileIndex } from "../session-runtime/schema.js";
import {
  ensureNoteDirectory,
  noteFilePath,
  readNoteFile,
  replaceNoteFile,
} from "./markdown-note-files.js";

export class NoteRevisionConflictError extends Error {
  constructor(
    readonly noteId: string,
    readonly expectedRevision: number,
  ) {
    super(`Note revision conflict: ${noteId} expected ${expectedRevision}`);
    this.name = "NoteRevisionConflictError";
  }
}

type Entry = typeof noteFileIndex.$inferSelect;
const digest = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

export class NoteRepository {
  readonly directory: string;
  private initialized = false;
  constructor(private readonly storage: StorageContext) {
    this.directory = join(dirname(storage.database.path), "notes");
  }
  private get database() {
    return this.storage.database.orm;
  }
  private lockWriter(): void {
    // Take SQLite's existing writer lock before touching Markdown files.
    this.database.run(
      sql`UPDATE note_file_index SET revision = revision WHERE 0`,
    );
  }
  private read<T>(work: () => T): T {
    try {
      return this.storage.atomic(() => {
        this.storage.coordinator?.deferUntilRollback(() => {
          this.initialized = false;
        });
        this.storage.assertWritable();
        this.lockWriter();
        this.initialize();
        return work();
      });
    } catch (error) {
      this.initialized = false;
      throw error;
    }
  }

  private writeFile(path: string, content: string): void {
    const before = readNoteFile(path);
    replaceNoteFile(path, content);
    this.storage.coordinator?.deferUntilRollback(() => {
      if (readNoteFile(path)?.content !== content) return;
      if (before) replaceNoteFile(path, before.content);
      else unlinkSync(path);
    });
  }

  private initialize(): void {
    ensureNoteDirectory(this.directory);
    if (this.initialized) return;
    for (const legacy of this.database.select().from(notes).all()) {
      noteFilePath(this.directory, legacy.id);
      if (this.entry(legacy.id)) continue;
      const deletedAt = legacy.properties?.deletedAt ?? null;
      const path = noteFilePath(this.directory, legacy.id);
      const existing = readNoteFile(path);
      if (deletedAt === null && !existing) this.writeFile(path, legacy.content);
      const content = existing?.content ?? legacy.content;
      this.database
        .insert(noteFileIndex)
        .values({
          id: legacy.id,
          revision: legacy.revision + (content === legacy.content ? 0 : 1),
          createdAt: legacy.createdAt,
          updatedAt:
            content === legacy.content
              ? legacy.updatedAt
              : existing!.modifiedAt,
          sha256: digest(content),
          deletedAt,
        })
        .run();
    }
    this.initialized = true;
  }

  private entry(id: string): Entry | undefined {
    return this.database
      .select()
      .from(noteFileIndex)
      .where(eq(noteFileIndex.id, id))
      .get();
  }

  private readAndSync(id: string): NoteRecord | undefined {
    const file = readNoteFile(noteFilePath(this.directory, id));
    let entry = this.entry(id);
    if (!file) {
      if (entry && entry.deletedAt === null)
        this.database
          .update(noteFileIndex)
          .set({ deletedAt: Date.now() })
          .where(eq(noteFileIndex.id, id))
          .run();
      return undefined;
    }
    const hash = digest(file.content);
    if (!entry) {
      entry = {
        id,
        revision: 1,
        createdAt: file.createdAt,
        updatedAt: file.modifiedAt,
        sha256: hash,
        deletedAt: null,
      };
      this.database.insert(noteFileIndex).values(entry).run();
    } else if (entry.sha256 !== hash || entry.deletedAt !== null) {
      entry = {
        ...entry,
        sha256: hash,
        revision: entry.revision + 1,
        updatedAt: file.modifiedAt,
        deletedAt: null,
      };
      this.database
        .update(noteFileIndex)
        .set(entry)
        .where(eq(noteFileIndex.id, id))
        .run();
    }
    return {
      id,
      content: file.content,
      revision: entry.revision,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  get(id: string): NoteRecord | undefined {
    return this.read(() => this.readAndSync(id));
  }

  list(): NoteRecord[] {
    return this.read(() => {
      const result: NoteRecord[] = [];
      for (const name of readdirSync(this.directory)) {
        if (!name.endsWith(".md")) continue;
        const id = name.slice(0, -3);
        const record = this.readAndSync(id);
        if (record) result.push(record);
      }
      for (const entry of this.database.select().from(noteFileIndex).all()) {
        if (
          entry.deletedAt === null &&
          !result.some((record) => record.id === entry.id)
        )
          this.database
            .update(noteFileIndex)
            .set({ deletedAt: Date.now() })
            .where(eq(noteFileIndex.id, entry.id))
            .run();
      }
      return result.sort(
        (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
      );
    });
  }

  create(
    input: CreateNoteInput,
    options: { id?: string; now?: number } = {},
  ): NoteRecord {
    parseCreateNoteInput(input);
    const id = options.id ?? randomUUID();
    const path = noteFilePath(this.directory, id);
    return this.read(() => {
      if (this.entry(id) || readNoteFile(path))
        throw new Error(`Note already exists: ${id}`);
      const now = options.now ?? Date.now();
      this.writeFile(path, input.content);
      this.database
        .insert(noteFileIndex)
        .values({
          id,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          sha256: digest(input.content),
          deletedAt: null,
        })
        .run();
      return {
        id,
        content: input.content,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  update(id: string, input: UpdateNoteInput, now = Date.now()): NoteRecord {
    parseUpdateNoteInput(input);
    const before = this.get(id);
    if (!before) throw new Error(`Note not found: ${id}`);
    if (before.revision !== input.expectedRevision)
      throw new NoteRevisionConflictError(id, input.expectedRevision);
    const path = noteFilePath(this.directory, id);
    return this.read(() => {
      const latest = this.readAndSync(id);
      if (!latest) throw new Error(`Note not found: ${id}`);
      if (latest.revision !== input.expectedRevision)
        throw new NoteRevisionConflictError(id, input.expectedRevision);
      this.writeFile(path, input.content);
      const revision = input.expectedRevision + 1;
      this.database
        .update(noteFileIndex)
        .set({ revision, updatedAt: now, sha256: digest(input.content) })
        .where(eq(noteFileIndex.id, id))
        .run();
      return {
        id,
        content: input.content,
        revision,
        createdAt: before.createdAt,
        updatedAt: now,
      };
    });
  }

  remove(id: string): boolean {
    const before = this.get(id);
    if (!before) return false;
    const path = noteFilePath(this.directory, id);
    return this.read(() => {
      unlinkSync(path);
      this.storage.coordinator?.deferUntilRollback(() => {
        if (!readNoteFile(path)) replaceNoteFile(path, before.content);
      });
      this.database
        .update(noteFileIndex)
        .set({ deletedAt: Date.now() })
        .where(eq(noteFileIndex.id, id))
        .run();
      return true;
    });
  }

  storageInfo(): { directory: string; format: "markdown" } {
    this.list();
    return { directory: this.directory, format: "markdown" };
  }

  backupTo(destination: string): void {
    this.list();
    ensureNoteDirectory(destination);
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".md")) continue;
      const path = noteFilePath(this.directory, name.slice(0, -3));
      readNoteFile(path);
      copyFileSync(path, join(destination, name));
    }
  }

  copyLegacyFilesTo(destination: string): void {
    ensureNoteDirectory(destination);
    for (const legacy of this.database.select().from(notes).all()) {
      if (legacy.properties?.deletedAt != null || this.entry(legacy.id))
        continue;
      const path = noteFilePath(destination, legacy.id);
      if (!readNoteFile(path)) replaceNoteFile(path, legacy.content);
    }
  }

  validateFiles(directory = this.directory): void {
    ensureNoteDirectory(directory);
    for (const entry of this.database.select().from(noteFileIndex).all()) {
      if (entry.deletedAt !== null) continue;
      const file = readNoteFile(noteFilePath(directory, entry.id));
      if (!file || digest(file.content) !== entry.sha256)
        throw new Error(`Note backup is incomplete or corrupt: ${entry.id}`);
    }
  }
}
