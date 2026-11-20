import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DesktopNoteIndex, desktopNoteIndexPath } from "./desktop-note-index.js";
import { assertNoteDirectory, ensureNoteDirectory, noteFilePath, noteOrganizationFileNames, readNoteFile, readUtf8File, replaceUtf8File, scanNoteIds } from "./markdown-note-files.js";
import { validateNoteOrganizationFiles } from "./note-organization-repository.js";
import { NoteRepository, noteContentDigest } from "./note-repository.js";

const receiptFile = "import-receipt.json";
export interface DesktopNotesImportReceipt { version: 1; sourceDigest: string | null }

export function readDesktopNotesImportReceipt(directory: string): DesktopNotesImportReceipt | undefined {
  const file = readUtf8File(join(directory, receiptFile), 8_192);
  if (!file) return undefined;
  const receipt = JSON.parse(file.content) as Partial<DesktopNotesImportReceipt> | null;
  if (receipt?.version !== 1 || !(receipt.sourceDigest === null || typeof receipt.sourceDigest === "string" && /^[a-f0-9]{64}$/.test(receipt.sourceDigest)))
    throw new Error("Invalid Desktop notes import receipt");
  return { version: 1, sourceDigest: receipt.sourceDigest };
}

export function writeDesktopNotesImportReceipt(directory: string, receipt: DesktopNotesImportReceipt): void {
  replaceUtf8File(join(directory, receiptFile), JSON.stringify(receipt) + "\n");
}

/** Fast startup check, against the native layout only. */
export function hasDesktopNotesImportReceipt(directory: string): boolean {
  if (!lstatSync(directory, { throwIfNoEntry: false })) return false;
  assertNoteDirectory(directory);
  if (!readDesktopNotesImportReceipt(directory)) return false;
  if (!lstatSync(desktopNoteIndexPath(directory), { throwIfNoEntry: false }))
    throw new Error("Desktop notes import receipt is missing its index");
  return true;
}

export function openDesktopNoteRepository(directory: string): {
  repository: NoteRepository;
  close(): void;
  backupTo(destination: string): Promise<void>;
} {
  ensureNoteDirectory(directory);
  const index = new DesktopNoteIndex(directory);
  const repository = new NoteRepository(directory, index);
  return {
    repository,
    close: () => index.close(),
    async backupTo(destination) {
      ensureNoteDirectory(destination);
      if (readdirSync(destination).length) throw new Error("Desktop notes backup target must be empty");
      repository.list();
      repository.organization();
      index.copyTo(desktopNoteIndexPath(destination));
      for (const id of scanNoteIds(directory)) {
        const file = readNoteFile(noteFilePath(directory, id));
        if (file) replaceUtf8File(noteFilePath(destination, id), file.content);
      }
      for (const name of noteOrganizationFileNames(directory)) {
        const file = readUtf8File(join(directory, name));
        if (file) replaceUtf8File(join(destination, name), file.content);
      }
      writeDesktopNotesImportReceipt(destination, readDesktopNotesImportReceipt(directory) ?? { version: 1, sourceDigest: null });
      validateDesktopNotes(destination);
    },
  };
}

/** Check a closed or stopped copy. Opening for validation never creates or repairs files. */
export function validateDesktopNotes(directory: string): void {
  assertNoteDirectory(directory);
  const index = new DesktopNoteIndex(directory, true);
  try {
    index.verify();
    readDesktopNotesImportReceipt(directory);
    const ids = scanNoteIds(directory);
    const unindexed = new Set(ids);
    for (const entry of index.entries()) {
      const path = noteFilePath(directory, entry.id);
      if (!Number.isSafeInteger(entry.revision) || entry.revision < 1 || ![entry.createdAt, entry.updatedAt, entry.deletedAt ?? 0].every(value => Number.isFinite(value) && value >= 0)
        || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Desktop notes index metadata is corrupt: ${entry.id}`);
      if (entry.deletedAt !== null) continue;
      const file = readNoteFile(path);
      if (!file || noteContentDigest(file.content) !== entry.sha256 || !unindexed.delete(entry.id))
        throw new Error(`Desktop notes backup is incomplete or corrupt: ${entry.id}`);
    }
    if (unindexed.size) throw new Error("Desktop notes backup contains unindexed Markdown");
    for (const name of noteOrganizationFileNames(directory)) readUtf8File(join(directory, name));
    validateNoteOrganizationFiles(directory, ids, true);
  } finally { index.close(); }
}
