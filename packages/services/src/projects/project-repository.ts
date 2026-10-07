import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AppendEventInput, ProjectRecord } from "@vykor/protocol";
import { and, desc, eq, isNull } from "drizzle-orm";

import type { StorageContext } from "../database/storage-context.js";
import { projectLocations, projects, sessions } from "../session-runtime/schema.js";
import {
  defaultProjectName,
  normalizeProjectPath,
  projectFromRow,
} from "./project-records.js";

export class ProjectRepository {
  constructor(private readonly storage: StorageContext, private readonly appendEvent?: (input: AppendEventInput) => void) {}

  list(options: { includeArchived?: boolean } = {}): ProjectRecord[] {
    return this.storage.database.orm
      .select({ project: projects, path: projectLocations.path })
      .from(projects)
      .innerJoin(
        projectLocations,
        and(eq(projectLocations.projectId, projects.id), eq(projectLocations.status, "active")),
      )
      .where(options.includeArchived ? undefined : isNull(projects.archivedAt))
      .orderBy(isNull(projects.pinnedAt), desc(projects.pinnedAt), desc(projects.createdAt))
      .all()
      .map(({ project, path }) => projectFromRow(project, path));
  }

  get(projectId: string): ProjectRecord | undefined {
    const row = this.storage.database.orm
      .select({ project: projects, path: projectLocations.path })
      .from(projects)
      .innerJoin(
        projectLocations,
        and(eq(projectLocations.projectId, projects.id), eq(projectLocations.status, "active")),
      )
      .where(eq(projects.id, projectId))
      .get();
    return row ? projectFromRow(row.project, row.path) : undefined;
  }

  inspect(inputPath: string): ProjectRecord {
    const path = resolve(inputPath);
    const normalizedPath = normalizeProjectPath(path);
    const row = this.storage.database.orm
      .select({ project: projects, path: projectLocations.path })
      .from(projects)
      .innerJoin(
        projectLocations,
        and(eq(projectLocations.projectId, projects.id), eq(projectLocations.status, "active")),
      )
      .where(eq(projectLocations.normalizedPath, normalizedPath))
      .get();
    const timestamp = Date.now();
    if (row) {
      return this.storage.atomic(() => {
        this.storage.assertWritable();
        this.storage.database.orm
          .update(projects)
          .set({ archivedAt: null, lastOpenedAt: timestamp, updatedAt: timestamp })
          .where(eq(projects.id, row.project.id))
          .run();
        this.storage.database.orm
          .update(projectLocations)
          .set({ lastVerifiedAt: timestamp })
          .where(
            and(eq(projectLocations.projectId, row.project.id), eq(projectLocations.status, "active")),
          )
          .run();
        return this.get(row.project.id)!;
      });
    }
    const projectId = randomUUID();
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      this.storage.database.orm.insert(projects).values({
        id: projectId,
        name: defaultProjectName(path),
        pinnedAt: null,
        defaultShell: null,
        lastOpenedAt: timestamp,
        archivedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
      this.storage.database.orm.insert(projectLocations).values({
        id: randomUUID(),
        projectId,
        path,
        normalizedPath,
        status: "active",
        boundAt: timestamp,
        lastVerifiedAt: timestamp,
      }).run();
      return this.get(projectId)!;
    });
  }

  rename(projectId: string, name: string): ProjectRecord {
    return this.storage.database.connection.transaction(() => {
      this.storage.assertWritable();
      const value = name.replace(/\s+/g, " ").trim();
      if (!value) throw new Error("Project name is required");
      if (
        this.storage.database.orm
          .update(projects)
          .set({ name: value, updatedAt: Date.now() })
          .where(eq(projects.id, projectId))
          .run().changes === 0
      )
        throw new Error(`Project not found: ${projectId}`);
      return this.get(projectId)!;
    })();
  }

  setPinned(projectId: string, pinned: boolean): ProjectRecord {
    return this.storage.database.connection.transaction(() => {
      this.storage.assertWritable();
      if (
        this.storage.database.orm
          .update(projects)
          .set({ pinnedAt: pinned ? Date.now() : null, updatedAt: Date.now() })
          .where(eq(projects.id, projectId))
          .run().changes === 0
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
        this.storage.database.orm
          .update(projects)
          .set({ defaultShell: value || null, updatedAt: Date.now() })
          .where(eq(projects.id, projectId))
          .run().changes === 0
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
        this.storage.database.orm
          .update(projects)
          .set({ archivedAt: timestamp, updatedAt: timestamp })
          .where(eq(projects.id, projectId))
          .run().changes === 0
      )
        throw new Error(`Project not found: ${projectId}`);
      return this.get(projectId)!;
    })();
  }

  rebind(projectId: string, inputPath: string): ProjectRecord {
    const previous = this.get(projectId);
    if (!previous) throw new Error(`Project not found: ${projectId}`);
    const path = resolve(inputPath);
    const normalizedPath = normalizeProjectPath(path);
    const conflict = this.storage.database.orm
      .select({ projectId: projectLocations.projectId })
      .from(projectLocations)
      .where(
        and(eq(projectLocations.normalizedPath, normalizedPath), eq(projectLocations.status, "active")),
      )
      .get();
    if (conflict?.projectId && conflict.projectId !== projectId)
      throw new Error("Project directory is already bound to another project");
    const timestamp = Date.now();
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      this.storage.database.orm
        .update(projectLocations)
        .set({ status: "historical" })
        .where(and(eq(projectLocations.projectId, projectId), eq(projectLocations.status, "active")))
        .run();
      this.storage.database.orm.insert(projectLocations).values({
        id: randomUUID(),
        projectId,
        path,
        normalizedPath,
        status: "active",
        boundAt: timestamp,
        lastVerifiedAt: timestamp,
      }).run();
      this.storage.database.orm
        .update(projects)
        .set({ archivedAt: null, lastOpenedAt: timestamp, updatedAt: timestamp })
        .where(eq(projects.id, projectId))
        .run();
      for (const session of Object.values(this.storage.state.sessions)) {
        if (session.projectId !== projectId) continue;
        const cwdRelative = relative(previous.path, session.cwd);
        if (cwdRelative === ".." || cwdRelative.startsWith(`..${sep}`) || isAbsolute(cwdRelative)) continue;
        const cwd = resolve(path, cwdRelative);
        if (session.cwd === cwd) continue;
        this.storage.rollback?.capture(this.storage.state.sessions, session.id);
        session.cwd = cwd;
        session.cwdRelative = cwdRelative;
        session.updatedAt = timestamp;
        this.storage.database.orm
          .update(sessions)
          .set({ cwd: session.cwd, cwdRelative, updatedAt: timestamp })
          .where(eq(sessions.id, session.id))
          .run();
        this.appendEvent?.({ type: "session.updated", sessionId: session.id, payload: { session: structuredClone(session) } });
      }
      return this.get(projectId)!;
    });
  }
}
