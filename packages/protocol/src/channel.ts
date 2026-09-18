export type ChannelDeliveryStatus = "pending" | "sent" | "failed" | "unknown";

export interface ExternalConversationRecord {
  id: string;
  connector: string;
  accountId: string;
  workspaceId?: string;
  chatId: string;
  threadId?: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelDeliveryRecord {
  id: string;
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
  status: ChannelDeliveryStatus;
  attemptCount: number;
  externalDeliveryId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  sentAt?: number;
  platformMeta?: Record<string, unknown>;
}

export interface DurableChannelMessageInput {
  connector: string;
  accountId: string;
  workspaceId?: string;
  chatId: string;
  threadId?: string;
  externalMessageId: string;
  senderId: string;
  content: string;
  cwd: string;
  model: string;
  metadata?: Record<string, unknown>;
  platformMeta?: Record<string, unknown>;
}

export interface DurableChannelMessageResult {
  conversation: ExternalConversationRecord;
  delivery: ChannelDeliveryRecord;
  duplicate: boolean;
}

export interface RecordChannelDeliveryInput {
  status: Extract<ChannelDeliveryStatus, "sent" | "failed" | "unknown">;
  externalDeliveryId?: string;
  error?: string;
}

export interface ChannelStatusSnapshot {
  conversations: ExternalConversationRecord[];
  deliveries: ChannelDeliveryRecord[];
}

/** 同一个平台消息在所有重试中得到同一个 durable Input id。 */
export function durableChannelInputId(input: {
  connector: string;
  accountId: string;
  externalMessageId: string;
}): string {
  return ["channel", input.connector, input.accountId, input.externalMessageId]
    .map((part) => encodeURIComponent(part.trim()))
    .join(":");
}

export function parseDurableChannelMessageInput(
  value: unknown,
): DurableChannelMessageInput {
  const row = record(value);
  const platformMeta = optionalObject(row, "platformMeta");
  return {
    connector: required(row, "connector"),
    accountId: required(row, "accountId"),
    ...(optional(row, "workspaceId") ? { workspaceId: optional(row, "workspaceId") } : {}),
    chatId: required(row, "chatId"),
    ...(optional(row, "threadId") ? { threadId: optional(row, "threadId") } : {}),
    externalMessageId: required(row, "externalMessageId"),
    senderId: required(row, "senderId"),
    content: required(row, "content"),
    cwd: required(row, "cwd"),
    model: required(row, "model"),
    ...(row.metadata !== undefined
      ? { metadata: record(row.metadata, "metadata") }
      : {}),
    ...(platformMeta ? { platformMeta } : {}),
  };
}

export function parseRecordChannelDeliveryInput(
  value: unknown,
): RecordChannelDeliveryInput {
  const row = record(value);
  if (row.status !== "sent" && row.status !== "failed" && row.status !== "unknown") {
    throw new Error("status must be sent, failed or unknown");
  }
  return {
    status: row.status,
    ...(optional(row, "externalDeliveryId")
      ? { externalDeliveryId: optional(row, "externalDeliveryId") }
      : {}),
    ...(optional(row, "error") ? { error: optional(row, "error") } : {}),
  };
}

function record(value: unknown, field = "request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function required(row: Record<string, unknown>, field: string): string {
  const value = optional(row, field);
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function optional(row: Record<string, unknown>, field: string): string | undefined {
  const value = row[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * 只接受非空普通对象；undefined 视为缺失，null/数组/标量抛错。
 * 空对象按缺失处理。
 */
function optionalObject(
  row: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = row[field];
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const object = value as Record<string, unknown>;
  return Object.keys(object).length > 0 ? object : undefined;
}
