import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SessionDatabase } from "./session-database.js";

// Regenerated from the current migration chain (0000_current_schema + 0001_drop_application_storage_format).
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
      expect(normalize(inventory(first.connection))).toEqual(normalize(expected));
      first.connection.prepare("UPDATE session_event_sequence SET reserved_through = 42 WHERE id = 1").run();
      const journal = first.connection.prepare("SELECT * FROM __drizzle_migrations").all();
      expect(journal).toHaveLength(2);
      first.close();
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
    ]);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", directory), "utf8"));
    expect(journal.entries.map((entry: { tag: string }) => entry.tag).sort()).toEqual([
      "0000_current_schema",
      "0001_drop_application_storage_format",
    ]);
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

  it("adopts a pre-baseline database on open and then applies incremental migrations", () => {
    withTempPath((path) => {
      const migrationsFolder = fileURLToPath(
        new URL("../session-runtime/migrations/", import.meta.url),
      );
      const baselineSql = readFileSync(join(migrationsFolder, "0000_current_schema.sql"), "utf8");
      const legacy = new Database(path);
      for (const statement of baselineSql.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed) legacy.exec(trimmed);
      }
      legacy.exec("ALTER TABLE channel_delivery DROP COLUMN platform_meta_json");
      legacy.exec("CREATE TABLE cron_job (id text PRIMARY KEY NOT NULL)");
      legacy.exec(
        "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
      );
      legacy.exec("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('stale', 1)");
      legacy.close();

      const database = SessionDatabase.open({ path });
      try {
        const columns = (
          database.connection.pragma("table_info(channel_delivery)") as Array<{ name: string }>
        ).map((column) => column.name);
        expect(columns).toContain("platform_meta_json");
        expect(
          database.connection
            .prepare("SELECT 1 FROM sqlite_master WHERE name = 'cron_job'")
            .get(),
        ).toBeUndefined();
        expect(
          database.connection
            .prepare("SELECT 1 FROM sqlite_master WHERE name = 'application_storage_format'")
            .get(),
        ).toBeUndefined();
        expect(
          database.connection
            .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
            .get(),
        ).toEqual({ n: 2 });
      } finally {
        database.close();
      }

      const reopened = SessionDatabase.open({ path });
      try {
        expect(
          reopened.connection
            .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
            .get(),
        ).toEqual({ n: 2 });
      } finally {
        reopened.close();
      }
    });
  });
});
