import { eq } from "drizzle-orm";

import type { SessionState } from "../session-runtime/store-state.js";
import { sessionEventSequence } from "../session-runtime/schema.js";
import type { SessionDatabase } from "./session-database.js";

export const EVENT_SEQUENCE_BLOCK_SIZE = 1024;

export interface EventSequenceSnapshot {
  next: number;
  reservedThrough: number;
}

export class DurableEventSequence {
  private constructor(
    private readonly database: SessionDatabase["orm"],
    private readonly state: SessionState,
    private reservedThrough: number,
  ) {}

  static load(
    database: SessionDatabase["orm"],
    state: SessionState,
  ): DurableEventSequence {
    const row = database.select().from(sessionEventSequence)
      .where(eq(sessionEventSequence.id, 1)).get();
    const reservedThrough = row?.reservedThrough ?? 0;
    state.nextEventSeq = Math.max(state.nextEventSeq, reservedThrough + 1);
    return new DurableEventSequence(database, state, reservedThrough);
  }

  allocate(): number {
    if (this.state.nextEventSeq > this.reservedThrough) {
      const reservedThrough =
        this.state.nextEventSeq + EVENT_SEQUENCE_BLOCK_SIZE - 1;
      this.database.insert(sessionEventSequence).values({ id: 1, reservedThrough })
        .onConflictDoUpdate({ target: sessionEventSequence.id, set: { reservedThrough } }).run();
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
