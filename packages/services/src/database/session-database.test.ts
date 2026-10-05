import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { sessionEventSequence } from "../session-runtime/schema.js";
import { SessionDatabase } from "./session-database.js";

// Regenerated from the current migration chain, including temporary resource sources.
const expected = JSON.parse(readFileSync(new URL("./__fixtures__/current-schema-inventory.json", import.meta.url), "utf8"));

function inventory(database: Database.Database) {
  const schema = database.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE ? AND name != ? ORDER BY type,name",
  ).all("sqlite_%", "__drizzle_migrations") as Array<{ type: string; name: string; sql: string }>;
  return {
    schema,
    tables: schema.filter((row) => row.type === "table").map((row) => ({
      name: row.name,
      columns: database.pragma(`table_info(${JSON.stringify(row.name)})`),
      foreignKeys: database.pragma(`foreign_key_list(${JSON.stringify(row.name)})`),
    })),
  };
}

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) =>
    typeof item === "string" ? item.replace(/\s+/g, " ").trim() : item));
}

function withTempPath(test: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "vk-session-database-"));
  const path = join(directory, "sessions.db");
  try {
    test(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("SessionDatabase", () => {
  it("rolls schema-based writes back with the existing SQLite transaction", () => {
    withTempPath((path) => {
      const database = SessionDatabase.open({ path });
      try {
        expect(database.orm.select().from(sessionEventSequence).get()).toEqual({ id: 1, reservedThrough: 0 });
        expect(() => database.connection.transaction(() => {
          database.orm.update(sessionEventSequence).set({ reservedThrough: 42 })
            .where(eq(sessionEventSequence.id, 1)).run();
          expect(database.orm.select().from(sessionEventSequence).get()?.reservedThrough).toBe(42);
          throw new Error("rollback typed write");
        })()).toThrow("rollback typed write");
        expect(database.orm.select().from(sessionEventSequence).get()?.reservedThrough).toBe(0);
      } finally {
        database.close();
      }
    });
  });

  it("initializes an empty database with the current storage format and closes it", () => {
    withTempPath((path) => {
      const database = SessionDatabase.open({ path });
      expect(database.path).toBe(resolve(path));
      expect(database.connection.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(
        database.connection
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'application_storage_format'")
          .get(),
      ).toBeUndefined();

      database.close();

      expect(() => database.connection.prepare("SELECT 1").get()).toThrow();
    });
  });

  it("preserves the current inventory and data on a second open with the migration chain", () => {
    withTempPath((path) => {
      const first = SessionDatabase.open({ path });
      let journal: unknown[];
      try {
        expect(normalize(inventory(first.connection))).toEqual(normalize(expected));
        first.connection.prepare("UPDATE session_event_sequence SET reserved_through = 42 WHERE id = 1").run();
        journal = first.connection.prepare("SELECT * FROM __drizzle_migrations").all();
        expect(journal).toHaveLength(7);
      } finally {
        first.close();
      }
      const second = SessionDatabase.open({ path });
      try {
        expect(normalize(inventory(second.connection))).toEqual(normalize(expected));
        expect(second.connection.prepare("SELECT * FROM __drizzle_migrations").all()).toEqual(journal);
        expect(second.connection.prepare("SELECT reserved_through FROM session_event_sequence").get()).toEqual({ reserved_through: 42 });
      } finally { second.close(); }
    });
    const directory = new URL("../session-runtime/migrations/", import.meta.url);
    const sqlFiles = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
    expect(sqlFiles).toEqual([
      "0000_current_schema.sql",
      "0001_drop_application_storage_format.sql",
      "0002_temporary_resource_sources.sql",
      "0003_global_notes.sql",
      "0004_note_organization.sql",
      "0005_note_attachments.sql",
      "0006_note_file_index.sql",
    ]);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", directory), "utf8"));
    expect(journal.entries.map((entry: { tag: string }) => entry.tag).sort()).toEqual([
      "0000_current_schema",
      "0001_drop_application_storage_format",
      "0002_temporary_resource_sources",
      "0003_global_notes",
      "0004_note_organization",
      "0005_note_attachments",
      "0006_note_file_index",
    ]);
  });

  it("creates parent directories before opening the SQLite file", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-session-database-parent-"));
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
