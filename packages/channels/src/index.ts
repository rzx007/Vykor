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
  onMessage(handler: (message: ChannelMessage) => void | Promise<void>): void;
}

export { EventBus } from "./bus";
export { MessageBus } from "./bus/queue";
export type { InboundMessage, OutboundMessage } from "./bus/queue";
export { isAllowed } from "./bus/acl";
export { ChannelManager } from "./core/manager";
export type { ChannelManagerOptions, ChannelStatus } from "./core/manager";
export { StdioAdapter } from "./adapters/stdio/stdio";
export { HttpAdapter } from "./adapters/http/http";
export { FeishuAdapter } from "./adapters/feishu/feishu";
export type { FeishuConfig } from "./adapters/feishu/feishu";
export { FeishuRegistration, FEISHU_ONBOARDING_TENANT_SCOPES } from "./adapters/feishu/feishu-registration";
export type {
  FeishuRegistrationState,
  FeishuRegistrationStatus,
  FeishuRegistrationCredentials,
} from "./adapters/feishu/feishu-registration";
export { verifyFeishuCredentials } from "./adapters/feishu/feishu-verify";
export type { VerifiedFeishuBot } from "./adapters/feishu/feishu-verify";
