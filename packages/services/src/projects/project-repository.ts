import type { ProjectRecord } from "@openharness/protocol";

import type { StorageContext } from "../database/storage-context.js";
import { projectFromRow } from "./project-records.js";

export class ProjectRepository {
  constructor(private readonly storage: StorageContext) {}

  list(options: { includeArchived?: boolean } = {}): ProjectRecord[] {
    const where = options.includeArchived ? "" : "WHERE p.archived_at IS NULL";
    return (
      this.storage.database.connection
        .prepare(
          `SELECT p.*, l.path FROM project p JOIN project_location l ON l.project_id = p.id AND l.status = 'active' ${where} ORDER BY (p.pinned_at IS NULL), p.pinned_at DESC, p.created_at DESC`,
        )
        .all() as Array<Record<string, unknown>>
    ).map(projectFromRow);
  }

  get(projectId: string): ProjectRecord | undefined {
    const row = this.storage.database.connection
      .prepare(
        "SELECT p.*, l.path FROM project p JOIN project_location l ON l.project_id = p.id AND l.status = 'active' WHERE p.id = ?",
      )
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? projectFromRow(row) : undefined;
  }
}
