import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { DesktopNoteIndex } from "./desktop-note-index.js";
import { readDesktopNotesImportReceipt, validateDesktopNotes, writeDesktopNotesImportReceipt } from "./desktop-note-repository.js";
import { assertNoteDirectory, ensureNoteDirectory, noteFilePath, noteOrganizationFileNames, readNoteFile, readUtf8File, replaceUtf8File, scanNoteIds } from "./markdown-note-files.js";
import type { EmbeddedNote, NoteIndexEntry } from "./note-index.js";
import { NoteRepository, noteContentDigest } from "./note-repository.js";

interface LegacyNotesSource {
  databasePath: string;
  notesDirectory?: string;
  destination: string;
}

export interface LegacyNotesImportOptions {
  signal?: AbortSignal;
  beforeValidate?: (stagedDirectory: string) => void | Promise<void>;
  beforePublish?: (stagedDirectory: string) => void | Promise<void>;
  afterPublish?: (directory: string) => void | Promise<void>;
}

export interface LegacyNotesImportResult {
  status: "migrated" | "already_migrated" | "empty";
}

const stat = (path: string) => lstatSync(path, { throwIfNoEntry: false });
const contains = (directory: string, path: string) => {
  const suffix = relative(directory, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep);
};

/** The caller has stopped legacy writers. SQLite only opens a disposable clone, including committed WAL frames. */
function readLegacyRows(databasePath: string): { indexed: NoteIndexEntry[]; embedded: EmbeddedNote[] } {
  const sidecarPaths = [databasePath, `${databasePath}-wal`, `${databasePath}-journal`];
  const files = sidecarPaths.map(path => ({ path, present: stat(path) }));
  for (const { path, present } of files) {
    if (present && (!present.isFile() || present.isSymbolicLink()))
      throw new Error(`Legacy notes source is not a regular file: ${path}`);
  }
  if (!files[0]?.present) {
    if (files.some(file => file.present && file.present.size > 0)) throw new Error("Legacy database is missing its main file");
    return { indexed: [], embedded: [] };
  }
  if (files[0]?.present.size === 0) throw new Error("Legacy database is empty or unreadable");
  // Never put the full historical database inside the directory to be published.
  const work = mkdtempSync(join(tmpdir(), "vykor-legacy-notes-"));
  const clone = join(work, "source.db");
  try {
    for (const { path, present } of files) {
      if (present) copyFileSync(path, clone + path.slice(databasePath.length));
    }
    const db = new Database(clone, { fileMustExist: true });
    try {
      if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Legacy notes database is corrupt");
      const table = db.prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name=?");
      const indexed = table.get("note_file_index") ? db.prepare<[], NoteIndexEntry>(`SELECT id, revision, created_at AS createdAt,
        updated_at AS updatedAt, sha256, deleted_at AS deletedAt FROM note_file_index ORDER BY id`).all() : [];
      const columns = db.pragma("table_info(note)") as Array<{ name: string }>;
      const propertiesColumn = columns.some(column => column.name === "properties") ? "properties" : "NULL AS properties";
      const embedded = table.get("note") ? db.prepare<[], Omit<EmbeddedNote, "deletedAt"> & { properties: string | null }>(`SELECT id, content, revision,
        created_at AS createdAt, updated_at AS updatedAt, ${propertiesColumn} FROM note ORDER BY id`).all().map(({ properties, ...entry }) => ({
        ...entry,
        deletedAt: properties === null ? null : (JSON.parse(properties)?.deletedAt ?? null),
      })) : [];
      return { indexed, embedded };
    } finally { db.close(); }
  } finally { rmSync(work, { recursive: true, force: true }); }
}

function existingTarget(directory: string, sourceDigest: string | null): LegacyNotesImportResult | undefined {
  if (!stat(directory)) return undefined;
  assertNoteDirectory(directory);
  const receipt = readDesktopNotesImportReceipt(directory);
  if (sourceDigest && receipt?.sourceDigest !== sourceDigest)
    throw new Error("Desktop notes import conflict: a separate local notes directory already exists");
  const index = new DesktopNoteIndex(directory, true);
  try { index.verify(); } finally { index.close(); }
  if (!receipt) writeDesktopNotesImportReceipt(directory, { version: 1, sourceDigest: null });
  return { status: "already_migrated" };
}

/** Stage on the target volume. The final directory and receipt become visible through a single rename. */
export async function importLegacyNotes(input: LegacyNotesSource, options: LegacyNotesImportOptions = {}): Promise<LegacyNotesImportResult> {
  const databasePath = resolve(input.databasePath);
  const notesDirectory = resolve(input.notesDirectory ?? join(dirname(databasePath), "notes"));
  const destination = resolve(input.destination);
  if (contains(notesDirectory, destination) || contains(destination, notesDirectory) || contains(destination, databasePath))
    throw new Error("Legacy and Desktop notes must use separate directories");
  options.signal?.throwIfAborted();
  ensureNoteDirectory(dirname(destination));
  const staged = mkdtempSync(join(dirname(destination), ".notes-import-"));
  try {
    const { indexed, embedded } = readLegacyRows(databasePath);
    const originalIds = new Set([...indexed, ...embedded].map(entry => entry.id));
    const originalFiles = new Map<string, string>();
    const index = new DesktopNoteIndex(staged);
    try {
      index.atomic(() => {
        for (const entry of indexed) index.save(entry);
        if (stat(notesDirectory)) {
          for (const id of scanNoteIds(notesDirectory).sort()) {
            const file = readNoteFile(noteFilePath(notesDirectory, id));
            if (!file) throw new Error(`Legacy notes source changed during import: ${id}`);
            const path = noteFilePath(staged, id);
            replaceUtf8File(path, file.content);
            utimesSync(path, file.modifiedAt / 1000, file.modifiedAt / 1000);
            const sha256 = noteContentDigest(file.content);
            originalFiles.set(`${id}.md`, sha256);
            if (!originalIds.has(id)) index.save({ id, revision: 1, createdAt: file.createdAt, updatedAt: file.modifiedAt, sha256, deletedAt: null });
          }
          for (const name of noteOrganizationFileNames(notesDirectory)) {
            const file = readUtf8File(join(notesDirectory, name));
            if (!file) throw new Error(`Legacy notes source changed during import: ${name}`);
            replaceUtf8File(join(staged, name), file.content);
            originalFiles.set(name, noteContentDigest(file.content));
          }
        } else if (indexed.some(entry => entry.deletedAt === null)) {
          throw new Error("Legacy notes directory is missing for the indexed database");
        }
      });
      const repository = new NoteRepository(staged, index, () => embedded);
      repository.list();
      const previousPath = join(staged, "organization.previous.json");
      const previous = readUtf8File(previousPath);
      repository.organization();
      if (previous && readUtf8File(previousPath)?.content !== previous.content)
        replaceUtf8File(previousPath, previous.content);
    } finally { index.close(); }

    const sourceDigest = originalIds.size || originalFiles.size
      ? createHash("sha256").update(JSON.stringify({ indexed, embedded, files: [...originalFiles] })).digest("hex")
      : null;
    options.signal?.throwIfAborted();
    const existing = existingTarget(destination, sourceDigest);
    if (existing) return existing;

    writeDesktopNotesImportReceipt(staged, { version: 1, sourceDigest });
    await options.beforeValidate?.(staged);
    validateDesktopNotes(staged);
    await options.beforePublish?.(staged);
    options.signal?.throwIfAborted();
    const allowed = new Set(["notes.sqlite", "import-receipt.json", ...noteOrganizationFileNames(staged), ...scanNoteIds(staged).map(id => `${id}.md`)]);
    if (readdirSync(staged, { withFileTypes: true }).some(entry => !entry.isFile() || !allowed.has(entry.name)))
      throw new Error("Desktop notes stage contains an unexpected item");
    try { renameSync(staged, destination); }
    catch (error) {
      const winner = existingTarget(destination, sourceDigest);
      if (winner) return winner;
      throw error;
    }
    await options.afterPublish?.(destination);
    return { status: sourceDigest ? "migrated" : "empty" };
  } finally { rmSync(staged, { recursive: true, force: true }); }
}
