import type { SessionState } from "../session-runtime/store-state.js";
import type { DeltaCheckpoint } from "./delta-checkpoint.js";
import type { DurableEventSequence } from "./event-sequence.js";
import type { MutationBuffer } from "./mutation-buffer.js";
import type { SessionDatabase } from "./session-database.js";

export interface StorageContext {
  database: SessionDatabase;
  state: SessionState;
  mutations: MutationBuffer;
  eventSequence: DurableEventSequence;
  deltaCheckpoint: DeltaCheckpoint;
  atomic<T>(work: () => T): T;
  assertWritable(): void;
}
