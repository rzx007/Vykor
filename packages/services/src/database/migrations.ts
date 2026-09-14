import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export const CURRENT_STORAGE_FORMAT = 2;

export function assertCurrentStorageFormatOrEmpty(
  database: Database.Database,
): void {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  if (tables.length === 0) return;
  if (!tables.some((table) => table.name === "application_storage_format")) {
    throw new Error(
      "Unsupported OpenHarness database format. Existing databases are not upgraded; start with a new database path.",
    );
  }
  assertCurrentStorageFormat(database);
}

export function applySessionMigrations(database: Database.Database): void {
  migrate(drizzle(database), {
    migrationsFolder: fileURLToPath(
      new URL("../session-runtime/migrations", import.meta.url),
    ),
  });
}

export function assertCurrentStorageFormat(database: Database.Database): void {
  const row = database
    .prepare("SELECT version FROM application_storage_format WHERE id = 1")
    .get() as { version?: unknown } | undefined;
  if (row?.version !== CURRENT_STORAGE_FORMAT) {
    throw new Error(
      `Unsupported OpenHarness database format ${String(row?.version)}; expected ${CURRENT_STORAGE_FORMAT}. Move or delete the old database and restart.`,
    );
  }
}
