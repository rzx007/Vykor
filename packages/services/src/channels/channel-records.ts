import type {
  ChannelDeliveryRecord,
  ChannelDeliveryStatus,
  ExternalConversationRecord,
} from "@vykor/protocol";
import type { channelDeliveries, externalConversations } from "../session-runtime/schema.js";

export function externalConversationFromRow(
  row: typeof externalConversations.$inferSelect,
): ExternalConversationRecord {
  return {
    id: row.id,
    connector: row.connector,
    accountId: row.accountId,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    chatId: row.chatId,
    ...(row.threadId ? { threadId: row.threadId } : {}),
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function channelDeliveryFromRow(
  row: typeof channelDeliveries.$inferSelect,
): ChannelDeliveryRecord {
  const platformMeta = row.platformMetaJson
    ? decodePlatformMeta(row.platformMetaJson)
    : undefined;
  return {
    id: row.id,
    conversationId: row.conversationId,
    connector: row.connector,
    accountId: row.accountId,
    chatId: row.chatId,
    ...(row.threadId ? { threadId: row.threadId } : {}),
    ...(platformMeta ? { platformMeta } : {}),
    sessionId: row.sessionId,
    inputId: row.inputId,
    runId: row.runId,
    externalMessageId: row.externalMessageId,
    content: row.content,
    status: row.status as ChannelDeliveryStatus,
    attemptCount: row.attemptCount,
    ...(row.externalDeliveryId
      ? { externalDeliveryId: row.externalDeliveryId }
      : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
  };
}

export function encodePlatformMeta(
  value: Record<string, unknown> | undefined,
  onWarning?: (message: string) => void,
): string | null {
  if (!value) return null;
  try {
    const normalized = JSON.parse(JSON.stringify(value)) as unknown;
    if (
      !normalized ||
      typeof normalized !== "object" ||
      Array.isArray(normalized) ||
      Object.keys(normalized as Record<string, unknown>).length === 0
    ) {
      return null;
    }
    return JSON.stringify(normalized);
  } catch {
    onWarning?.("channel delivery platformMeta could not be normalized; storing null");
    return null;
  }
}

export function decodePlatformMeta(
  value: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed as Record<string, unknown>).length === 0
    ) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
