import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { adoptLegacyDatabase, loadBaselineSnapshot } from "./legacy-adoption.js";

/** 源码/Desktop 用相邻目录，CLI 打包后回退到 bundle 旁的 ./migrations。 */
function resolveMigrationsFolder(): string {
  const sourceOrDesktop = new URL("../session-runtime/migrations", import.meta.url);
  return fileURLToPath(
    existsSync(sourceOrDesktop) ? sourceOrDesktop : new URL("./migrations", import.meta.url),
  );
}

/** 每次打开：先接管基线前旧库，再无条件下应用增量迁移。 */
export function applySessionMigrations(database: Database.Database): void {
  const migrationsFolder = resolveMigrationsFolder();
  const migrations = readMigrationFiles({ migrationsFolder });
  const baseline = migrations[0];
  if (baseline) {
    adoptLegacyDatabase(database, {
      baseline: { hash: baseline.hash, folderMillis: baseline.folderMillis },
      snapshot: loadBaselineSnapshot(migrationsFolder),
    });
  }
  migrate(drizzle(database), { migrationsFolder });
}
