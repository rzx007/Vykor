import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  adoptLegacyDatabase,
  baselineHash,
  LegacyAdoptionError,
  loadBaselineSnapshot,
  type AdoptionSnapshot,
} from "./legacy-adoption.js";

const migrationsFolder = fileURLToPath(
  new URL("../session-runtime/migrations", import.meta.url),
);
const baselineSqlPath = join(migrationsFolder, "0000_current_schema.sql");
const journal = JSON.parse(
  readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
) as { entries: Array<{ when: number }> };

function snapshotOf(tables: AdoptionSnapshot["tables"]): AdoptionSnapshot {
  return { tables };
}

function baselineDatabase(): Database.Database {
  const db = new Database(":memory:");
  const sql = readFileSync(baselineSqlPath, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) db.exec(trimmed);
  }
  db.exec(
    "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
  );
  return db;
}

const baseline = { hash: baselineHash(baselineSqlPath), folderMillis: journal.entries[0]!.when };

describe("adoptLegacyDatabase", () => {
  it("adds missing columns, creates partial indexes and drops obsolete tables", () => {
    const db = baselineDatabase();
    db.exec("ALTER TABLE channel_delivery DROP COLUMN platform_meta_json");
    db.exec("DROP INDEX project_location_active_path");
    db.exec("CREATE TABLE cron_job (id text PRIMARY KEY NOT NULL)");
    db.exec("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('stale', 1)");

    expect(
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toBe(true);

    const columns = (db.pragma("table_info(channel_delivery)") as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain("platform_meta_json");
    const indexSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name='project_location_active_path'",
        )
        .get() as { sql: string }
    ).sql;
    expect(indexSql.replace(/[`"]/g, "")).toContain("WHERE project_location.status = 'active'");
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cron_job'").get()).toBeUndefined();
    expect(db.prepare("SELECT hash, created_at FROM __drizzle_migrations").all()).toEqual([
      { hash: baseline.hash, created_at: baseline.folderMillis },
    ]);

    // 幂等：第二次不再接管
    expect(
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toBe(false);
  });

  it("accepts a partial index whose predicate differs only by the table qualifier", () => {
    const db = baselineDatabase();
    db.exec("DROP INDEX project_location_active_path");
    db.exec(
      "CREATE UNIQUE INDEX \"project_location_active_path\" ON \"project_location\" (\"normalized_path\") WHERE \"status\" = 'active'",
    );
    expect(
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toBe(true);
  });

  it("rejects a partial index whose predicate differs", () => {
    const db = baselineDatabase();
    db.exec("DROP INDEX project_location_active_path");
    db.exec(
      "CREATE UNIQUE INDEX project_location_active_path ON project_location (normalized_path) WHERE \"project_location\".\"status\" = 'inactive'",
    );
    expect(() =>
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toThrow(LegacyAdoptionError);
  });

  it("returns false for a fresh database", () => {
    const db = new Database(":memory:");
    expect(
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toBe(false);
  });

  it("rejects a missing baseline table", () => {
    const db = baselineDatabase();
    db.exec("DROP TABLE channel_delivery");
    expect(() =>
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toThrow(/baseline table is missing: channel_delivery/);
  });

  it("rejects adding a NOT NULL column without default to a non-empty table", () => {
    const db = baselineDatabase();
    db.exec("ALTER TABLE application_storage_format DROP COLUMN version");
    expect(() =>
      adoptLegacyDatabase(db, { baseline, snapshot: loadBaselineSnapshot(migrationsFolder) }),
    ).toThrow(LegacyAdoptionError);
  });

  it("rejects adding a primary key column", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (keep text NOT NULL)");
    db.exec(
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    const snapshot = snapshotOf({
      t: {
        name: "t",
        columns: {
          id: { name: "id", type: "text", primaryKey: true, notNull: true },
          keep: { name: "keep", type: "text", primaryKey: false, notNull: true },
        },
        indexes: {},
      },
    });
    expect(() => adoptLegacyDatabase(db, { baseline, snapshot })).toThrow(/primary key column/);
  });

  it("accepts a notNull-only difference on an existing column", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id text NOT NULL, keep text)");
    db.exec(
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    const snapshot = snapshotOf({
      t: {
        name: "t",
        columns: {
          id: { name: "id", type: "text", primaryKey: true, notNull: true },
          keep: { name: "keep", type: "text", primaryKey: false, notNull: true },
        },
        indexes: {},
      },
    });
    expect(adoptLegacyDatabase(db, { baseline, snapshot })).toBe(true);
  });

  it("rejects a type difference on an existing column", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id text NOT NULL, keep text)");
    db.exec(
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    const snapshot = snapshotOf({
      t: {
        name: "t",
        columns: {
          id: { name: "id", type: "text", primaryKey: true, notNull: true },
          keep: { name: "keep", type: "integer", primaryKey: false, notNull: true },
        },
        indexes: {},
      },
    });
    expect(() => adoptLegacyDatabase(db, { baseline, snapshot })).toThrow(LegacyAdoptionError);
  });
});
