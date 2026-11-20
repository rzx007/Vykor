import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionDatabase } from "../session-database.js";
import * as relocation from "../data-root-relocation.js";
import * as tables from "../../session-runtime/schema.js";
it("compares all database records independently of SQLite page rewrites", () => {
  const root = mkdtempSync(join(tmpdir(), "validation-digest-")), path = join(root, "sessions.db");
  const db = SessionDatabase.open({ path });
  try {
    db.orm.insert(tables.sessions).values({ id: "s", cwd: root, title: "original", metadataJson: "{}", model: "test", status: "idle", createdAt: 1, updatedAt: 1 }).run();
    db.connection.pragma("wal_checkpoint(TRUNCATE)");
    const digest = (relocation as any).digestDataRootCopy(path);
    db.connection.exec("VACUUM"); db.connection.pragma("wal_checkpoint(TRUNCATE)");
    expect((relocation as any).digestDataRootCopy(path)).toBe(digest);
    db.connection.prepare("UPDATE session SET title = ? WHERE id = ?").run("changed", "s");
    expect((relocation as any).digestDataRootCopy(path)).not.toBe(digest);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("only discounts the recorded stopped validation owner and still checks every business row", () => {
  const root = mkdtempSync(join(tmpdir(), "validation-owner-")), path = join(root, "sessions.db"), db = SessionDatabase.open({ path });
  try {
    const before = relocation.digestDataRootCopy(path);
    db.connection.prepare("INSERT INTO application_owner VALUES ('application', 'owned-validation', 991122, 1, 1, 1)").run();
    expect(relocation.digestDataRootCopy(path, { stoppedValidationPid: 991122 })).toBe(before);
    expect(relocation.digestDataRootCopy(path, { stoppedValidationPid: 991123 })).not.toBe(before);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("refuses a stopped copy that still names a live application writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "validation-live-owner-")), path = join(root, "sessions.db"), db = SessionDatabase.open({ path });
  try {
    db.connection.prepare("INSERT INTO application_owner VALUES ('application', 'unregistered-writer', ?, 1, 1, 1)").run(process.pid);
    await expect(relocation.verifyDataRootCopy(path)).rejects.toThrow(/owner/);
    expect(db.connection.prepare("SELECT pid FROM application_owner").get()).toEqual({ pid: process.pid });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
