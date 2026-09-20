import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

export class LegacyAdoptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyAdoptionError";
  }
}

export interface AdoptionColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: unknown;
}

export interface AdoptionIndex {
  name: string;
  columns: string[];
  isUnique: boolean;
  where?: string;
}

export interface AdoptionTable {
  name: string;
  columns: Record<string, AdoptionColumn>;
  indexes: Record<string, AdoptionIndex>;
}

export interface AdoptionSnapshot {
  tables: Record<string, AdoptionTable>;
}

export interface AdoptionBaseline {
  hash: string;
  folderMillis: number;
}

const MIGRATIONS_TABLE = "__drizzle_migrations";

export function baselineHash(sqlPath: string): string {
  return createHash("sha256").update(readFileSync(sqlPath, "utf8")).digest("hex");
}

export function loadBaselineSnapshot(migrationsFolder: string): AdoptionSnapshot {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }> };
  const entry = journal.entries[0];
  if (!entry) throw new LegacyAdoptionError("migration journal is empty");
  const file = join(
    migrationsFolder,
    "meta",
    `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
  );
  return JSON.parse(readFileSync(file, "utf8")) as AdoptionSnapshot;
}

/** 返回是否执行了接管；空库与已打标库返回 false。 */
export function adoptLegacyDatabase(
  database: Database.Database,
  input: { baseline: AdoptionBaseline; snapshot: AdoptionSnapshot },
): boolean {
  if (!hasAnyTable(database)) return false;
  if (hasBaselineRow(database, input.baseline.hash)) return false;
  reconcile(database, input.snapshot, input.baseline);
  return true;
}

function hasAnyTable(database: Database.Database): boolean {
  return Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ? LIMIT 1",
      )
      .get(MIGRATIONS_TABLE),
  );
}

function hasBaselineRow(database: Database.Database, hash: string): boolean {
  const exists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (!exists) return false;
  return Boolean(
    database.prepare(`SELECT 1 FROM ${quote(MIGRATIONS_TABLE)} WHERE hash = ?`).get(hash),
  );
}

function reconcile(
  database: Database.Database,
  snapshot: AdoptionSnapshot,
  baseline: AdoptionBaseline,
): void {
  const previousForeignKeys = database.pragma("foreign_keys", { simple: true }) as number;
  database.pragma("foreign_keys = OFF");
  database.exec("BEGIN");
  try {
    for (const table of Object.values(snapshot.tables)) reconcileTable(database, table);
    dropExtraTables(database, snapshot);
    seedBaseline(database, baseline);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.pragma(`foreign_keys = ${previousForeignKeys ? "ON" : "OFF"}`);
  }
}

function reconcileTable(database: Database.Database, table: AdoptionTable): void {
  if (!tableExists(database, table.name)) {
    throw new LegacyAdoptionError(`legacy adoption: baseline table is missing: ${table.name}`);
  }
  const liveColumns = new Map(
    (
      database.pragma(`table_info(${quote(table.name)})`) as Array<{
        name: string;
        type: string;
        notnull: number;
      }>
    ).map((row) => [row.name, row]),
  );
  for (const column of Object.values(table.columns)) {
    const live = liveColumns.get(column.name);
    if (!live) {
      addColumn(database, table, column);
      continue;
    }
    if (
      live.type.trim().toLowerCase() !== column.type.trim().toLowerCase() ||
      Boolean(live.notnull) !== column.notNull
    ) {
      throw new LegacyAdoptionError(
        `legacy adoption: column definition differs: ${table.name}.${column.name}`,
      );
    }
  }
  reconcileIndexes(database, table);
}

function addColumn(
  database: Database.Database,
  table: AdoptionTable,
  column: AdoptionColumn,
): void {
  if (column.primaryKey) {
    throw new LegacyAdoptionError(
      `legacy adoption: cannot add a primary key column: ${table.name}.${column.name}`,
    );
  }
  const hasDefault = column.default !== undefined;
  if (column.notNull && !hasDefault) {
    const row = database.prepare(`SELECT 1 FROM ${quote(table.name)} LIMIT 1`).get();
    if (row) {
      throw new LegacyAdoptionError(
        `legacy adoption: cannot add NOT NULL column without default to non-empty table: ${table.name}.${column.name}`,
      );
    }
  }
  const definition = [`${quote(column.name)} ${column.type}`];
  if (hasDefault) definition.push(`DEFAULT ${renderDefault(column.default)}`);
  if (column.notNull) definition.push("NOT NULL");
  database.exec(`ALTER TABLE ${quote(table.name)} ADD COLUMN ${definition.join(" ")}`);
}

function reconcileIndexes(database: Database.Database, table: AdoptionTable): void {
  const live = existingIndexes(database, table.name);
  for (const index of Object.values(table.indexes)) {
    const current = live.get(index.name);
    if (!current) {
      database.exec(createIndexSql(table.name, index, true));
      continue;
    }
    const expectedPartial = index.where !== undefined;
    if (
      current.isUnique !== index.isUnique ||
      current.partial !== expectedPartial ||
      current.columns.join(",") !== index.columns.join(",")
    ) {
      throw new LegacyAdoptionError(`legacy adoption: index definition differs: ${index.name}`);
    }
  }
}

function existingIndexes(
  database: Database.Database,
  tableName: string,
): Map<string, { isUnique: boolean; partial: boolean; columns: string[] }> {
  const result = new Map<string, { isUnique: boolean; partial: boolean; columns: string[] }>();
  const list = database.pragma(`index_list(${quote(tableName)})`) as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  for (const row of list) {
    if (row.name.startsWith("sqlite_autoindex")) continue;
    const columns = (
      database.pragma(`index_info(${quote(row.name)})`) as Array<{ name: string }>
    ).map((info) => info.name);
    result.set(row.name, {
      isUnique: Boolean(row.unique),
      partial: Boolean(row.partial),
      columns,
    });
  }
  return result;
}

function createIndexSql(
  tableName: string,
  index: AdoptionIndex,
  ifNotExists: boolean,
): string {
  const unique = index.isUnique ? "UNIQUE " : "";
  const guard = ifNotExists ? "IF NOT EXISTS " : "";
  const columns = index.columns.map(quote).join(", ");
  const where = index.where ? ` WHERE ${index.where}` : "";
  return `CREATE ${unique}INDEX ${guard}${quote(index.name)} ON ${quote(tableName)} (${columns})${where}`;
}

function dropExtraTables(database: Database.Database, snapshot: AdoptionSnapshot): void {
  const wanted = new Set(Object.keys(snapshot.tables));
  const rows = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ?",
    )
    .all(MIGRATIONS_TABLE) as Array<{ name: string }>;
  for (const row of rows) {
    if (!wanted.has(row.name)) database.exec(`DROP TABLE ${quote(row.name)}`);
  }
}

function seedBaseline(database: Database.Database, baseline: AdoptionBaseline): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${quote(MIGRATIONS_TABLE)} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
  database.exec(`DELETE FROM ${quote(MIGRATIONS_TABLE)}`);
  database
    .prepare(`INSERT INTO ${quote(MIGRATIONS_TABLE)} (hash, created_at) VALUES (?, ?)`)
    .run(baseline.hash, baseline.folderMillis);
}

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function renderDefault(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
