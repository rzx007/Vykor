import type Database from "better-sqlite3";

import type { SessionState } from "../session-runtime/store-state.js";

export const EVENT_SEQUENCE_BLOCK_SIZE = 1024;

export interface EventSequenceSnapshot {
  next: number;
  reservedThrough: number;
}

export class DurableEventSequence {
  private constructor(
    private readonly database: Database.Database,
    private readonly state: SessionState,
    private reservedThrough: number,
  ) {}

  static load(
    database: Database.Database,
    state: SessionState,
  ): DurableEventSequence {
    const row = database
      .prepare(
        "SELECT reserved_through FROM session_event_sequence WHERE id = 1",
      )
      .get() as { reserved_through?: number } | undefined;
    const reservedThrough = row?.reserved_through ?? 0;
    state.nextEventSeq = Math.max(state.nextEventSeq, reservedThrough + 1);
    return new DurableEventSequence(database, state, reservedThrough);
  }

  allocate(): number {
    if (this.state.nextEventSeq > this.reservedThrough) {
      const reservedThrough =
        this.state.nextEventSeq + EVENT_SEQUENCE_BLOCK_SIZE - 1;
      this.database
        .prepare(
          `
        INSERT INTO session_event_sequence (id, reserved_through) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET reserved_through = excluded.reserved_through
      `,
        )
        .run(reservedThrough);
      this.reservedThrough = reservedThrough;
    }
    return this.state.nextEventSeq++;
  }

  snapshot(): EventSequenceSnapshot {
    return { next: this.state.nextEventSeq, reservedThrough: this.reservedThrough };
  }

  restore(snapshot: EventSequenceSnapshot): void {
    this.state.nextEventSeq = snapshot.next;
    this.reservedThrough = snapshot.reservedThrough;
  }
}
