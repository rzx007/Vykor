import { eq, inArray, placeholder, sql } from "drizzle-orm";
import type { ChatPersistence } from "./chat-persistence.js";
import type { SessionDatabase } from "./session-database.js";
import type { SessionState } from "../session-runtime/store-state.js";
import type { MutationBuffer } from "./mutation-buffer.js";
import { persistSessionChanges } from "../session-runtime/store-persistence.js";
import { loadSessionReadModel } from "./read-model.js";
import type { DurableEventRegistry } from "../session-runtime/event-registry.js";
import {
  sessions, sessionInputs, sessionMessages, sessionMessageParts, sessionRuns,
  sessionRunAttempts, sessionTasks, sessionEvents, permissionRequests, scheduledRuns, scheduledTasks,
} from "../session-runtime/schema.js";

/** Only this implementation translates chat changes into Drizzle database writes. */
export class SqliteChatPersistence implements ChatPersistence {
  constructor(private readonly database: SessionDatabase) {}

  load(eventRegistry: DurableEventRegistry): SessionState {
    return loadSessionReadModel(this.database.orm, eventRegistry).state;
  }

  commit(state: SessionState, mutations: MutationBuffer): void {
    persistSessionChanges({ database: this.database, state, mutations });
  }

  checkpoint(state: SessionState, partIds: string[]): void {
    const database = this.database.orm;
    const updatePart = database.update(sessionMessageParts).set({
      text: sql`${placeholder("text")}`, updatedAt: sql`${placeholder("updatedAt")}`,
    }).where(eq(sessionMessageParts.id, placeholder("id"))).prepare();
    const updateMessage = database.update(sessionMessages).set({ updatedAt: sql`${placeholder("updatedAt")}` })
      .where(eq(sessionMessages.id, placeholder("id"))).prepare();
    const updateSession = database.update(sessions).set({ updatedAt: sql`${placeholder("updatedAt")}` })
      .where(eq(sessions.id, placeholder("id"))).prepare();
    const messageIds = new Set<string>();
    const sessionIds = new Set<string>();
    for (const id of partIds) {
      const part = state.parts[id];
      if (!part) continue;
      updatePart.run({ text: part.text ?? "", updatedAt: part.updatedAt, id });
      messageIds.add(part.messageId);
      sessionIds.add(part.sessionId);
    }
    for (const id of messageIds) { const row = state.messages[id]; if (row) updateMessage.run({ updatedAt: row.updatedAt, id }); }
    for (const id of sessionIds) { const row = state.sessions[id]; if (row) updateSession.run({ updatedAt: row.updatedAt, id }); }
  }

  deleteSessions(sessionIds: string[]): void {
    const database = this.database.orm;
    const timestamp = Date.now();
    database.update(scheduledRuns).set({ sessionId: null, updatedAt: timestamp }).where(inArray(scheduledRuns.sessionId, sessionIds)).run();
    database.update(scheduledTasks).set({
      status: sql`CASE WHEN ${scheduledTasks.destination} = 'chat' THEN 'paused' ELSE ${scheduledTasks.status} END`,
      nextRunAt: sql`CASE WHEN ${scheduledTasks.destination} = 'chat' THEN NULL ELSE ${scheduledTasks.nextRunAt} END`,
      sessionId: null, updatedAt: timestamp,
    }).where(inArray(scheduledTasks.sessionId, sessionIds)).run();
    database.update(scheduledTasks).set({ createdFromSessionId: null, updatedAt: timestamp })
      .where(inArray(scheduledTasks.createdFromSessionId, sessionIds)).run();
    database.delete(permissionRequests).where(inArray(permissionRequests.sessionId, sessionIds)).run();
    database.delete(sessionTasks).where(inArray(sessionTasks.sessionId, sessionIds)).run();
    database.delete(sessionRunAttempts).where(inArray(sessionRunAttempts.runId,
      database.select({ id: sessionRuns.id }).from(sessionRuns).where(inArray(sessionRuns.sessionId, sessionIds)),
    )).run();
    database.delete(sessionRuns).where(inArray(sessionRuns.sessionId, sessionIds)).run();
    database.delete(sessionMessageParts).where(inArray(sessionMessageParts.sessionId, sessionIds)).run();
    database.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds)).run();
    database.delete(sessionInputs).where(inArray(sessionInputs.sessionId, sessionIds)).run();
    database.delete(sessionEvents).where(inArray(sessionEvents.sessionId, sessionIds)).run();
    database.delete(sessions).where(inArray(sessions.id, sessionIds)).run();
  }
}
