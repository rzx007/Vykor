import type {
  ChannelDeliveryRecord,
  ChannelDeliveryStatus,
  ExternalConversationRecord,
} from "@openharness/protocol";

export function externalConversationFromRow(
  row: Record<string, unknown>,
): ExternalConversationRecord {
  return {
    id: row.id as string,
    connector: row.connector as string,
    accountId: row.account_id as string,
    ...(row.workspace_id ? { workspaceId: row.workspace_id as string } : {}),
    chatId: row.chat_id as string,
    ...(row.thread_id ? { threadId: row.thread_id as string } : {}),
    sessionId: row.session_id as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function channelDeliveryFromRow(
  row: Record<string, unknown>,
): ChannelDeliveryRecord {
  const platformMeta = row.platform_meta_json
    ? decodePlatformMeta(row.platform_meta_json as string)
    : undefined;
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    connector: row.connector as string,
    accountId: row.account_id as string,
    chatId: row.chat_id as string,
    ...(row.thread_id ? { threadId: row.thread_id as string } : {}),
    ...(platformMeta ? { platformMeta } : {}),
    sessionId: row.session_id as string,
    inputId: row.input_id as string,
    runId: row.run_id as string,
    externalMessageId: row.external_message_id as string,
    content: row.content as string,
    status: row.status as ChannelDeliveryStatus,
    attemptCount: row.attempt_count as number,
    ...(row.external_delivery_id
      ? { externalDeliveryId: row.external_delivery_id as string }
      : {}),
    ...(row.error ? { error: row.error as string } : {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    ...(row.sent_at ? { sentAt: row.sent_at as number } : {}),
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
