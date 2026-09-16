import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

/** Initialize only empty databases; reopening the current database makes no schema changes. */
export function applySessionMigrations(database: Database.Database): void {
  const table = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' LIMIT 1",
  ).get();
  if (table) return;
  // Source modules and Desktop share one layout; the CLI puts assets beside its bundle.
  const sourceOrDesktop = new URL("../session-runtime/migrations", import.meta.url);
  migrate(drizzle(database), {
    migrationsFolder: fileURLToPath(existsSync(sourceOrDesktop)
      ? sourceOrDesktop
      : new URL("./migrations", import.meta.url)),
  });
}
