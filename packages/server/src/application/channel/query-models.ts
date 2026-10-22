/** Connector facts and application results; no transport dependency. */
export type ChannelRuntimeState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export type ChannelDomain = "feishu" | "lark";

export interface ChannelConnectorRuntimeStatus {
  connector: string;
  enabled: boolean;
  state: ChannelRuntimeState;
  accountId?: string;
  domain?: ChannelDomain;
  botName?: string;
  startedAt?: number;
  lastError?: string;
}

export interface ChannelDenialNotice {
  connector: string;
  sender: string;
  chatId: string;
  at: number;
  seq: number;
}

export interface ChannelRuntimeStatus {
  bootId: string;
  connectors: ChannelConnectorRuntimeStatus[];
  recentDenials: ChannelDenialNotice[];
}

export interface FeishuChannelSnapshot {
  configured: boolean;
  enabled: boolean;
  appId?: string;
  domain?: ChannelDomain;
  botName?: string;
  allowFrom: Array<{ name: string; id: string }>;
  replyAtBotNames?: string[];
  sendProgress?: boolean;
  sendToolHints?: boolean;
}

export type FeishuRegistrationState =
  | "idle"
  | "starting"
  | "qr_ready"
  | "polling"
  | "slow_down"
  | "domain_switched"
  | "succeeded"
  | "expired"
  | "cancelled"
  | "error";

export interface FeishuRegistrationSnapshot {
  state: FeishuRegistrationState;
  attempt: number;
  domain: ChannelDomain;
  qrUrl?: string;
  expiresAt?: number;
  remainingSeconds?: number;
  pollIntervalMs?: number;
  error?: { code: string; message: string };
  warning?: string;
}

export interface ChannelRuntimeControlInput {
  connector?: string;
}

export interface FeishuConnectInput {
  appId: string;
  appSecret: string;
  domain?: ChannelDomain;
}

export interface FeishuAllowInput {
  id: string;
  name?: string;
}

export interface FeishuPatchInput {
  enabled?: boolean;
  sendProgress?: boolean;
  sendToolHints?: boolean;
}

export interface FeishuRegistrationStartInput {
  domain?: ChannelDomain;
}
import type { ExternalConversationRecord, ChannelDeliveryRecord, ChannelDeliveryStatus } from "@vykor/domain-contracts/channels";
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
