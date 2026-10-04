import { randomUUID } from "node:crypto";

import type {
  ChannelDeliveryRecord,
  ChannelDeliveryStatus,
  ExternalConversationRecord,
} from "@vykor/protocol";
import { and, desc, eq, inArray, placeholder, sql } from "drizzle-orm";

import type { StorageContext } from "../database/storage-context.js";
import { channelDeliveries, externalConversations } from "../session-runtime/schema.js";
import {
  channelDeliveryFromRow,
  encodePlatformMeta,
  externalConversationFromRow,
} from "./channel-records.js";

export interface ExternalConversationKey {
  connector: string;
  accountId: string;
  chatId: string;
  threadId?: string;
}

export interface UpsertExternalConversationInput extends ExternalConversationKey {
  id?: string;
  workspaceId?: string;
  sessionId: string;
}

export interface CreateChannelDeliveryInput {
  id?: string;
  conversationId: string;
  connector: string;
  accountId: string;
  chatId: string;
  threadId?: string;
  sessionId: string;
  inputId: string;
  runId: string;
  externalMessageId: string;
  content: string;
  platformMeta?: Record<string, unknown>;
}

export interface UpdateChannelDeliveryInput {
  status: Extract<ChannelDeliveryStatus, "sent" | "failed" | "unknown">;
  externalDeliveryId?: string;
  error?: string;
}

export class ChannelRepository {
  constructor(private readonly storage: StorageContext) {}

  findConversation(input: ExternalConversationKey): ExternalConversationRecord | undefined {
    const row = this.storage.database.orm.select().from(externalConversations)
      .where(and(
        eq(externalConversations.connector, input.connector),
        eq(externalConversations.accountId, input.accountId),
        eq(externalConversations.chatId, input.chatId),
        eq(externalConversations.threadId, input.threadId ?? ""),
      ))
      .get();
    return row ? externalConversationFromRow(row) : undefined;
  }

  upsertConversation(input: UpsertExternalConversationInput): ExternalConversationRecord {
    this.storage.assertWritable();
    if (!this.storage.state.sessions[input.sessionId]) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }
    const existing = this.findConversation(input);
    const timestamp = Date.now();
    const id = existing?.id ?? input.id ?? randomUUID();
    this.storage.database.orm.insert(externalConversations).values({
      id,
      connector: input.connector,
      accountId: input.accountId,
      workspaceId: input.workspaceId ?? null,
      chatId: input.chatId,
      threadId: input.threadId ?? "",
      sessionId: input.sessionId,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }).onConflictDoUpdate({
      target: [externalConversations.connector, externalConversations.accountId,
        externalConversations.chatId, externalConversations.threadId],
      set: { workspaceId: input.workspaceId ?? null, sessionId: input.sessionId, updatedAt: timestamp },
    }).run();
    return this.findConversation(input)!;
  }

  listConversations(options: { connector?: string; limit?: number } = {}): ExternalConversationRecord[] {
    const query = this.storage.database.orm.select().from(externalConversations)
      .where(options.connector ? eq(externalConversations.connector, options.connector) : undefined)
      .orderBy(desc(externalConversations.updatedAt));
    const rows = options.limit === undefined
      ? query.all()
      : query.limit(placeholder("limit")).all({ limit: options.limit });
    return rows.map(externalConversationFromRow);
  }

  createDelivery(input: CreateChannelDeliveryInput): ChannelDeliveryRecord {
    this.storage.assertWritable();
    const existing = this.findDeliveryByInput(input.inputId);
    if (existing) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.runId !== input.runId ||
        existing.content !== input.content
      ) {
        throw new Error(`Channel delivery input is already used: ${input.inputId}`);
      }
      return existing;
    }
    const timestamp = Date.now();
    const id = input.id ?? randomUUID();
    const platformMetaJson = encodePlatformMeta(input.platformMeta, (message) => console.warn(message));
    this.storage.database.orm.insert(channelDeliveries).values({
      id,
      conversationId: input.conversationId,
      connector: input.connector,
      accountId: input.accountId,
      chatId: input.chatId,
      threadId: input.threadId ?? "",
      sessionId: input.sessionId,
      inputId: input.inputId,
      runId: input.runId,
      externalMessageId: input.externalMessageId,
      content: input.content,
      status: "pending",
      attemptCount: 0,
      platformMetaJson,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    return this.getDelivery(id)!;
  }

  getDelivery(id: string): ChannelDeliveryRecord | undefined {
    const row = this.storage.database.orm.select().from(channelDeliveries)
      .where(eq(channelDeliveries.id, id)).get();
    return row ? channelDeliveryFromRow(row) : undefined;
  }

  findDeliveryByInput(inputId: string): ChannelDeliveryRecord | undefined {
    const row = this.storage.database.orm.select().from(channelDeliveries)
      .where(eq(channelDeliveries.inputId, inputId)).get();
    return row ? channelDeliveryFromRow(row) : undefined;
  }

  updateDelivery(id: string, input: UpdateChannelDeliveryInput): ChannelDeliveryRecord {
    this.storage.assertWritable();
    const existing = this.getDelivery(id);
    if (!existing) throw new Error(`Channel delivery not found: ${id}`);
    const timestamp = Date.now();
    this.storage.database.orm.update(channelDeliveries).set({
      status: input.status,
      attemptCount: sql`${channelDeliveries.attemptCount} + ${input.status === "unknown" ? 1 : 0}`,
      externalDeliveryId: input.externalDeliveryId ?? existing.externalDeliveryId ?? null,
      error: input.error ?? null,
      updatedAt: timestamp,
      sentAt: input.status === "sent" ? timestamp : (existing.sentAt ?? null),
    }).where(eq(channelDeliveries.id, id)).run();
    return this.getDelivery(id)!;
  }

  listDeliveries(
    options: { statuses?: ChannelDeliveryStatus[]; connector?: string; limit?: number } = {},
  ): ChannelDeliveryRecord[] {
    const query = this.storage.database.orm.select().from(channelDeliveries)
      .where(and(
        options.statuses?.length ? inArray(channelDeliveries.status, options.statuses) : undefined,
        options.connector ? eq(channelDeliveries.connector, options.connector) : undefined,
      ))
      .orderBy(desc(channelDeliveries.updatedAt));
    const rows = options.limit === undefined
      ? query.all()
      : query.limit(placeholder("limit")).all({ limit: options.limit });
    return rows.map(channelDeliveryFromRow);
  }
}
