import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  AppendEventInput,
  CreateSessionInput,
  ListSessionsOptions,
  ProjectRecord,
  SessionEventRecord,
  SessionRecord,
  UpdateSessionInput,
} from "@vykor/protocol";

import { atomicWrite } from "../database/atomic-write.js";
import type { StorageContext } from "../database/storage-context.js";
import {
  assertMutableSession,
  assertSession,
  clone,
  now,
} from "../session-runtime/store-state.js";

export interface SessionRepositoryOptions {
  storage: StorageContext;
  projects?: {
    get(id: string): ProjectRecord | undefined;
    inspect(path: string): ProjectRecord | undefined;
  };
  appendEvent?: (input: AppendEventInput) => SessionEventRecord;
  save?: () => void;
}

export class SessionRepository {
  private readonly storage: StorageContext;
  private readonly projects?: {
    get(id: string): ProjectRecord | undefined;
    inspect(path: string): ProjectRecord | undefined;
  };
  private readonly appendEvent?: (input: AppendEventInput) => SessionEventRecord;
  private readonly saveChanges?: () => void;

  constructor(options: StorageContext | SessionRepositoryOptions) {
    if ("state" in options) {
      this.storage = options;
    } else {
      this.storage = options.storage;
      this.projects = options.projects;
      this.appendEvent = options.appendEvent;
      this.saveChanges = options.save;
    }
  }

  create(input: CreateSessionInput): SessionRecord {
    return atomicWrite(this.storage, () => {
      this.storage.assertWritable();
      const id = input.id ?? randomUUID();
      if (this.storage.state.sessions[id])
        throw new Error(`Session already exists: ${id}`);
      const timestamp = now();
      const parent = input.parentId ? this.storage.state.sessions[input.parentId] : undefined;
      if (parent?.storage === "memory" && input.storage === "sqlite") {
        throw new Error("A temporary chat cannot own a persistent child chat");
      }
      const storage = input.storage ?? parent?.storage ?? "sqlite";
      const projectId =
        input.projectId ??
        (input.parentId
          ? this.storage.state.sessions[input.parentId]?.projectId
          : undefined);
      const project = projectId
        ? this.projects?.get(projectId)
        : this.projects?.inspect(input.cwd);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const cwd = resolve(input.cwd);
      const cwdRelative = relative(project.path, cwd);
      if (!input.parentId && (cwdRelative === ".." || cwdRelative.startsWith(`..${sep}`) || isAbsolute(cwdRelative))) {
        throw new Error("Session cwd must be within the project directory");
      }
      const session: SessionRecord = {
        id,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        projectId: project.id,
        cwd,
        cwdRelative,
        title: input.title ?? "",
        model: input.model,
        ...(input.agent ? { agent: input.agent } : {}),
        status: "idle",
        ...(storage === "memory" ? { storage: "memory" as const } : {}),
        metadata: input.metadata ?? {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.storage.rollback?.capture(this.storage.state.sessions, id);
      this.storage.state.sessions[id] = session;
      this.storage.mutations.sessions.add(id);
      this.appendEvent?.({
        type: "session.created",
        sessionId: id,
        payload: { session },
      });
      return clone(session);
    }, this.saveChanges);
  }

  update(sessionId: string, input: UpdateSessionInput): SessionRecord {
    return atomicWrite(this.storage, () => {
      this.storage.assertWritable();
      const session = assertSession(this.storage.state, sessionId);
      assertMutableSession(session);
      const timestamp = now();
      this.storage.rollback?.capture(this.storage.state.sessions, sessionId);
      if (input.title !== undefined) session.title = input.title;
      if (input.model !== undefined) session.model = input.model;
      if (input.agent !== undefined) {
        if (input.agent === null) delete session.agent;
        else session.agent = input.agent;
      }
      if (input.metadata !== undefined) session.metadata = input.metadata;
      session.updatedAt = timestamp;
      this.storage.mutations.sessions.add(sessionId);
      this.appendEvent?.({
        type: "session.updated",
        sessionId,
        payload: { session: clone(session) },
      });
      return clone(session);
    }, this.saveChanges);
  }

  beginArchive(sessionId: string): SessionRecord {
    const session = assertSession(this.storage.state, sessionId);
    if (session.status === "archived" || session.status === "closing")
      return clone(session);
    return atomicWrite(this.storage, () => {
      this.storage.assertWritable();
      const timestamp = now();
      this.storage.rollback?.capture(this.storage.state.sessions, sessionId);
      session.status = "closing";
      session.updatedAt = timestamp;
      this.storage.mutations.sessions.add(sessionId);
      this.appendEvent?.({
        type: "session.closing",
        sessionId,
        payload: { sessionId },
      });
      return clone(session);
    }, this.saveChanges);
  }

  archive(sessionId: string): SessionRecord {
    const session = assertSession(this.storage.state, sessionId);
    if (session.status === "archived") return clone(session);
    return atomicWrite(this.storage, () => {
      this.storage.assertWritable();
      const timestamp = now();
      this.storage.rollback?.capture(this.storage.state.sessions, sessionId);
      session.status = "archived";
      session.updatedAt = timestamp;
      session.archivedAt = timestamp;
      this.storage.mutations.sessions.add(sessionId);
      this.appendEvent?.({
        type: "session.archived",
        sessionId,
        payload: { sessionId },
      });
      return clone(session);
    }, this.saveChanges);
  }

  get(sessionId: string): SessionRecord | undefined {
    const session = this.storage.state.sessions[sessionId];
    return session ? clone(session) : undefined;
  }

  list(options: ListSessionsOptions = {}): SessionRecord[] {
    const cwd = options.cwd ? resolve(options.cwd) : undefined;
    let sessions = Object.values(this.storage.state.sessions);
    if (cwd) sessions = sessions.filter((session) => session.cwd === cwd);
    if (!options.includeArchived)
      sessions = sessions.filter((session) => session.status !== "archived");
    sessions = sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    if (options.limit !== undefined)
      sessions = sessions.slice(0, options.limit);
    return clone(sessions);
  }

  listChildren(
    parentId: string,
    options: { includeArchived?: boolean } = {},
  ): SessionRecord[] {
    assertSession(this.storage.state, parentId);
    return clone(
      Object.values(this.storage.state.sessions)
        .filter(
          (session) =>
            session.parentId === parentId &&
            (options.includeArchived || session.status !== "archived"),
        )
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }
}
