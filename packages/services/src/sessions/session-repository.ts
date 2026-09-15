import { resolve } from "node:path";

import type {
  ListSessionsOptions,
  SessionRecord,
} from "@openharness/protocol";

import type { StorageContext } from "../database/storage-context.js";
import { assertSession, clone } from "../session-runtime/store-state.js";

export class SessionRepository {
  constructor(private readonly storage: StorageContext) {}

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
