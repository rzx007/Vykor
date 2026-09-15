import type { SessionEventRecord } from "@openharness/protocol";

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
  /** 先重放已有事件，再持续输出新写入的 durable event。 */
  stream: AsyncIterable<SessionEventRecord>;
}

interface Subscriber {
  sessionId?: string;
  after: number;
  queue: SessionEventRecord[];
  wake?: () => void;
  closed: boolean;
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
      queue: [],
      closed: false,
    };

    // 先接入 live，再读取 checkpoint 和 replay。这样两步之间写入的事件不会丢失。
    this.subscribers.add(subscriber);
    const snapshotCursor = this.store.latestEventSeq();
    const replay = this.store
      .listEvents({
        afterSeq: subscriber.after,
        sessionId: subscriber.sessionId,
      })
      .filter((event) => event.seq <= snapshotCursor);
    subscriber.after = snapshotCursor;
    subscriber.queue = subscriber.queue.filter(
      (event) => event.seq > snapshotCursor,
    );

    return {
      snapshotCursor,
      stream: this.stream(subscriber, replay, options.signal),
    };
  }

  broadcastSince(seq: number): void {
    for (const event of this.store.listEvents({ afterSeq: seq })) {
      this.broadcastEvent(event);
    }
  }

  broadcastEvent(event: SessionEventRecord): void {
    if (this.closed) return;
    for (const subscriber of this.subscribers) {
      if (event.seq <= subscriber.after) continue;
      if (
        subscriber.sessionId &&
        event.sessionId !== subscriber.sessionId
      ) {
        continue;
      }
      subscriber.queue.push(event);
      subscriber.wake?.();
      subscriber.wake = undefined;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscriber of this.subscribers) {
      subscriber.closed = true;
      subscriber.wake?.();
    }
    this.subscribers.clear();
  }

  private async *stream(
    subscriber: Subscriber,
    replay: SessionEventRecord[],
    signal?: AbortSignal,
  ): AsyncIterable<SessionEventRecord> {
    const abort = () => {
      subscriber.closed = true;
      subscriber.wake?.();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for (const event of replay) {
        if (signal?.aborted || subscriber.closed) return;
        subscriber.after = event.seq;
        yield event;
      }
      while (!signal?.aborted && !subscriber.closed) {
        const event = subscriber.queue.shift();
        if (event) {
          subscriber.after = event.seq;
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => {
          subscriber.wake = resolve;
          if (signal?.aborted || subscriber.closed) resolve();
        });
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      subscriber.closed = true;
      this.subscribers.delete(subscriber);
    }
  }
}
