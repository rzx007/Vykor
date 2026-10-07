import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vykor/services";
import { describe, expect, it } from "vitest";
import { createApplicationBackup, verifyApplicationBackup } from "../backup/application-backup.js";

describe("maintenance backup verification", () => {
  it("verifies an entire backup and rejects changed bytes and destinations inside the live database directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-backup-"));
    const store = new SessionStore({ path: join(root, "live", "sessions.db") });
    try {
      await expect(createApplicationBackup({ store, destination: join(root, "live", "nested-backup") })).rejects.toThrow("inside a source directory");
      const destination = join(root, "backup"); const manifest = await createApplicationBackup({ store, destination });
      expect(verifyApplicationBackup(destination).backupId).toBe(manifest.backupId);
      const database = readFileSync(join(destination, "database.sqlite")); database[database.length - 1] = database[database.length - 1]! ^ 1;
      writeFileSync(join(destination, "database.sqlite"), database);
      expect(() => verifyApplicationBackup(destination)).toThrow("checksum");
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
