import { basename, resolve } from "node:path";

import type { ProjectRecord } from "@vykor/protocol";
import type { projects } from "../session-runtime/schema.js";

export function projectFromRow(
  row: typeof projects.$inferSelect,
  path: string,
): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    path,
    ...(row.pinnedAt ? { pinnedAt: row.pinnedAt } : {}),
    ...(row.defaultShell ? { defaultShell: row.defaultShell } : {}),
    lastOpenedAt: row.lastOpenedAt,
    ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function normalizeProjectPath(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase()
    : normalized;
}

export function defaultProjectName(path: string): string {
  return basename(path);
}
