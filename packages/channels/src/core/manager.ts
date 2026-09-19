import type { ChannelAdapter, ChannelMessage } from "../index.js";
import { MessageBus, type InboundMessage } from "../bus/queue.js";
import { isAllowed } from "../bus/acl.js";

/**
 * 通道管理器（移植自 Python channels/impl/manager.py）。
 *
 * 与 Python 差异：
 * - Python 在内部按 config 硬编码 import 11 个通道；TS 改为外部注入
 *   adapter 实例（组装在 CLI 侧），manager 只管启停与路由。
 * - ACL 集中在这里而非 BaseChannel——adapter 保持薄，统一 fail-closed。
 * - 出站循环用 AbortSignal 退出而非 wait_for 1s 轮询。
 */

export interface ChannelManagerOptions {
  /** 按通道名的 ACL 白名单（缺失/空 = 全拒）。 */
  allowFrom: Record<string, string[]>;
  /** 是否转发 _progress 出站消息（默认 true，对齐 Python send_progress）。 */
  sendProgress?: boolean;
  /** 是否转发 _tool_hint 出站消息（默认 true，对齐 Python send_tool_hints）。 */
  sendToolHints?: boolean;
  /** 按通道名的出站策略；缺省的通道按 sendProgress/sendToolHints 默认值处理。 */
  channelPolicies?: Record<string, { sendProgress?: boolean; sendToolHints?: boolean }>;
  onWarning?: (message: string) => void;
  /** ACL 拒绝时的结构化回调（用于提示用户加入白名单）。 */
  onDenied?: (info: { channel: string; sender: string; chatId: string }) => void;
  /** 每个 connector 的机器人账号标识；同一平台多个机器人不会串 Session。 */
  accountIds?: Record<string, string>;
  onDeliveryResult?: (result: {
    deliveryId: string;
    status: "sent" | "failed" | "unknown";
    error?: string;
  }) => Promise<void> | void;
}

export interface ChannelStatus {
  running: boolean;
  lastError?: string;
}

export class ChannelManager {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly status = new Map<string, ChannelStatus>();
  private dispatchAbort: AbortController | null = null;
  private dispatchDone: Promise<void> | null = null;
  private outboundSeq = 0;

  constructor(
    adapters: ChannelAdapter[],
    private readonly bus: MessageBus,
    private readonly opts: ChannelManagerOptions,
  ) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.name, adapter);
      this.status.set(adapter.name, { running: false });
    }
  }

  async startAll(): Promise<void> {
    if (this.dispatchAbort) return; // 重入保护:二次 start 会泄漏旧分发循环
    for (const [name, allowList] of Object.entries(this.opts.allowFrom)) {
      if (allowList.length === 0) {
        this.opts.onWarning?.(
          `通道 ${name} 的 allowFrom 为空——远程访问全部拒绝。显式加入允许的身份或用 ["*"]。`,
        );
      }
    }
    for (const name of this.adapters.keys()) {
      if (!(name in this.opts.allowFrom)) {
        this.opts.onWarning?.(
          `通道 ${name} 未配置 allowFrom——远程访问全部拒绝。显式加入允许的身份或用 ["*"]。`,
        );
      }
    }

    this.dispatchAbort = new AbortController();
    this.dispatchDone = this.dispatchOutbound(this.dispatchAbort.signal);

    for (const [name, adapter] of this.adapters) {
      adapter.onMessage((msg) => this.handleInbound(name, msg));
      try {
        await adapter.connect();
        this.status.set(name, { running: true });
      } catch (err) {
        // 单通道启动失败不拖垮整体（对齐 Python _start_channel）。
        this.status.set(name, {
          running: false,
          lastError: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** 只断开入站（适配器），保留出站分发循环，让已入队的回复还能发出。 */
  async stopInbound(): Promise<void> {
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.disconnect();
      } catch {
        // 停止失败只影响该通道
      }
      this.status.set(name, { ...this.status.get(name)!, running: false });
    }
  }

  async stopAll(): Promise<void> {
    this.dispatchAbort?.abort();
    await this.dispatchDone?.catch(() => {});
    this.dispatchAbort = null;
    this.dispatchDone = null;

    await this.stopInbound();
  }

  getStatus(): Record<string, ChannelStatus> {
    return Object.fromEntries(this.status);
  }

  get enabledChannels(): string[] {
    return [...this.adapters.keys()];
  }

  private handleInbound(channelName: string, msg: ChannelMessage): void {
    const allowList = this.opts.allowFrom[channelName];
    if (!isAllowed({ sender: msg.sender, ...(msg.chatId ? { chatId: msg.chatId } : {}) }, allowList)) {
      this.opts.onWarning?.(
        `通道 ${channelName} 拒绝来自 ${msg.sender} 的消息（不在 allowFrom）。`,
      );
      if (msg.chatId) {
        this.opts.onDenied?.({ channel: channelName, sender: msg.sender, chatId: msg.chatId });
      }
      return;
    }
    if (!msg.chatId) {
      this.opts.onWarning?.(
        `通道 ${channelName} 拒绝没有 chatId 的消息（无法建立会话路由）。`,
      );
      return;
    }
    const inbound: InboundMessage = {
      channel: channelName,
      accountId: this.opts.accountIds?.[channelName] ?? "default",
      externalMessageId: msg.id,
      senderId: msg.sender,
      chatId: msg.chatId,
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      content: msg.content,
      timestamp: msg.timestamp,
      media: [],
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
      ...(msg.messageType ? { messageType: msg.messageType } : {}),
      metadata: {
        ...msg.metadata,
        _message_id: msg.id,
        ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
        ...(msg.attachments ? { attachments: msg.attachments } : {}),
        ...(msg.platformMeta ?? {}),
      },
      ...(msg.workspaceId
        ? { workspaceId: msg.workspaceId }
        : {}),
      ...(msg.threadId
        ? { threadId: msg.threadId }
        : {}),
      ...(msg.platformMeta ? { platformMeta: msg.platformMeta } : {}),
    };
    this.bus.publishInbound(inbound);
  }

  private async dispatchOutbound(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let msg;
      try {
        msg = await this.bus.consumeOutbound(signal);
      } catch {
        break; // aborted
      }

      const meta = msg.metadata ?? {};
      if (meta["_progress"]) {
        const policy = this.opts.channelPolicies?.[msg.channel];
        const sendProgress = policy?.sendProgress ?? this.opts.sendProgress;
        const sendToolHints = policy?.sendToolHints ?? this.opts.sendToolHints;
        const isToolHint = Boolean(meta["_tool_hint"]);
        if (isToolHint && sendToolHints === false) continue;
        if (!isToolHint && sendProgress === false) continue;
      }

      const adapter = this.adapters.get(msg.channel);
      const deliveryId =
        typeof meta["_delivery_id"] === "string"
          ? meta["_delivery_id"]
          : undefined;
      if (!adapter) {
        this.opts.onWarning?.(`未知通道:${msg.channel}（出站消息丢弃）`);
        if (deliveryId)
          await this.reportDelivery({
            deliveryId,
            status: "failed",
            error: `Unknown channel: ${msg.channel}`,
          });
        continue;
      }

      // 严格能力校验：当 adapter 声明了 capabilities 时，必须具备所需能力
      if (adapter.capabilities) {
        const messageType = msg.messageType ?? "text";
        let requiredTypeCap: import("../index.js").ChannelCapability | undefined;
        if (messageType === "text" || messageType === "image" || messageType === "file") {
          requiredTypeCap = messageType;
        }

        if (requiredTypeCap && !adapter.capabilities.supports.includes(requiredTypeCap)) {
          this.opts.onWarning?.(
            `通道 ${msg.channel} 不支持消息类型 ${messageType}（缺少能力 ${requiredTypeCap}）`,
          );
          if (deliveryId) {
            await this.reportDelivery({
              deliveryId,
              status: "failed",
              error: `Channel ${msg.channel} does not support messageType "${messageType}" (missing capability: ${requiredTypeCap})`,
            });
          }
          continue;
        }

        const rootMessageId = msg.platformMeta?.["rootMessageId"];
        const requiresThreading =
          Boolean(msg.threadId) ||
          (typeof rootMessageId === "string" && rootMessageId.trim() !== "");
        if (requiresThreading && !adapter.capabilities.supports.includes("threaded-conversation")) {
          this.opts.onWarning?.(
            `通道 ${msg.channel} 不支持消息类型 ${messageType} 的线程消息（缺少能力 threaded-conversation）`,
          );
          if (deliveryId) {
            await this.reportDelivery({
              deliveryId,
              status: "failed",
              error: `Channel ${msg.channel} does not support threaded-conversation (missing capability: threaded-conversation)`,
            });
          }
          continue;
        }
      }

      try {
        if (
          deliveryId &&
          !(await this.reportDelivery({ deliveryId, status: "unknown" }))
        ) {
          continue;
        }
        await adapter.send({
          id: `out_${++this.outboundSeq}`,
          channel: msg.channel,
          sender: "system",
          content: msg.content,
          timestamp: new Date(),
          senderType: "system",
          chatId: msg.chatId,
          replyTo: msg.replyTo ?? msg.chatId,
          ...(msg.messageType ? { messageType: msg.messageType } : {}),
          ...(msg.attachments ? { attachments: msg.attachments } : {}),
          ...(msg.threadId ? { threadId: msg.threadId } : {}),
          ...(msg.platformMeta ? { platformMeta: msg.platformMeta } : {}),
        });
        if (deliveryId)
          await this.reportDelivery({ deliveryId, status: "sent" });
      } catch (err) {
        // 发送失败记日志不中断循环（对齐 Python）。
        this.opts.onWarning?.(
          `通道 ${msg.channel} 发送失败:${err instanceof Error ? err.message : String(err)}`,
        );
        if (deliveryId)
          await this.reportDelivery({
            deliveryId,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
      }
    }
  }

  private async reportDelivery(result: {
    deliveryId: string;
    status: "sent" | "failed" | "unknown";
    error?: string;
  }): Promise<boolean> {
    try {
      await this.opts.onDeliveryResult?.(result);
      return true;
    } catch (error) {
      this.opts.onWarning?.(
        `回复状态保存失败(${result.deliveryId}):${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
