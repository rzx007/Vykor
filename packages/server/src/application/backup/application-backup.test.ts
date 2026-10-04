import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "@vykor/services";
import { describe, expect, it } from "vitest";

import {
  createApplicationBackup,
  restoreApplicationBackup,
} from "./application-backup.js";

describe("application backup notes", () => {
  it("backs up and restores global notes with their revisions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-note-backup-"));
    const sourcePath = join(directory, "source.db");
    const backupPath = join(directory, "backup");
    const restoredPath = join(directory, "restored.db");
    let source: SessionStore | undefined;
    let restored: SessionStore | undefined;
    try {
      source = new SessionStore({ path: sourcePath });
      const created = source.notes.create(
        { content: "before backup" },
        { id: "note", now: 10 },
      );
      source.notes.update(
        created.id,
        { content: "saved", expectedRevision: 1 },
        20,
      );
      await createApplicationBackup({ store: source, destination: backupPath });
      source.close();
      source = undefined;

      restoreApplicationBackup({ source: backupPath, storePath: restoredPath });
      restored = new SessionStore({ path: restoredPath });
      expect(restored.notes.list()).toEqual([
        {
          id: "note",
          content: "saved",
          revision: 2,
          createdAt: 10,
          updatedAt: 20,
        },
      ]);
    } finally {
      source?.close();
      restored?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
