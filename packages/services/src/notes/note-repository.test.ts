import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CreateNoteInput,
  NoteRecord,
  UpdateNoteInput,
} from "@vykor/protocol";
import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";

interface NotesPort {
  create(
    input: CreateNoteInput,
    options?: { id?: string; now?: number },
  ): NoteRecord;
  get(id: string): NoteRecord | undefined;
  list(): NoteRecord[];
  update(id: string, input: UpdateNoteInput, now?: number): NoteRecord;
  remove(id: string): boolean;
}

function notesOf(store: SessionStore): NotesPort {
  const notes = Reflect.get(store, "notes") as NotesPort | undefined;
  expect(notes).toBeDefined();
  return notes!;
}

describe("NoteRepository", () => {
  it("persists notes and returns the most recently updated first", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-notes-reopen-"));
    const path = join(directory, "sessions.db");
    let first: SessionStore | undefined;
    let second: SessionStore | undefined;
    try {
      first = new SessionStore({ path });
      const firstNotes = notesOf(first);
      const older = firstNotes.create(
        { content: "older" },
        { id: "older", now: 10 },
      );
      firstNotes.create({ content: "newer" }, { id: "newer", now: 20 });
      firstNotes.update(
        older.id,
        { content: "updated", expectedRevision: 1 },
        30,
      );
      first.close();
      first = undefined;

      second = new SessionStore({ path });
      expect(notesOf(second).list()).toEqual([
        {
          id: "older",
          content: "updated",
          revision: 2,
          createdAt: 10,
          updatedAt: 30,
        },
        {
          id: "newer",
          content: "newer",
          revision: 1,
          createdAt: 20,
          updatedAt: 20,
        },
      ]);
    } finally {
      first?.close();
      second?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows clearing an existing note and requires explicit removal", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-notes-clear-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const notes = notesOf(store);
      const note = notes.create(
        { content: "content" },
        { id: "note", now: 10 },
      );
      expect(
        notes.update(note.id, { content: "", expectedRevision: 1 }, 20),
      ).toMatchObject({
        content: "",
        revision: 2,
      });
      expect(notes.get(note.id)).toBeDefined();
      expect(notes.remove(note.id)).toBe(true);
      expect(notes.remove(note.id)).toBe(false);
      expect(notes.get(note.id)).toBeUndefined();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a stale revision without overwriting current content", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-notes-conflict-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const notes = notesOf(store);
      const note = notes.create({ content: "v1" }, { id: "note", now: 10 });
      notes.update(note.id, { content: "v2", expectedRevision: 1 }, 20);
      expect(() =>
        notes.update(note.id, { content: "stale", expectedRevision: 1 }, 30),
      ).toThrow("Note revision conflict: note expected 1");
      expect(notes.get(note.id)?.content).toBe("v2");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes a missing note from a revision conflict", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-notes-missing-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      expect(() =>
        notesOf(store).update("missing", { content: "x", expectedRevision: 1 }),
      ).toThrow("Note not found: missing");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
