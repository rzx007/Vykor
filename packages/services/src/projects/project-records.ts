import { basename, resolve } from "node:path";

import type { ProjectRecord } from "@openharness/protocol";

export function projectFromRow(
  row: Record<string, unknown>,
): ProjectRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    path: row.path as string,
    ...(row.pinned_at ? { pinnedAt: row.pinned_at as number } : {}),
    ...(row.default_shell ? { defaultShell: row.default_shell as string } : {}),
    lastOpenedAt: row.last_opened_at as number,
    ...(row.archived_at ? { archivedAt: row.archived_at as number } : {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
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
