/**
 * 消息总线。
 *
 * inbound/outbound 双异步队列，解耦通道与引擎：通道收到消息推 inbound，
 * 桥接层处理后推 outbound，由 ChannelManager 分发回通道。
 *
 * 与 Python 差异：asyncio.Queue → 自实现 promise 队列（消费者先到挂起
 * resolver，生产者先到缓冲）；退出用 AbortSignal 而非 wait_for 1s 轮询。
 */

export interface InboundMessage {
  channel: string;
  accountId: string;
  externalMessageId: string;
  senderId: string;
  chatId: string;
  conversationId?: string;
  workspaceId?: string;
  threadId?: string;
  content: string;
  timestamp: Date;
  /** 媒体 URL 列表（基础版仅透传，下载留待）。 */
  media: string[];
  /** 通道私有数据。 */
  metadata: Record<string, unknown>;
  /** 会话键覆盖（如线程级会话）。 */
  sessionKeyOverride?: string;
}

export interface OutboundMessage {
  channel: string;
  chatId: string;
  content: string;
  replyTo?: string;
  media?: string[];
  metadata?: Record<string, unknown>;
}

/** 单向异步 FIFO 队列：缓冲与挂起消费者二者最多只有一边非空。 */
class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<{ resolve: (v: T) => void; reject: (e: Error) => void }> = [];
  private droppedCount = 0;

  constructor(private readonly maxSize: number = 0) {}

  /**
   * Push an item into the queue. Returns true if accepted, false if dropped
   * because the buffer is at capacity (maxSize > 0 and no waiting consumer).
   */
  push(item: T): boolean {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(item);
      return true;
    }
    if (this.maxSize > 0 && this.buffer.length >= this.maxSize) {
      this.droppedCount++;
      return false;
    }
    this.buffer.push(item);
    return true;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  pull(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new Error("consume aborted"));
    }
    const head = this.buffer.shift();
    if (head !== undefined) {
      return Promise.resolve(head);
    }
    return new Promise<T>((resolve, reject) => {
      // 长驻消费循环复用同一个 signal:正常 resolve 必须摘掉 abort 监听器,
      // 否则每条消息在 signal 上漏一个死监听器(无界增长 + MaxListeners 告警)。
      const onAbort = () => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          reject(new Error("consume aborted"));
        }
      };
      const waiter = {
        resolve: (v: T) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject,
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  get size(): number {
    return this.buffer.length;
  }
}

/** Default backpressure cap per direction. Keeps memory bounded under burst traffic. */
const DEFAULT_MAX_QUEUE_SIZE = 1_000;

export class MessageBus {
  private readonly inbound = new AsyncQueue<InboundMessage>(DEFAULT_MAX_QUEUE_SIZE);
  private readonly outbound = new AsyncQueue<OutboundMessage>(DEFAULT_MAX_QUEUE_SIZE);

  publishInbound(msg: InboundMessage): void {
    const accepted = this.inbound.push(msg);
    if (!accepted) {
      // Inbound queue is full — log and drop. Callers can check inboundDropped.
      console.warn(`[MessageBus] inbound queue full (${DEFAULT_MAX_QUEUE_SIZE}), message dropped`);
    }
  }

  consumeInbound(signal?: AbortSignal): Promise<InboundMessage> {
    return this.inbound.pull(signal);
  }

  publishOutbound(msg: OutboundMessage): void {
    const accepted = this.outbound.push(msg);
    if (!accepted) {
      console.warn(`[MessageBus] outbound queue full (${DEFAULT_MAX_QUEUE_SIZE}), message dropped`);
    }
  }

  consumeOutbound(signal?: AbortSignal): Promise<OutboundMessage> {
    return this.outbound.pull(signal);
  }

  get inboundSize(): number {
    return this.inbound.size;
  }

  get outboundSize(): number {
    return this.outbound.size;
  }

  get inboundDropped(): number {
    return this.inbound.dropped;
  }

  get outboundDropped(): number {
    return this.outbound.dropped;
  }

  /** 会话键：override 优先，否则 `channel:chatId`（对齐 Python session_key）。 */
  static sessionKey(msg: InboundMessage): string {
    return msg.sessionKeyOverride ?? `${msg.channel}:${msg.chatId}`;
  }
}
