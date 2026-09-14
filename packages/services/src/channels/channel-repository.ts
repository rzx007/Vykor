import { randomUUID } from "node:crypto";

import type {
  ChannelDeliveryRecord,
  ChannelDeliveryStatus,
  ExternalConversationRecord,
} from "@openharness/protocol";

import type { StorageContext } from "../database/storage-context.js";
import {
  channelDeliveryFromRow,
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
}

export interface UpdateChannelDeliveryInput {
  status: Extract<ChannelDeliveryStatus, "sent" | "failed" | "unknown">;
  externalDeliveryId?: string;
  error?: string;
}

export class ChannelRepository {
  constructor(private readonly storage: StorageContext) {}

  findConversation(input: ExternalConversationKey): ExternalConversationRecord | undefined {
    const row = this.storage.database.connection
      .prepare(
        `SELECT * FROM external_conversation
         WHERE connector = ? AND account_id = ? AND chat_id = ? AND thread_id = ?`,
      )
      .get(input.connector, input.accountId, input.chatId, input.threadId ?? "") as
      | Record<string, unknown>
      | undefined;
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
    this.storage.database.connection
      .prepare(
        `INSERT INTO external_conversation
          (id, connector, account_id, workspace_id, chat_id, thread_id, session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(connector, account_id, chat_id, thread_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           session_id = excluded.session_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.connector,
        input.accountId,
        input.workspaceId ?? null,
        input.chatId,
        input.threadId ?? "",
        input.sessionId,
        existing?.createdAt ?? timestamp,
        timestamp,
      );
    return this.findConversation(input)!;
  }

  listConversations(options: { connector?: string; limit?: number } = {}): ExternalConversationRecord[] {
    const rows = this.storage.database.connection
      .prepare(
        `SELECT * FROM external_conversation
         ${options.connector ? "WHERE connector = ?" : ""}
         ORDER BY updated_at DESC
         ${options.limit !== undefined ? "LIMIT ?" : ""}`,
      )
      .all(
        ...(options.connector ? [options.connector] : []),
        ...(options.limit !== undefined ? [options.limit] : []),
      ) as Array<Record<string, unknown>>;
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
    this.storage.database.connection
      .prepare(
        `INSERT INTO channel_delivery
          (id, conversation_id, connector, account_id, chat_id, thread_id,
           session_id, input_id, run_id, external_message_id, content, status,
           attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.connector,
        input.accountId,
        input.chatId,
        input.threadId ?? "",
        input.sessionId,
        input.inputId,
        input.runId,
        input.externalMessageId,
        input.content,
        timestamp,
        timestamp,
      );
    return this.getDelivery(id)!;
  }

  getDelivery(id: string): ChannelDeliveryRecord | undefined {
    const row = this.storage.database.connection
      .prepare("SELECT * FROM channel_delivery WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? channelDeliveryFromRow(row) : undefined;
  }

  findDeliveryByInput(inputId: string): ChannelDeliveryRecord | undefined {
    const row = this.storage.database.connection
      .prepare("SELECT * FROM channel_delivery WHERE input_id = ?")
      .get(inputId) as Record<string, unknown> | undefined;
    return row ? channelDeliveryFromRow(row) : undefined;
  }

  updateDelivery(id: string, input: UpdateChannelDeliveryInput): ChannelDeliveryRecord {
    this.storage.assertWritable();
    const existing = this.getDelivery(id);
    if (!existing) throw new Error(`Channel delivery not found: ${id}`);
    const timestamp = Date.now();
    this.storage.database.connection
      .prepare(
        `UPDATE channel_delivery SET status = ?, attempt_count = attempt_count + ?,
          external_delivery_id = ?, error = ?, updated_at = ?, sent_at = ? WHERE id = ?`,
      )
      .run(
        input.status,
        input.status === "unknown" ? 1 : 0,
        input.externalDeliveryId ?? existing.externalDeliveryId ?? null,
        input.error ?? null,
        timestamp,
        input.status === "sent" ? timestamp : (existing.sentAt ?? null),
        id,
      );
    return this.getDelivery(id)!;
  }

  listDeliveries(
    options: { statuses?: ChannelDeliveryStatus[]; connector?: string; limit?: number } = {},
  ): ChannelDeliveryRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (options.statuses?.length) {
      clauses.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
      values.push(...options.statuses);
    }
    if (options.connector) {
      clauses.push("connector = ?");
      values.push(options.connector);
    }
    const rows = this.storage.database.connection
      .prepare(
        `SELECT * FROM channel_delivery
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY updated_at DESC
         ${options.limit !== undefined ? "LIMIT ?" : ""}`,
      )
      .all(...values, ...(options.limit !== undefined ? [options.limit] : [])) as Array<
      Record<string, unknown>
    >;
    return rows.map(channelDeliveryFromRow);
  }
}
