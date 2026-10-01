import type { FeishuChannelConfig } from "@vykor/auth";
import type { InboundMessage } from "@vykor/channels";
import type { Settings } from "@vykor/core";
import type {
  ChannelConnectorRuntimeStatus,
  ChannelDeliveryRecord,
  DurableChannelMessageInput,
  DurableChannelMessageResult,
  RecordChannelDeliveryInput,
} from "@vykor/protocol";
import type { ObservabilityEvent } from "../shared/observability.js";

/** Application operations used by the daemon's channel connector. */
export interface ChannelRuntimeApplicationPort {
  handleMessage(input: DurableChannelMessageInput): Promise<DurableChannelMessageResult>;
  pendingDeliveries(options?: {
    connector?: string;
    limit?: number;
  }): Promise<ChannelDeliveryRecord[]>;
  recordDelivery(
    id: string,
    input: RecordChannelDeliveryInput,
  ): Promise<ChannelDeliveryRecord>;
}

export interface ChannelAttachmentDownload {
  stream: ReadableStream<Uint8Array>;
  name?: string;
  mimeType?: string;
}

export interface ChannelAttachmentDownloadInput {
  messageId: string;
  type: "image" | "file";
  externalId: string;
  name?: string;
  signal?: AbortSignal;
}

export interface ConnectorRuntimeHandle {
  start(): Promise<void>;
  stopInbound(): Promise<void>;
  stopBridge(options?: { drainTimeoutMs?: number }): Promise<void>;
  stop(): Promise<void>;
  downloadAttachment?(input: ChannelAttachmentDownloadInput): Promise<ChannelAttachmentDownload | undefined>;
}

export interface CreateConnectorRuntimeInput {
  connector: string;
  config: FeishuChannelConfig;
  application: ChannelRuntimeApplicationPort;
  model: string;
  /** The manager and runtime share this reference so ACL changes take effect immediately. */
  acl: { allowFrom: string[] };
  policy: { sendProgress?: boolean; sendToolHints?: boolean };
  resolveCwd(message: InboundMessage): Promise<string>;
  onDenied(info: { channel: string; sender: string; chatId: string }): void;
  onDeliveryResult(result: {
    deliveryId: string;
    status: "sent" | "failed" | "unknown";
    error?: string;
  }): Promise<void> | void;
}

export interface ChannelRuntimeServiceOptions {
  application: ChannelRuntimeApplicationPort;
  config: { getFeishu(): Promise<FeishuChannelConfig | undefined> };
  getSettings(): Settings | undefined;
  createRuntime?(input: CreateConnectorRuntimeInput): Promise<ConnectorRuntimeHandle>;
  verify?(input: {
    appId: string;
    appSecret: string;
    domain: "feishu" | "lark";
  }): Promise<{ name?: string }>;
  workspaceRoot?: string;
  drainTimeoutMs?: number;
  connectTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  logger?(event: ObservabilityEvent): void;
  now?(): number;
}

export type ChannelRuntimeErrorCode =
  | "unknown_connector"
  | "not_configured"
  | "not_enabled"
  | "closed";

export interface ConnectorEntry {
  config: FeishuChannelConfig | undefined;
  fingerprint: string;
  acl: { allowFrom: string[] };
  policy: { sendProgress?: boolean; sendToolHints?: boolean };
  status: ChannelConnectorRuntimeStatus;
  lane: Promise<void>;
  handle: ConnectorRuntimeHandle | null;
}
