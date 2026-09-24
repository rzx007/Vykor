import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { ProjectRecord } from "@vykor/protocol";

import type { StorageContext } from "../database/storage-context.js";
import {
  defaultProjectName,
  normalizeProjectPath,
  projectFromRow,
} from "./project-records.js";

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

  inspect(inputPath: string): ProjectRecord {
    const path = resolve(inputPath);
    const normalizedPath = normalizeProjectPath(path);
    const row = this.storage.database.connection
      .prepare(
        "SELECT p.*, l.path FROM project p JOIN project_location l ON l.project_id = p.id AND l.status = 'active' WHERE l.normalized_path = ?",
      )
      .get(normalizedPath) as Record<string, unknown> | undefined;
    const timestamp = Date.now();
    if (row) {
      return this.storage.atomic(() => {
        this.storage.assertWritable();
        this.storage.database.connection
          .prepare(
            "UPDATE project SET archived_at = NULL, last_opened_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(timestamp, timestamp, row.id);
        this.storage.database.connection
          .prepare(
            "UPDATE project_location SET last_verified_at = ? WHERE project_id = ? AND status = 'active'",
          )
          .run(timestamp, row.id);
        return this.get(row.id as string)!;
      });
    }
    const projectId = randomUUID();
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      this.storage.database.connection
        .prepare(
          "INSERT INTO project (id, name, pinned_at, default_shell, last_opened_at, archived_at, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?)",
        )
        .run(
          projectId,
          defaultProjectName(path),
          timestamp,
          timestamp,
          timestamp,
        );
      this.storage.database.connection
        .prepare(
          "INSERT INTO project_location VALUES (?, ?, ?, ?, 'active', ?, ?)",
        )
        .run(
          randomUUID(),
          projectId,
          path,
          normalizedPath,
          timestamp,
          timestamp,
        );
      return this.get(projectId)!;
    });
  }

  rename(projectId: string, name: string): ProjectRecord {
    return this.storage.database.connection.transaction(() => {
      this.storage.assertWritable();
      const value = name.replace(/\s+/g, " ").trim();
      if (!value) throw new Error("Project name is required");
      if (
        this.storage.database.connection
          .prepare("UPDATE project SET name = ?, updated_at = ? WHERE id = ?")
          .run(value, Date.now(), projectId).changes === 0
      )
        throw new Error(`Project not found: ${projectId}`);
      return this.get(projectId)!;
    })();
  }

  setPinned(projectId: string, pinned: boolean): ProjectRecord {
    return this.storage.database.connection.transaction(() => {
      this.storage.assertWritable();
      if (
        this.storage.database.connection
          .prepare(
            "UPDATE project SET pinned_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(pinned ? Date.now() : null, Date.now(), projectId).changes === 0
      )
        throw new Error(`Project not found: ${projectId}`);
      return this.get(projectId)!;
    })();
  }

  setDefaultShell(projectId: string, shell: string | null): ProjectRecord {
    return this.storage.database.connection.transaction(() => {
      this.storage.assertWritable();
      const value = shell?.replace(/\s+/g, " ").trim() ?? "";
      if (
        this.storage.database.connection
          .prepare(
            "UPDATE project SET default_shell = ?, updated_at = ? WHERE id = ?",
          )
          .run(value || null, Date.now(), projectId).changes === 0
      )
        throw new Error(`Project not found: ${projectId}`);
      return this.get(projectId)!;
    })();
  }

  archive(projectId: string): ProjectRecord {
    return this.storage.database.connection.transaction(() => {
      this.storage.assertWritable();
      const timestamp = Date.now();
      if (
        this.storage.database.connection
          .prepare(
            "UPDATE project SET archived_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(timestamp, timestamp, projectId).changes === 0
      )
        throw new Error(`Project not found: ${projectId}`);
      return this.get(projectId)!;
    })();
  }

  rebind(projectId: string, inputPath: string): ProjectRecord {
    if (!this.get(projectId)) throw new Error(`Project not found: ${projectId}`);
    const path = resolve(inputPath);
    const normalizedPath = normalizeProjectPath(path);
    const conflict = this.storage.database.connection
      .prepare(
        "SELECT project_id FROM project_location WHERE normalized_path = ? AND status = 'active'",
      )
      .get(normalizedPath) as { project_id?: string } | undefined;
    if (conflict?.project_id && conflict.project_id !== projectId)
      throw new Error("Project directory is already bound to another project");
    const timestamp = Date.now();
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      this.storage.database.connection
        .prepare(
          "UPDATE project_location SET status = 'historical' WHERE project_id = ? AND status = 'active'",
        )
        .run(projectId);
      this.storage.database.connection
        .prepare(
          "INSERT INTO project_location VALUES (?, ?, ?, ?, 'active', ?, ?)",
        )
        .run(
          randomUUID(),
          projectId,
          path,
          normalizedPath,
          timestamp,
          timestamp,
        );
      this.storage.database.connection
        .prepare(
          "UPDATE project SET archived_at = NULL, last_opened_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(timestamp, timestamp, projectId);
      for (const session of Object.values(this.storage.state.sessions)) {
        if (session.projectId !== projectId) continue;
        session.cwd = resolve(path, session.cwdRelative ?? "");
        this.storage.database.connection
          .prepare("UPDATE session SET cwd = ? WHERE id = ?")
          .run(session.cwd, session.id);
      }
      return this.get(projectId)!;
    });
  }
}
