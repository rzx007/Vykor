import type {
  ChannelDeliveryRecord,
  DurableChannelMessageInput,
  DurableChannelMessageResult,
  RecordChannelDeliveryInput,
} from "@openharness/protocol";

import { MessageBus, type InboundMessage } from "../bus/queue.js";

export interface DurableChannelPort {
  handleChannelMessage(
    input: DurableChannelMessageInput,
    options?: { signal?: AbortSignal },
  ): Promise<DurableChannelMessageResult>;
  listPendingChannelDeliveries(options?: {
    connector?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<ChannelDeliveryRecord[]>;
  recordChannelDelivery(
    deliveryId: string,
    input: RecordChannelDeliveryInput,
  ): Promise<ChannelDeliveryRecord>;
}

/**
 * 正式通道桥接：消息交给 daemon 的 Durable Application，自己不创建 Agent。
 * Agent 已执行和平台回复是两步；重启后只补发未确认回复，不重复跑 Agent。
 */
export class DurableChannelBridge {
  private abort: AbortController | null = null;
  private done: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      application: DurableChannelPort;
      bus: MessageBus;
      cwd: string | ((message: InboundMessage) => string | Promise<string>);
      model: string;
      connectors?: string[];
      onWarning?: (message: string) => void;
    },
  ) {}

  start(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    this.done = this.run(this.abort.signal);
  }

  /**
   * 停止收新消息，但让已经交给 durable application 的消息处理完。
   * 传 `drainTimeoutMs` 时有界等待：超时即返回，不阻塞停机；未完成的 handle
   * 仍在后台收尾，其 durable delivery 留待下次启动恢复。
   */
  async stop(options: { drainTimeoutMs?: number } = {}): Promise<void> {
    const done = this.done;
    this.abort?.abort();
    this.abort = null;
    this.done = null;
    if (!done) return;
    const settled = done.catch(() => {});
    if (options.drainTimeoutMs === undefined) {
      await settled;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, options.drainTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    await this.recoverPending(signal);
    while (!signal.aborted) {
      let message: InboundMessage;
      try {
        message = await this.deps.bus.consumeInbound(signal);
      } catch {
        break;
      }
      try {
        await this.handle(message);
      } catch (error) {
        this.deps.onWarning?.(
          `durable bridge 处理消息失败(${message.channel}/${message.chatId}):${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async handle(message: InboundMessage): Promise<void> {
    const cwd =
      typeof this.deps.cwd === "function" ? await this.deps.cwd(message) : this.deps.cwd;
    const metadata = {
      ...message.metadata,
      ...(message.attachments ? { attachments: message.attachments } : {}),
    };
    const result = await this.deps.application.handleChannelMessage({
      connector: message.channel,
      accountId: message.accountId,
      workspaceId: message.workspaceId,
      chatId: message.chatId,
      threadId: message.threadId,
      externalMessageId: message.externalMessageId,
      senderId: message.senderId,
      content: message.content,
      cwd,
      model: this.deps.model,
      platformMeta: message.platformMeta,
      metadata,
    });
    if (
      result.delivery.status === "sent" ||
      result.delivery.status === "unknown"
    ) {
      return;
    }
    this.publish(result.delivery);
  }

  private async recoverPending(signal: AbortSignal): Promise<void> {
    const connectors = this.deps.connectors?.length
      ? this.deps.connectors
      : [undefined];
    for (const connector of connectors) {
      if (signal.aborted) return;
      try {
        const deliveries =
          await this.deps.application.listPendingChannelDeliveries({
            connector,
            limit: 200,
            signal,
          });
        for (const delivery of deliveries) this.publish(delivery);
      } catch (error) {
        if (signal.aborted) return;
        this.deps.onWarning?.(
          `未发送回复恢复失败${connector ? `(${connector})` : ""}:${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private publish(delivery: ChannelDeliveryRecord): void {
    this.deps.bus.publishOutbound({
      channel: delivery.connector,
      chatId: delivery.chatId,
      content: delivery.content,
      // 平台路由上下文必须透传：缺失时不得静默降级成普通 chat。
      ...(delivery.platformMeta ? { platformMeta: delivery.platformMeta } : {}),
      // 线程标识单独透传；rootMessageId 在 platformMeta 内。
      ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
      metadata: {
        _delivery_id: delivery.id,
        _session_id: delivery.sessionId,
        _run_id: delivery.runId,
      },
    });
  }
}
