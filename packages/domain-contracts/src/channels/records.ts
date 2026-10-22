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
