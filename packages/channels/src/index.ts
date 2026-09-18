export type ChannelCapability =
  | "text"
  | "image"
  | "file"
  | "rich-card"
  | "stream"
  | "mentions"
  | "threaded-conversation"
  | "group-chat"
  | "private-chat"
  | "delivery-status"
  | "acknowledgement"
  | "bot-skip-filter";

export interface ChannelAttachment {
  type: "image" | "file" | "audio" | "video" | "unknown";
  name?: string;
  mimeType?: string;
  url?: string;
  data?: Uint8Array | string;
  sizeBytes?: number;
  externalId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelAdapterCapabilities {
  supports: ChannelCapability[];
  maxTextLength?: number;
  supportsStreaming?: boolean;
  supportsFiles?: boolean;
  supportsImages?: boolean;
  supportsRichCards?: boolean;
  requiresMentionForGroupReply?: boolean;
}

export interface ChannelMessage {
  id: string;
  channel: string;
  sender: string;
  content: string;
  timestamp: Date;
  /**
   * Unified business conversation identity, platform-neutral.
   */
  conversationId?: string;
  /**
   * Platform-specific conversation target used for outbound replies.
   */
  chatId?: string;
  /** Conversation/reply target for outbound replies. */
  replyTo?: string;
  threadId?: string;
  externalMessageId?: string;
  senderType?: "user" | "bot" | "system" | "unknown";
  messageType?: "text" | "image" | "file" | "card" | "event" | "unknown";
  attachments?: ChannelAttachment[];
  workspaceId?: string;
  metadata?: Record<string, unknown>;
  platformMeta?: Record<string, unknown>;
}

export interface ChannelAdapter {
  name: string;
  capabilities?: ChannelAdapterCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: ChannelMessage): Promise<void>;
  onMessage(handler: (message: ChannelMessage) => void): void;
}

export { EventBus } from "./bus";
export { MessageBus } from "./bus/queue";
export type { InboundMessage, OutboundMessage } from "./bus/queue";
export { isAllowed } from "./bus/acl";
export { ChannelManager } from "./core/manager";
export type { ChannelManagerOptions, ChannelStatus } from "./core/manager";
export { DurableChannelBridge } from "./core/durable-bridge";
export type { DurableChannelPort } from "./core/durable-bridge";
export { StdioAdapter } from "./impl/stdio";
export { HttpAdapter } from "./impl/http";
export { FeishuAdapter } from "./impl/feishu";
export type { FeishuConfig } from "./impl/feishu";
