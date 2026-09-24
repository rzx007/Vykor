import {
  durableChannelInputId,
  type AdmitPromptAttachmentInput,
  type ChannelDeliveryRecord,
  type ChannelStatusSnapshot,
  type DurableChannelMessageInput,
  type DurableChannelMessageResult,
  type ExternalConversationRecord,
  type RecordChannelDeliveryInput,
  type SessionInputRecord,
  type SessionRecord,
} from "@vykor/protocol";

import { ApplicationError } from "../../shared/application-error.js";
import type { ObservabilityEvent } from "../../shared/observability.js";
import { channelConnectorLabel } from "./channel-connector-labels.js";
import type { ChannelAttachmentDownload } from "../../daemon/channel-runtime-service.js";
import type { SessionCommandService } from "../session/session-command-service.js";
import type { SessionInteractionService } from "../session/session-interaction-service.js";
import type { RunControlService } from "../session/run-control-service.js";

export interface ChannelSessionQueries {
  getInput(inputId: string): SessionInputRecord | undefined;
  getSession(sessionId: string): SessionRecord | undefined;
}

export interface ChannelOperations {
  findConversation(input: DurableChannelMessageInput): ExternalConversationRecord | undefined;
  upsertConversation(input: {
    id?: string;
    connector: string;
    accountId: string;
    workspaceId?: string;
    chatId: string;
    threadId?: string;
    sessionId: string;
  }): ExternalConversationRecord;
  createDelivery(input: {
    conversationId: string;
    connector: string;
    accountId: string;
    chatId: string;
    threadId?: string;
    sessionId: string;
    inputId: string;
    runId: string;
    externalMessageId?: string;
    content: string;
    platformMeta?: Record<string, unknown>;
  }): ChannelDeliveryRecord;
  getDelivery(deliveryId: string): ChannelDeliveryRecord | undefined;
  updateDelivery(deliveryId: string, input: RecordChannelDeliveryInput): ChannelDeliveryRecord;
  listConversations(options?: { connector?: string; limit?: number }): ExternalConversationRecord[];
  listDeliveries(options?: {
    connector?: string;
    limit?: number;
    statuses?: Array<ChannelDeliveryRecord["status"]>;
  }): ChannelDeliveryRecord[];
}

export interface ChannelApplicationServiceContext {
  sessionQueries: ChannelSessionQueries;
  channels: ChannelOperations;
  sessionCommands: Pick<SessionCommandService, "createSession">;
  sessionInteractions: Pick<SessionInteractionService, "admitPrompt">;
  runControl: Pick<RunControlService, "awaitRun">;
  log(event: ObservabilityEvent): void;
  attachments: Pick<AttachmentImportPort, "import">;
  inboundAttachmentTimeoutMs?: number;
  downloadChannelAttachment(
    messageId: string,
    attachment: { type: "image" | "file"; externalId: string; name?: string },
    signal?: AbortSignal,
  ): Promise<ChannelAttachmentDownload | undefined> | ChannelAttachmentDownload | undefined;
}

/** 入站附件导入端口；只需 import。 */
export interface AttachmentImportPort {
  import(input: {
    displayName: string;
    declaredMediaType?: string;
    content: ReadableStream<Uint8Array>;
    signal?: AbortSignal;
  }): Promise<{ id: string }>;
}

const INBOUND_ATTACHMENT_TYPES = new Set(["image", "file"]);

/** 从 metadata.attachments 里只取可信字段；忽略 data/url，绝不自行 fetch。 */
function readInboundAttachments(
  metadata: Record<string, unknown> | undefined,
): Array<{ type: "image" | "file"; externalId: string; name?: string }> {
  const raw = metadata?.["attachments"];
  if (!Array.isArray(raw)) return [];
  const result: Array<{ type: "image" | "file"; externalId: string; name?: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const type = candidate["type"];
    const externalId = candidate["externalId"];
    if (typeof type !== "string" || !INBOUND_ATTACHMENT_TYPES.has(type)) continue;
    if (typeof externalId !== "string" || !externalId.trim()) continue;
    const name = candidate["name"];
    result.push({
      type: type as "image" | "file",
      externalId: externalId.trim(),
      ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
    });
  }
  return result;
}

/** 外部聊天消息进入 durable Session/Run 的唯一应用入口。 */
export class ChannelApplicationService {
  private readonly conversationLanes = new Map<string, Promise<void>>();
  private readonly sessionQueries: ChannelSessionQueries;

  constructor(private readonly context: ChannelApplicationServiceContext) {
    this.sessionQueries = context.sessionQueries;
  }

  async handleMessage(
    input: DurableChannelMessageInput,
  ): Promise<DurableChannelMessageResult> {
    const conversationKey = JSON.stringify([
      input.connector,
      input.accountId,
      input.chatId,
      input.threadId ?? "",
    ]);
    return this.withConversationLane(conversationKey, () =>
      this.handleMessageInLane(input),
    );
  }

  private async handleMessageInLane(
    input: DurableChannelMessageInput,
  ): Promise<DurableChannelMessageResult> {
    const inputId = durableChannelInputId(input);
    const existedBefore = Boolean(this.sessionQueries.getInput(inputId));
    const conversation = this.resolveConversation(input);
    const attachments = await this.resolveInboundAttachments(input, inputId);
    let admission;
    try {
      admission = await this.context.sessionInteractions.admitPrompt(
        conversation.sessionId,
        {
          id: inputId,
          // 空正文（图片/文件消息）不要塞空 text item：它会被归一化丢弃，
          // 导致重投递时 items 与首次存储不一致 → 误判 prompt_id_conflict。
          items: input.content
            ? [{ type: "text", text: input.content }]
            : [],
          delivery: "queue",
          ...(attachments.length > 0 ? { attachments } : {}),
          metadata: {
            source: "channel",
            channel: {
              connector: input.connector,
              accountId: input.accountId,
              ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
              chatId: input.chatId,
              ...(input.threadId ? { threadId: input.threadId } : {}),
              externalMessageId: input.externalMessageId,
              senderId: input.senderId,
            },
            ...(input.metadata ?? {}),
          },
          runMetadata: {
            source: "channel",
            connector: input.connector,
            externalMessageId: input.externalMessageId,
          },
        },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Prompt id is already used:")
      ) {
        this.context.log({
          level: "warn",
          event: "channel.message.idempotency_conflict",
          sessionId: conversation.sessionId,
          requestId: inputId,
          error: error.message,
        });
        throw new ApplicationError(409, error.message);
      }
      throw error;
    }
    if (!admission.run) {
      throw new ApplicationError(
        500,
        "Channel message was stored, but Agent runtime is unavailable",
      );
    }

    const result = await this.context.runControl.awaitRun(
      conversation.sessionId,
      admission.run.id,
    );
    const content =
      result.status === "completed"
        ? result.output.trim() || "[Agent completed without a text reply]"
        : `[Error: ${result.error ?? `Agent run ${result.status}`}]`;
    const delivery = this.context.channels.createDelivery({
      conversationId: conversation.id,
      connector: input.connector,
      accountId: input.accountId,
      chatId: input.chatId,
      threadId: input.threadId,
      platformMeta: input.platformMeta,
      sessionId: conversation.sessionId,
      inputId: admission.input.id,
      runId: admission.run.id,
      externalMessageId: input.externalMessageId,
      content,
    });
    return { conversation, delivery, duplicate: existedBefore };
  }

  /**
   * 下载入站附件并导入为 assetId 引用。
   * - 幂等：该 durable input 已存在且已带附件引用时直接复用，避免重复 import 造成指纹变化 → 409。
   * - 失败即整条消息失败：下载器不可用 / 下载失败 / 超限都抛错，不降级、不静默丢附件。
   */
  private async resolveInboundAttachments(
    input: DurableChannelMessageInput,
    inputId: string,
  ): Promise<AdmitPromptAttachmentInput[]> {
    const descriptors = readInboundAttachments(input.metadata);
    if (descriptors.length === 0) return [];

    const existing = this.sessionQueries.getInput(inputId);
    const existingAttachments = (existing as { attachments?: unknown } | undefined)?.attachments;
    if (Array.isArray(existingAttachments) && existingAttachments.length > 0) {
      return existingAttachments.map((record) => {
        const candidate = record as Record<string, unknown>;
        return {
          assetId: String(candidate["assetId"]),
          ...(typeof candidate["intent"] === "string"
            ? { intent: candidate["intent"] as AdmitPromptAttachmentInput["intent"] }
            : {}),
          ...(typeof candidate["displayName"] === "string"
            ? { displayName: candidate["displayName"] }
            : {}),
        };
      });
    }

    const resolved: AdmitPromptAttachmentInput[] = [];
    for (const descriptor of descriptors) {
      const controller = new AbortController();
      const timeoutError = new ApplicationError(504, `Channel attachment timed out for ${input.externalMessageId}/${descriptor.externalId}`);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(timeoutError);
          }, this.context.inboundAttachmentTimeoutMs ?? 2 * 60_000);
          timeout.unref?.();
        });
        const transfer = async () => {
          const download = await this.context.downloadChannelAttachment(input.externalMessageId, descriptor, controller.signal);
          if (!download) throw new ApplicationError(502, `Channel attachment download unavailable for ${input.externalMessageId}/${descriptor.externalId}`);
          if (controller.signal.aborted) {
            void download.stream.cancel().catch(() => undefined);
            throw timeoutError;
          }
          const displayName = descriptor.name ?? download.name ?? descriptor.externalId;
          let asset: { id: string };
          try {
            asset = await this.context.attachments.import({
              displayName,
              ...(download.mimeType ? { declaredMediaType: download.mimeType } : {}),
              content: download.stream,
              signal: controller.signal,
            });
          } catch (error) {
            if (controller.signal.aborted) throw timeoutError;
            const message = error instanceof Error ? error.message : String(error);
            throw new ApplicationError(422, `Channel attachment import failed: ${message}`);
          }
          return { assetId: asset.id, intent: descriptor.type === "image" ? "vision" as const : "tool_resource" as const, displayName };
        };
        resolved.push(await Promise.race([transfer(), deadline]));
      } catch (error) {
        if (controller.signal.aborted) {
          this.context.log({ level: "warn", event: "channel.attachment.timeout", requestId: inputId, error: timeoutError.message });
          throw timeoutError;
        }
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    return resolved;
  }

  private async withConversationLane<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.conversationLanes.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.conversationLanes.set(key, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.conversationLanes.get(key) === current) {
        this.conversationLanes.delete(key);
      }
    }
  }

  recordDelivery(
    deliveryId: string,
    input: RecordChannelDeliveryInput,
  ) {
    const existing = this.context.channels.getDelivery(deliveryId);
    if (!existing)
      throw new ApplicationError(
        404,
        `Channel delivery not found: ${deliveryId}`,
      );
    if (existing.status === "sent") return existing;
    return this.context.channels.updateDelivery(deliveryId, input);
  }

  status(options: { connector?: string; limit?: number } = {}): ChannelStatusSnapshot {
    return {
      conversations: this.context.channels.listConversations(options),
      deliveries: this.context.channels.listDeliveries(options),
    };
  }

  pendingDeliveries(options: { connector?: string; limit?: number } = {}) {
    return this.context.channels.listDeliveries({
      ...options,
      statuses: ["pending", "failed"],
    });
  }

  private resolveConversation(
    input: DurableChannelMessageInput,
  ): ExternalConversationRecord {
    const existing = this.context.channels.findConversation(input);
    const session = existing
      ? this.sessionQueries.getSession(existing.sessionId)
      : undefined;
    if (existing && session && session.status !== "archived") return existing;

    const created = this.context.sessionCommands.createSession({
      cwd: input.cwd,
      model: input.model,
      title: channelSessionTitle(input),
      metadata: {
        source: "channel",
        externalConversation: {
          connector: input.connector,
          accountId: input.accountId,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          chatId: input.chatId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
        desktop: { workspaceMode: "outside_project" },
      },
    });
    return this.context.channels.upsertConversation({
      ...(existing ? { id: existing.id } : {}),
      connector: input.connector,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      threadId: input.threadId,
      sessionId: created.id,
    });
  }
}

/**
 * 渠道会话标题：用第一条消息（折叠空白、取第一句、按码点截断到 20）。
 * 首条是图片/文件等无正文时回退 `平台显示名 · chatId`。
 */
function channelSessionTitle(input: DurableChannelMessageInput): string {
  const normalized = input.content.replace(/\s+/g, " ").trim();
  const firstSentence = normalized.match(/^.*?[。！？.!?]/)?.[0] ?? normalized;
  const title = [...firstSentence].slice(0, 20).join("");
  // 纯标点/纯空白不算标题，回退到平台显示名 + 会话地址。
  return /[\p{L}\p{N}]/u.test(title)
    ? title
    : `${channelConnectorLabel(input.connector)} · ${input.chatId}`;
}
