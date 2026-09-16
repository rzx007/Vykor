import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SessionDatabase } from "./session-database.js";

// Captured by running all 21 original migrations at a97604ea before their removal.
const original = JSON.parse(readFileSync(new URL("./__fixtures__/current-schema-inventory.json", import.meta.url), "utf8"));
const retiredTables = new Set(["cron_job", "cron_run"]);
const expected = {
  ...original,
  schema: original.schema.filter((row: { tbl_name: string }) => !retiredTables.has(row.tbl_name)),
  tables: original.tables.filter((row: { name: string }) => !retiredTables.has(row.name)),
};

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
    format: database.prepare("SELECT * FROM application_storage_format").all(),
  };
}

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) =>
    typeof item === "string" ? item.replace(/\s+/g, " ").trim() : item));
}

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

  it("preserves the current inventory and data on a second open with one baseline", () => {
    withTempPath((path) => {
      const first = SessionDatabase.open({ path });
      expect(normalize(inventory(first.connection))).toEqual(normalize(expected));
      first.connection.prepare("UPDATE session_event_sequence SET reserved_through = 42 WHERE id = 1").run();
      const journal = first.connection.prepare("SELECT * FROM __drizzle_migrations").all();
      expect(journal).toHaveLength(1);
      first.close();
      const second = SessionDatabase.open({ path });
      try {
        expect(normalize(inventory(second.connection))).toEqual(normalize(expected));
        expect(second.connection.prepare("SELECT * FROM __drizzle_migrations").all()).toEqual(journal);
        expect(second.connection.prepare("SELECT reserved_through FROM session_event_sequence").get()).toEqual({ reserved_through: 42 });
      } finally { second.close(); }
    });
    const directory = new URL("../session-runtime/migrations/", import.meta.url);
    expect(readdirSync(directory).filter((name) => name.endsWith(".sql"))).toEqual(["0000_current_schema.sql"]);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", directory), "utf8"));
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({ idx: 0, tag: "0000_current_schema" });
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
