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
    try {
      adoptLegacyDatabase(database, {
        baseline: { hash: baseline.hash, folderMillis: baseline.folderMillis },
        snapshot: loadBaselineSnapshot(migrationsFolder),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Legacy database adoption failed for ${database.name}: ${detail}. ` +
          "This database predates the current baseline and could not be reconciled automatically; " +
          "back it up and either run the older version to export, or delete it to start fresh.",
        { cause: error },
      );
    }
  }
  migrate(drizzle(database), { migrationsFolder });
}
