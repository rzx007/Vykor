import {
  durableChannelInputId,
  type ChannelStatusSnapshot,
  type DurableChannelMessageInput,
  type DurableChannelMessageResult,
  type ExternalConversationRecord,
  type RecordChannelDeliveryInput,
} from "@openharness/protocol";
import type { SessionStore } from "@openharness/services";

import { ApplicationError } from "../../shared/application-error.js";
import type { ObservabilityEvent } from "../../shared/observability.js";
import type { SessionApplicationService } from "../session/session-application-service.js";

export interface ChannelApplicationServiceContext {
  store: Pick<SessionStore, "getInput" | "getSession">;
  channels: SessionStore["channels"];
  sessions: Pick<
    SessionApplicationService,
    "admitPrompt" | "awaitRun" | "createSession"
  >;
  log(event: ObservabilityEvent): void;
}

/** 外部聊天消息进入 durable Session/Run 的唯一应用入口。 */
export class ChannelApplicationService {
  private readonly conversationLanes = new Map<string, Promise<void>>();

  constructor(private readonly context: ChannelApplicationServiceContext) {}

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
    const existedBefore = Boolean(this.context.store.getInput(inputId));
    const conversation = this.resolveConversation(input);
    let admission;
    try {
      admission = await this.context.sessions.admitPrompt(
        conversation.sessionId,
        {
          id: inputId,
          items: [{ type: "text", text: input.content }],
          delivery: "queue",
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

    const result = await this.context.sessions.awaitRun(
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
      sessionId: conversation.sessionId,
      inputId: admission.input.id,
      runId: admission.run.id,
      externalMessageId: input.externalMessageId,
      content,
    });
    return { conversation, delivery, duplicate: existedBefore };
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
      ? this.context.store.getSession(existing.sessionId)
      : undefined;
    if (existing && session && session.status !== "archived") return existing;

    const created = this.context.sessions.createSession({
      cwd: input.cwd,
      model: input.model,
      title: `${input.connector} · ${input.chatId}`,
      metadata: {
        source: "channel",
        externalConversation: {
          connector: input.connector,
          accountId: input.accountId,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          chatId: input.chatId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
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
