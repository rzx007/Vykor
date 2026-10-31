import type { SessionEventRecord } from "@vykor/domain-contracts/sessions";
import { matchesSessionEventScope } from "@vykor/domain-contracts/sessions";

export interface ApplicationEventStore {
  listEvents(options?: {
    afterSeq?: number;
    sessionId?: string;
    limit?: number;
  }): SessionEventRecord[];
  latestEventSeq(): number;
}

export interface ApplicationEventStreamOptions {
  after?: number;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface ApplicationEventSubscription {
  /** 订阅建立时已经持久化的最后一个事件序号。 */
  snapshotCursor: number;
  /** 终止时立即通知传输层并保留失败原因；积压超限时 reason 带最后实际交付的游标。 */
  signal: AbortSignal;
  /** 先重放已有事件，再持续输出新写入的 durable event。 */
  stream: AsyncIterable<SessionEventRecord>;
}

interface Subscriber {
  sessionId?: string;
  after: number;
  queuedThrough: number;
  queue: SessionEventRecord[];
  wake?: () => void;
  closed: boolean;
  termination: AbortController;
  cleanup: () => void;
}

const EVENT_PAGE_SIZE = 128;
const MAX_BUFFERED_EVENTS = 128;

export class ApplicationEventBackpressureError extends Error {
  constructor(readonly lastConsumedCursor: number) {
    super("Application event subscription exceeded its buffer limit; reconnect from the last consumed cursor");
    this.name = "ApplicationEventBackpressureError";
  }
}

/**
 * Application 自己拥有的事件出口。
 * 事件始终先写入 Store，再通过这里通知 HTTP、Bot 或内嵌调用方。
 */
export class ApplicationEventService {
  private readonly subscribers = new Set<Subscriber>();
  private closed = false;

  constructor(
    private readonly store: ApplicationEventStore,
  ) {}

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  list(options: {
    afterSeq?: number;
    sessionId?: string;
    limit?: number;
  } = {}): SessionEventRecord[] {
    return this.store.listEvents(options);
  }

  subscribe(options: ApplicationEventStreamOptions = {}): ApplicationEventSubscription {
    if (this.closed) throw new Error("Application event service is closed");
    const subscriber: Subscriber = {
      sessionId: options.sessionId,
      after: options.after ?? 0,
      queuedThrough: options.after ?? 0,
      queue: [],
      closed: false,
      termination: new AbortController(),
      cleanup: () => {},
    };

    // 先接入 live，再读取 checkpoint 和 replay。这样两步之间写入的事件不会丢失。
    this.subscribers.add(subscriber);
    let snapshotCursor: number;
    try {
      snapshotCursor = this.store.latestEventSeq();
    } catch (error) {
      this.terminate(subscriber);
      throw error;
    }
    subscriber.queue = subscriber.queue.filter(event => event.seq > snapshotCursor);
    subscriber.queuedThrough = Math.max(subscriber.after, snapshotCursor, subscriber.queue.at(-1)?.seq ?? 0);
    const abort = () => this.terminate(subscriber);
    subscriber.cleanup = () => options.signal?.removeEventListener("abort", abort);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    return {
      snapshotCursor,
      signal: subscriber.termination.signal,
      stream: this.stream(subscriber, snapshotCursor),
    };
  }

  broadcastSince(seq: number): void {
    const through = this.store.latestEventSeq();
    while (seq < through) {
      const page = this.store.listEvents({ afterSeq: seq, limit: EVENT_PAGE_SIZE });
      if (!page.length) break;
      for (const event of page) {
        if (event.seq > through) return;
        this.broadcastEvent(event);
      }
      seq = page.at(-1)!.seq;
    }
  }

  broadcastEvent(event: SessionEventRecord): void {
    if (this.closed) return;
    for (const subscriber of this.subscribers) {
      if (event.seq <= subscriber.queuedThrough) continue;
      if (!matchesSessionEventScope(event, subscriber.sessionId)) {
        continue;
      }
      if (subscriber.queue.length >= MAX_BUFFERED_EVENTS) {
        this.terminate(subscriber, new ApplicationEventBackpressureError(subscriber.after));
        continue;
      }
      subscriber.queue.push(event);
      subscriber.queuedThrough = event.seq;
      subscriber.wake?.();
      subscriber.wake = undefined;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscriber of this.subscribers) {
      this.terminate(subscriber);
    }
    this.subscribers.clear();
  }

  private async *stream(
    subscriber: Subscriber,
    snapshotCursor: number,
  ): AsyncIterable<SessionEventRecord> {
    try {
      while (subscriber.after < snapshotCursor && !subscriber.closed) {
        const page = this.store.listEvents({
          afterSeq: subscriber.after, sessionId: subscriber.sessionId, limit: EVENT_PAGE_SIZE,
        });
        if (!page.length) break;
        for (const event of page) {
          if (subscriber.closed || event.seq > snapshotCursor) break;
          subscriber.after = event.seq;
          yield event;
        }
        if (page.at(-1)!.seq >= snapshotCursor || page.length < EVENT_PAGE_SIZE) break;
      }
      while (!subscriber.closed) {
        const event = subscriber.queue.shift();
        if (event) {
          subscriber.after = event.seq;
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => {
          subscriber.wake = resolve;
          if (subscriber.closed) resolve();
        });
      }
      if (subscriber.termination.signal.reason instanceof ApplicationEventBackpressureError) {
        throw subscriber.termination.signal.reason;
      }
    } catch (error) {
      this.terminate(subscriber, error instanceof Error ? error : new Error("Application event stream failed"));
      throw error;
    } finally {
      this.terminate(subscriber);
    }
  }

  private terminate(subscriber: Subscriber, error?: Error): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.queue.length = 0;
    subscriber.cleanup();
    this.subscribers.delete(subscriber);
    subscriber.wake?.();
    subscriber.wake = undefined;
    subscriber.termination.abort(error);
  }
}
