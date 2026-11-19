import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../../session-runtime/store.js";
import * as markdownFiles from "../markdown-note-files.js";

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
  it("reorders organization without reading Markdown bodies or updating their revisions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-layout-only-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.openLegacyNotes().create({ content: "a" }, { id: "a" });
      store.openLegacyNotes().create({ content: "b" }, { id: "b" });
      writeFileSync(join(store.openLegacyNotes().directory, "a.md"), "external edit");
      const index = () =>
        Reflect.get(store, "storage")
          .database.connection.prepare(
            "SELECT * FROM note_file_index ORDER BY id",
          )
          .all();
      const before = index();
      const readBody = vi.spyOn(markdownFiles, "readNoteFile");
      try {
        const snapshot = store.openLegacyNotes().organization();
        await store.openLegacyNotes().saveOrganization(
          {
            ...snapshot.organization,
            desktop: [...snapshot.organization.desktop].reverse(),
          },
          snapshot.etag,
        );
        expect(readBody).not.toHaveBeenCalled();
        expect(index()).toEqual(before);
        expect(readFileSync(join(store.openLegacyNotes().directory, "a.md"), "utf8")).toBe(
          "external edit",
        );
      } finally {
        readBody.mockRestore();
      }
      expect(store.openLegacyNotes().get("a")?.revision).toBe(2);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("scans external additions and deletions again when a queued organization save runs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-layout-external-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.openLegacyNotes().create({ content: "a" }, { id: "a" });
      store.openLegacyNotes().create({ content: "b" }, { id: "b" });
      store.openLegacyNotes().organization();
      unlinkSync(join(store.openLegacyNotes().directory, "a.md"));
      writeFileSync(join(store.openLegacyNotes().directory, "new.md"), "new");
      const snapshot = store.openLegacyNotes().organization();
      expect(snapshot.organization.desktop).toEqual([
        { type: "note", id: "b" },
        { type: "note", id: "new" },
      ]);
      const deletion = store.openLegacyNotes().saveOrganization(
        snapshot.organization,
        snapshot.etag,
      );
      unlinkSync(join(store.openLegacyNotes().directory, "b.md"));
      await expect(deletion).rejects.toThrow("不存在的便签");
      const latest = store.openLegacyNotes().organization();
      expect(latest.organization.desktop).toEqual([
        { type: "note", id: "new" },
      ]);
      const addition = store.openLegacyNotes().saveOrganization(
        latest.organization,
        latest.etag,
      );
      writeFileSync(join(store.openLegacyNotes().directory, "other.md"), "other");
      await expect(addition).rejects.toThrow("缺少现有便签");
      expect(
        JSON.parse(
          readFileSync(
            join(store.openLegacyNotes().directory, "organization.json"),
            "utf8",
          ),
        ),
      ).toEqual(latest.organization);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("migrates legacy notes on the first organization read and still enforces storage admission", () => {
    withStore((store, path) => {
      insertLegacy(store, "legacy", "old idea", 4);
      expect(store.openLegacyNotes().organization().organization.desktop).toEqual([
        { type: "note", id: "legacy" },
      ]);
      expect(
        readFileSync(join(dirname(path), "notes", "legacy.md"), "utf8"),
      ).toBe("old idea");
      expect(store.openLegacyNotes().get("legacy")?.revision).toBe(4);
      const storage = Reflect.get(store, "storage");
      const admission = vi
        .spyOn(storage, "assertWritable")
        .mockImplementation(() => {
          throw new Error("storage blocked");
        });
      try {
        expect(() => store.openLegacyNotes().organization()).toThrow("storage blocked");
      } finally {
        admission.mockRestore();
      }
    });
  });
  it("reconciles folder membership after deletion and retains Markdown deletion on layout failures", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-delete-organization-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.openLegacyNotes().create({ content: "a" }, { id: "a" });
      store.openLegacyNotes().create({ content: "b" }, { id: "b" });
      const initial = store.openLegacyNotes().organization();
      await store.openLegacyNotes().saveOrganization(
        {
          version: 1,
          desktop: [{ type: "folder", id: "f" }],
          folders: { f: { name: "folder", createdAt: 1, updatedAt: 1 } },
          folderItems: { f: ["a", "b"] },
        },
        initial.etag,
      );
      expect(() =>
        store.transaction(() => {
          store.openLegacyNotes().remove("a");
          throw new Error("rollback deletion");
        }),
      ).toThrow("rollback deletion");
      expect(store.openLegacyNotes().organization().organization.folderItems.f).toEqual([
        "a",
        "b",
      ]);
      expect(store.openLegacyNotes().remove("a")).toBe(true);
      expect(store.openLegacyNotes().organization().organization.desktop).toEqual([
        { type: "note", id: "b" },
      ]);
      writeFileSync(
        join(store.openLegacyNotes().directory, "organization.previous.json"),
        "blocked",
      );
      const repository = Reflect.get(store.openLegacyNotes(), "organizationRepository");
      const original = repository.read.bind(repository);
      repository.read = () => {
        throw new Error("layout write failed");
      };
      expect(store.openLegacyNotes().remove("b")).toBe(true);
      expect(existsSync(join(store.openLegacyNotes().directory, "b.md"))).toBe(false);
      repository.read = original;
      expect(store.openLegacyNotes().organization().warning).toContain("正文已删除");
      expect(store.openLegacyNotes().organization().organization.desktop).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("keeps committed files if an after-commit callback fails", () => {
    withStore((store, path) => {
      expect(() =>
        store.transaction(() => {
          store.openLegacyNotes().create({ content: "committed idea" }, { id: "note" });
          Reflect.get(store, "storage").deferUntilCommit(() => {
            throw new Error("notification failed");
          });
        }),
      ).toThrow("notification failed");
      expect(
        readFileSync(join(dirname(path), "notes", "note.md"), "utf8"),
      ).toBe("committed idea");
      expect(store.openLegacyNotes().get("note")).toMatchObject({
        content: "committed idea",
        revision: 1,
      });
    });
  });
  it("rolls back file creates, updates and deletes with an outer Store transaction", () => {
    withStore((store, path) => {
      store.openLegacyNotes().create({ content: "before" }, { id: "note" });
      const file = join(dirname(path), "notes", "note.md");
      expect(() =>
        store.transaction(() => {
          store.openLegacyNotes().update("note", {
            content: "middle",
            expectedRevision: 1,
          });
          store.openLegacyNotes().update("note", { content: "after", expectedRevision: 2 });
          store.openLegacyNotes().create({ content: "new idea" }, { id: "new" });
          store.openLegacyNotes().remove("note");
          throw new Error("outer rollback");
        }),
      ).toThrow("outer rollback");
      expect(readFileSync(file, "utf8")).toBe("before");
      expect(existsSync(join(dirname(path), "notes", "new.md"))).toBe(false);
      expect(store.openLegacyNotes().get("note")).toMatchObject({
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
      store.openLegacyNotes().create({ content: "old content" }, { id: "note" });
      expect(() =>
        store.openLegacyNotes().update("note", {
          content: "new content",
          expectedRevision: 1,
        }),
      ).toThrow("commit failed");
      expect(readFileSync(file, "utf8")).toBe("old content");
      expect(store.openLegacyNotes().get("note")).toMatchObject({
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
      const note = store.openLegacyNotes().create(
        { content: "  想法\nsecond line  " },
        { id: "note", now: 10 },
      );
      const file = join(dirname(path), "notes", "note.md");
      expect(readFileSync(file, "utf8")).toBe("  想法\nsecond line  ");
      store.openLegacyNotes().update(
        note.id,
        { content: "updated", expectedRevision: 1 },
        20,
      );
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.openLegacyNotes().get(note.id)).toEqual({
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
      const note = store.openLegacyNotes().create({ content: "original" }, { id: "note" });
      const file = join(dirname(path), "notes", "note.md");
      writeFileSync(file, "edited in another editor");
      expect(() =>
        store.openLegacyNotes().update(note.id, { content: "stale", expectedRevision: 1 }),
      ).toThrow("Note revision conflict");
      expect(readFileSync(file, "utf8")).toBe("edited in another editor");
      expect(store.openLegacyNotes().get(note.id)).toMatchObject({
        content: "edited in another editor",
        revision: 2,
      });
    });
  });

  it("imports existing database notes once without deleting their original records", () => {
    withStore((store, path) => {
      insertLegacy(store, "legacy", "old idea", 4);
      expect(store.openLegacyNotes().list()).toEqual([
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
      expect(store.openLegacyNotes().remove("legacy")).toBe(true);
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.openLegacyNotes().list()).toEqual([]);
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
      store.openLegacyNotes().list();
      insertLegacy(store, "legacy", "old copy");
      writeFileSync(join(directory, "legacy.md"), "newer file");
      const reopened = new SessionStore({ path });
      try {
        expect(reopened.openLegacyNotes().get("legacy")?.content).toBe("newer file");
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
      const note = store.openLegacyNotes().create({ content: "idea" }, { id: "note" });
      store.openLegacyNotes().update(note.id, { content: "", expectedRevision: 1 });
      expect(
        readFileSync(join(dirname(path), "notes", "note.md"), "utf8"),
      ).toBe("");
      expect(store.openLegacyNotes().remove(note.id)).toBe(true);
      expect(store.openLegacyNotes().remove(note.id)).toBe(false);
      expect(existsSync(join(dirname(path), "notes", "note.md"))).toBe(false);
    });
  });

  it("refuses path traversal and leaves files unchanged on invalid writes", () => {
    withStore((store, path) => {
      expect(() =>
        store.openLegacyNotes().create({ content: "escape" }, { id: "../escape" }),
      ).toThrow();
      expect(existsSync(join(dirname(path), "escape.md"))).toBe(false);
      store.openLegacyNotes().create({ content: "saved" }, { id: "note" });
      expect(() =>
        store.openLegacyNotes().update("note", { content: "stale", expectedRevision: 3 }),
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
      const note = store.openLegacyNotes().create({ content: "saved" }, { id: "note" });
      const file = join(dirname(path), "notes", "note.md");
      const bytes = Buffer.from([0xff, 0xfe, 0x61, 0x00]);
      writeFileSync(file, bytes);
      expect(() => store.openLegacyNotes().get(note.id)).toThrow("UTF-8");
      expect(readFileSync(file)).toEqual(bytes);
    });
  });
});
