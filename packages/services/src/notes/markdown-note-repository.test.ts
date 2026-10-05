import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../session-runtime/store.js";

function withStore(work: (store: SessionStore, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-file-notes-"));
  const path = join(directory, "sessions.db");
  const store = new SessionStore({ path });
  try {
    work(store, path);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function insertLegacy(
  store: SessionStore,
  id: string,
  content: string,
  revision = 1,
): void {
  const storage = Reflect.get(store, "storage");
  storage.database.connection
    .prepare(
      "INSERT INTO note(id,content,revision,created_at,updated_at) VALUES(?,?,?,?,?)",
    )
    .run(id, content, revision, 10, 20);
}

describe("Markdown NoteRepository", () => {
  it("keeps committed files if an after-commit callback fails", () => {
    withStore((store, path) => {
      expect(() =>
        store.transaction(() => {
          store.notes.create({ content: "committed idea" }, { id: "note" });
          Reflect.get(store, "storage").deferUntilCommit(() => {
            throw new Error("notification failed");
          });
        }),
      ).toThrow("notification failed");
      expect(
        readFileSync(join(dirname(path), "notes", "note.md"), "utf8"),
      ).toBe("committed idea");
      expect(store.notes.get("note")).toMatchObject({
        content: "committed idea",
        revision: 1,
      });
    });
  });
  it("rolls back file creates, updates and deletes with an outer Store transaction", () => {
    withStore((store, path) => {
      store.notes.create({ content: "before" }, { id: "note" });
      const file = join(dirname(path), "notes", "note.md");
      expect(() =>
        store.transaction(() => {
          store.notes.update("note", {
            content: "middle",
            expectedRevision: 1,
          });
          store.notes.update("note", { content: "after", expectedRevision: 2 });
          store.notes.create({ content: "new idea" }, { id: "new" });
          store.notes.remove("note");
          throw new Error("outer rollback");
        }),
      ).toThrow("outer rollback");
      expect(readFileSync(file, "utf8")).toBe("before");
      expect(existsSync(join(dirname(path), "notes", "new.md"))).toBe(false);
      expect(store.notes.get("note")).toMatchObject({
        content: "before",
        revision: 1,
      });
    });
  });
  it("keeps the old file content when the metadata commit fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-note-rollback-"));
    const path = join(directory, "sessions.db");
    const file = join(directory, "notes", "note.md");
    const store = new SessionStore({
      path,
      transactionHooks: {
        beforeCommit: () => {
          if (existsSync(file) && readFileSync(file, "utf8") === "new content")
            throw new Error("commit failed");
        },
      },
    });
    try {
      store.notes.create({ content: "old content" }, { id: "note" });
      expect(() =>
        store.notes.update("note", {
          content: "new content",
          expectedRevision: 1,
        }),
      ).toThrow("commit failed");
      expect(readFileSync(file, "utf8")).toBe("old content");
      expect(store.notes.get("note")).toMatchObject({
        content: "old content",
        revision: 1,
      });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("stores exact content in a standalone Markdown file and reads it after reopening", () => {
    withStore((store, path) => {
      const note = store.notes.create(
        { content: "  想法\nsecond line  " },
        { id: "note", now: 10 },
      );
      const file = join(dirname(path), "notes", "note.md");
      expect(readFileSync(file, "utf8")).toBe("  想法\nsecond line  ");
      store.notes.update(
        note.id,
        { content: "updated", expectedRevision: 1 },
        20,
      );
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.notes.get(note.id)).toEqual({
          id: "note",
          content: "updated",
          revision: 2,
          createdAt: 10,
          updatedAt: 20,
        });
        expect(readFileSync(file, "utf8")).toBe("updated");
      } finally {
        reopened.close();
      }
    });
  });

  it("recognizes external edits and rejects a stale write without changing the file", () => {
    withStore((store, path) => {
      const note = store.notes.create({ content: "original" }, { id: "note" });
      const file = join(dirname(path), "notes", "note.md");
      writeFileSync(file, "edited in another editor");
      expect(() =>
        store.notes.update(note.id, { content: "stale", expectedRevision: 1 }),
      ).toThrow("Note revision conflict");
      expect(readFileSync(file, "utf8")).toBe("edited in another editor");
      expect(store.notes.get(note.id)).toMatchObject({
        content: "edited in another editor",
        revision: 2,
      });
    });
  });

  it("imports existing database notes once without deleting their original records", () => {
    withStore((store, path) => {
      insertLegacy(store, "legacy", "old idea", 4);
      expect(store.notes.list()).toEqual([
        {
          id: "legacy",
          content: "old idea",
          revision: 4,
          createdAt: 10,
          updatedAt: 20,
        },
      ]);
      expect(
        readFileSync(join(dirname(path), "notes", "legacy.md"), "utf8"),
      ).toBe("old idea");
      expect(store.notes.remove("legacy")).toBe(true);
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.notes.list()).toEqual([]);
      } finally {
        reopened.close();
      }
      expect(
        Reflect.get(store, "storage")
          .database.connection.prepare(
            "SELECT content FROM note WHERE id = 'legacy'",
          )
          .get(),
      ).toEqual({ content: "old idea" });
    });
  });

  it("does not overwrite a pre-existing file during database import", () => {
    withStore((store, path) => {
      const directory = join(dirname(path), "notes");
      store.notes.list();
      insertLegacy(store, "legacy", "old copy");
      writeFileSync(join(directory, "legacy.md"), "newer file");
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.notes.get("legacy")?.content).toBe("newer file");
      } finally {
        reopened.close();
      }
      expect(readFileSync(join(directory, "legacy.md"), "utf8")).toBe(
        "newer file",
      );
    });
  });

  it("allows clearing an existing note and explicitly removes its file", () => {
    withStore((store, path) => {
      const note = store.notes.create({ content: "idea" }, { id: "note" });
      store.notes.update(note.id, { content: "", expectedRevision: 1 });
      expect(
        readFileSync(join(dirname(path), "notes", "note.md"), "utf8"),
      ).toBe("");
      expect(store.notes.remove(note.id)).toBe(true);
      expect(store.notes.remove(note.id)).toBe(false);
      expect(existsSync(join(dirname(path), "notes", "note.md"))).toBe(false);
    });
  });

  it("refuses path traversal and leaves files unchanged on invalid writes", () => {
    withStore((store, path) => {
      expect(() =>
        store.notes.create({ content: "escape" }, { id: "../escape" }),
      ).toThrow();
      expect(existsSync(join(dirname(path), "escape.md"))).toBe(false);
      store.notes.create({ content: "saved" }, { id: "note" });
      expect(() =>
        store.notes.update("note", { content: "stale", expectedRevision: 3 }),
      ).toThrow("Note revision conflict");
      expect(
        readFileSync(join(dirname(path), "notes", "note.md"), "utf8"),
      ).toBe("saved");
      expect(
        readdirSync(join(dirname(path), "notes")).filter((file) =>
          file.endsWith(".tmp"),
        ),
      ).toEqual([]);
    });
  });

  it("rejects a non-UTF-8 external file without overwriting its bytes", () => {
    withStore((store, path) => {
      const note = store.notes.create({ content: "saved" }, { id: "note" });
      const file = join(dirname(path), "notes", "note.md");
      const bytes = Buffer.from([0xff, 0xfe, 0x61, 0x00]);
      writeFileSync(file, bytes);
      expect(() => store.notes.get(note.id)).toThrow("UTF-8");
      expect(readFileSync(file)).toEqual(bytes);
    });
  });
});
