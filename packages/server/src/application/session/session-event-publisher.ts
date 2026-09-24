import type { SessionEventRecord } from "@vykor/protocol";

export interface SessionEventCursor {
  latestEventSeq(): number;
}

export interface SessionEventSink {
  broadcastSince(seq: number): void;
  broadcastEvent(event: SessionEventRecord): void;
}

/** Publishes newly persisted session events to live HTTP subscribers. */
export class SessionEventPublisher {
  constructor(
    private readonly store: SessionEventCursor,
    private readonly sink: SessionEventSink,
  ) {}

  checkpoint(): number {
    return this.store.latestEventSeq();
  }

  publishSince(seq: number): void {
    this.sink.broadcastSince(seq);
  }

  publish(event: SessionEventRecord): void {
    this.sink.broadcastEvent(event);
  }
}
