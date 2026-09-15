import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SessionDatabase } from "./session-database.js";

function withTempPath(test: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "ohs-session-database-"));
  const path = join(directory, "sessions.db");
  try {
    test(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("SessionDatabase", () => {
  it("initializes an empty database with the current storage format and closes it", () => {
    withTempPath((path) => {
      const database = SessionDatabase.open({ path });
      expect(database.path).toBe(resolve(path));
      expect(database.connection.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(
        database.connection
          .prepare("SELECT version FROM application_storage_format WHERE id = 1")
          .get(),
      ).toEqual({ version: 2 });

      database.close();

      expect(() => database.connection.prepare("SELECT 1").get()).toThrow();
    });
  });

  it("rejects an existing database that has no OpenHarness storage format", () => {
    withTempPath((path) => {
      const legacy = new Database(path);
      try {
        legacy.exec("CREATE TABLE legacy_session (id TEXT PRIMARY KEY)");
      } finally {
        legacy.close();
      }

      expect(() => SessionDatabase.open({ path })).toThrow(
        "Unsupported OpenHarness database format. Existing databases are not upgraded; start with a new database path.",
      );
    });
  });

  it("creates parent directories before opening the SQLite file", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-session-database-parent-"));
    const path = join(directory, "nested", "sessions.db");
    try {
      const database = SessionDatabase.open({ path });
      expect(database.path).toBe(resolve(path));
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
