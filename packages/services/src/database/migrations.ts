import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

/** 源码/Desktop 用相邻目录，CLI 打包后回退到 bundle 旁的 ./migrations。 */
function resolveMigrationsFolder(): string {
  const sourceOrDesktop = new URL("../session-runtime/migrations", import.meta.url);
  return fileURLToPath(
    existsSync(sourceOrDesktop) ? sourceOrDesktop : new URL("./migrations", import.meta.url),
  );
}

/**
 * 每次打开都应用迁移链（基线 + 增量）。
 * 不做旧库接管：与当前基线不匹配的库会带提示失败，需要删除重建。
 */
export function applySessionMigrations(database: Database.Database): void {
  const migrationsFolder = resolveMigrationsFolder();
  try {
    migrate(drizzle(database), { migrationsFolder });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to apply database migrations for ${database.name}: ${detail}\n` +
        "If this database was created before the current migration baseline, delete it to start fresh.",
      { cause: error },
    );
  }
}
