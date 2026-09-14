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
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    connector: row.connector as string,
    accountId: row.account_id as string,
    chatId: row.chat_id as string,
    ...(row.thread_id ? { threadId: row.thread_id as string } : {}),
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
