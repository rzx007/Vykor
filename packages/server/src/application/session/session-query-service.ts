import type {
  ListMessagePartsOptions,
  ListMessagesOptions,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionStateSnapshot,
  SearchSessionsOptions,
  SessionSearchResult,
} from "@vykor/protocol";
import { isCommittedPublicTextPart } from "../../session/transcript-text.js";

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

  searchSessions(input: SearchSessionsOptions): SessionSearchResult[] {
    const query = input.query.trim();
    if (!query || query.length > 256) return [];
    const tokens = query.toLowerCase().split(/\s+/);
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit || 30)));
    const results: SessionSearchResult[] = [];
    // ponytail: 按需扫描历史正文；历史量导致延迟时再换成全文索引。
    const sessions = this.store
      .listSessions({ includeArchived: true })
      .filter((session) => !session.parentId && session.storage !== "memory")
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const session of sessions) {
      const textByMessage = new Map<string, string[]>();
      for (const part of this.store.listMessageParts(session.id)) {
        if (!isCommittedPublicTextPart(part) || !part.text) continue;
        const texts = textByMessage.get(part.messageId) ?? [];
        texts.push(part.text);
        textByMessage.set(part.messageId, texts);
      }
      const messages = this.store
        .listMessages(session.id)
        .sort((a, b) => b.seq - a.seq);
      for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = (textByMessage.get(message.id) ?? [])
          .join("\n")
          .replace(/\s+/g, " ");
        const lower = text.toLowerCase();
        if (!tokens.every((token) => lower.includes(token))) continue;
        const match = Math.min(...tokens.map((token) => lower.indexOf(token)));
        const start = Math.max(0, match - 60);
        const end = Math.min(text.length, start + 200);
        results.push({
          session: {
            ...session,
            title: this.store.resolveSessionListTitle(session.id),
          },
          messageId: message.id,
          snippet:
            (start > 0 ? "…" : "") +
            text.slice(start, end) +
            (end < text.length ? "…" : ""),
        });
        break;
      }
      if (results.length >= limit) break;
    }
    return results;
  }

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
