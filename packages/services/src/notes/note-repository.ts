import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CreateNoteInput, UpdateNoteInput } from "./commands.js";
import type {
  NoteRecord,
  NoteOrganizationV1Record,
  NoteOrganizationSnapshotRecord,
} from "@vykor/domain-contracts/notes";
import {
  parseCreateNoteInput,
  parseUpdateNoteInput,
} from "@vykor/domain-contracts/notes";
import type { EmbeddedNote, NoteIndex } from "./note-index.js";
import {
  ensureNoteDirectory,
  noteFilePath,
  readNoteFile,
  scanNoteIds,
  replaceNoteFile,
  readUtf8File,
  replaceUtf8File,
} from "./markdown-note-files.js";
import {
  NoteOrganizationRepository,
  validateNoteOrganizationFiles,
} from "./note-organization-repository.js";

export class NoteRevisionConflictError extends Error {
  constructor(
    readonly noteId: string,
    readonly expectedRevision: number,
  ) {
    super(`Note revision conflict: ${noteId} expected ${expectedRevision}`);
    this.name = "NoteRevisionConflictError";
  }
}

export const noteContentDigest = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

export class NoteRepository {
  private initialized = false;
  private readonly organizationRepository: NoteOrganizationRepository;
  private organizationWarning: string | undefined;
  constructor(
    readonly directory: string,
    private readonly index: NoteIndex,
    private readonly embeddedNotes?: () => EmbeddedNote[],
  ) {
    this.organizationRepository = new NoteOrganizationRepository(directory);
  }
  private read<T>(work: () => T): T {
    try {
      return this.index.atomic(() => {
        this.index.deferUntilRollback(() => {
          this.initialized = false;
        });
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
    this.index.deferUntilRollback(() => {
      if (readNoteFile(path)?.content !== content) return;
      if (before) replaceNoteFile(path, before.content);
      else unlinkSync(path);
    });
  }

  private initialize(): void {
    ensureNoteDirectory(this.directory);
    if (this.initialized) return;
    for (const legacy of this.embeddedNotes?.() ?? []) {
      const path = noteFilePath(this.directory, legacy.id);
      if (this.index.get(legacy.id)) continue;
      const existing = readNoteFile(path);
      if (legacy.deletedAt === null && !existing) this.writeFile(path, legacy.content);
      const content = existing?.content ?? legacy.content;
      this.index.save({
        id: legacy.id,
        revision: legacy.revision + (content === legacy.content ? 0 : 1),
        createdAt: legacy.createdAt,
        updatedAt: content === legacy.content ? legacy.updatedAt : existing!.modifiedAt,
        sha256: noteContentDigest(content),
        deletedAt: legacy.deletedAt,
      });
    }
    this.initialized = true;
  }

  private readAndSync(id: string): NoteRecord | undefined {
    const file = readNoteFile(noteFilePath(this.directory, id));
    let entry = this.index.get(id);
    if (!file) {
      if (entry && entry.deletedAt === null)
        this.index.save({ ...entry, deletedAt: Date.now() });
      return undefined;
    }
    const hash = noteContentDigest(file.content);
    if (!entry) {
      entry = {
        id,
        revision: 1,
        createdAt: file.createdAt,
        updatedAt: file.modifiedAt,
        sha256: hash,
        deletedAt: null,
      };
      this.index.save(entry);
    } else if (entry.sha256 !== hash || entry.deletedAt !== null) {
      entry = {
        ...entry,
        sha256: hash,
        revision: entry.revision + 1,
        updatedAt: file.modifiedAt,
        deletedAt: null,
      };
      this.index.save(entry);
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
      const activeIds = new Set(result.map(record => record.id));
      for (const entry of this.index.entries()) {
        if (
          entry.deletedAt === null &&
          !activeIds.has(entry.id)
        )
          this.index.save({ ...entry, deletedAt: Date.now() });
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
      if (this.index.get(id) || readNoteFile(path))
        throw new Error(`Note already exists: ${id}`);
      const now = options.now ?? Date.now();
      this.writeFile(path, input.content);
      this.index.save({ id, revision: 1, createdAt: now, updatedAt: now, sha256: noteContentDigest(input.content), deletedAt: null });
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
      this.index.save({ id, revision, createdAt: latest.createdAt, updatedAt: now, sha256: noteContentDigest(input.content), deletedAt: null });
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
    const removed = this.read(() => {
      unlinkSync(path);
      this.index.deferUntilRollback(() => {
        if (!readNoteFile(path)) replaceNoteFile(path, before.content);
      });
      this.index.save({ ...this.index.get(id)!, deletedAt: Date.now() });
      return true;
    });
    // A layout failure must not undo an already completed Markdown deletion.
    const reconcileDeletedNote = () => {
      try {
        const snapshot = this.organization();
        if (snapshot.warning) this.organizationWarning = snapshot.warning;
      } catch (error) {
        this.organizationWarning = `正文已删除，但整理未保存：${error instanceof Error ? error.message : String(error)}`;
      }
    };
    // An outer transaction can still roll back the deletion. Reconcile only
    // after that transaction commits, so its folder membership is not lost.
    this.index.deferUntilCommit(reconcileDeletedNote);
    return removed;
  }

  organization(): NoteOrganizationSnapshotRecord {
    const snapshot = this.organizationRepository.read(
      this.read(() => scanNoteIds(this.directory)),
    );
    if (this.organizationWarning) {
      snapshot.warning = [snapshot.warning, this.organizationWarning]
        .filter(Boolean)
        .join(" ");
      this.organizationWarning = undefined;
    }
    return snapshot;
  }

  saveOrganization(
    organization: NoteOrganizationV1Record,
    expectedEtag: string,
  ): Promise<NoteOrganizationSnapshotRecord> {
    return this.organizationRepository.save(organization, expectedEtag, () =>
      this.read(() => scanNoteIds(this.directory)),
    );
  }

  storageInfo(): { directory: string; format: "markdown" } {
    this.list();
    return { directory: this.directory, format: "markdown" };
  }

  backupTo(destination: string): void {
    this.organization();
    ensureNoteDirectory(destination);
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".md")) continue;
      const path = noteFilePath(this.directory, name.slice(0, -3));
      readNoteFile(path);
      copyFileSync(path, join(destination, name));
    }
    for (const name of ["organization.json", "organization.previous.json"]) {
      const file = readUtf8File(join(this.directory, name));
      if (file) replaceUtf8File(join(destination, name), file.content);
    }
  }

  copyLegacyFilesTo(destination: string): void {
    ensureNoteDirectory(destination);
    const indexed = new Set(this.index.entries().map(entry => entry.id));
    for (const legacy of this.embeddedNotes?.() ?? []) {
      if (
        legacy.deletedAt !== null || indexed.has(legacy.id)
      )
        continue;
      const path = noteFilePath(destination, legacy.id);
      if (!readNoteFile(path)) replaceNoteFile(path, legacy.content);
    }
  }

  validateFiles(
    directory = this.directory,
    allowFutureOrganization = false,
  ): void {
    ensureNoteDirectory(directory);
    const noteIds = readdirSync(directory)
      .filter((name) => name.endsWith(".md"))
      .map((name) => {
        const id = name.slice(0, -3);
        readNoteFile(noteFilePath(directory, id));
        return id;
      });
    validateNoteOrganizationFiles(directory, noteIds, allowFutureOrganization);
    for (const entry of this.index.entries()) {
      if (entry.deletedAt !== null) continue;
      const file = readNoteFile(noteFilePath(directory, entry.id));
      if (!file || noteContentDigest(file.content) !== entry.sha256)
        throw new Error(`Note backup is incomplete or corrupt: ${entry.id}`);
    }
  }
}
