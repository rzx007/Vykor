import type {
  ListMessagePartsOptions,
  ListMessagesOptions,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionStateSnapshot,
} from "@openharness/protocol";

export interface ListSessionsQuery {
  cwd?: string;
  includeArchived?: boolean;
  includeChildren?: boolean;
  limit?: number;
}

export type ListMessagesQuery = ListMessagesOptions;
export type ListMessagePartsQuery = ListMessagePartsOptions;

export interface SessionQueryStore {
  getSession(sessionId: string): SessionRecord | undefined;
  listSessions(options?: {
    cwd?: string;
    includeArchived?: boolean;
    limit?: number;
  }): SessionRecord[];
  getSessionState(sessionId: string): SessionStateSnapshot;
  listMessages(sessionId: string, options?: ListMessagesQuery): SessionMessageRecord[];
  listMessageParts(sessionId: string, options?: ListMessagePartsQuery): SessionMessagePartRecord[];
  resolveSessionListTitle(sessionId: string): string;
}

/**
 * Session 只读查询门面：列表（可隐藏 child）、详情、messages/parts、session state。
 * 不触发 runtime warm，也不改 store。
 */
export class SessionQueryService {
  constructor(private readonly store: SessionQueryStore) {}

  listSessions(input: ListSessionsQuery): SessionRecord[] {
    let sessions = this.store.listSessions({
      cwd: input.cwd,
      includeArchived: input.includeArchived,
      limit: input.limit,
    });
    if (!input.includeChildren) {
      sessions = sessions.filter((session) => !session.parentId);
    }
    return sessions.map((session) => ({
      ...session,
      title: this.store.resolveSessionListTitle(session.id),
    }));
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.store.getSession(sessionId);
  }

  getSessionState(sessionId: string): SessionStateSnapshot {
    return this.store.getSessionState(sessionId);
  }

  listMessages(
    sessionId: string,
    input?: ListMessagesQuery,
  ): SessionMessageRecord[] {
    return this.store.listMessages(sessionId, input);
  }

  listMessageParts(
    sessionId: string,
    input?: ListMessagePartsQuery,
  ): SessionMessagePartRecord[] {
    return this.store.listMessageParts(sessionId, input);
  }
}
