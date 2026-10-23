import type { SessionState } from "../session-runtime/persistence/store-state.js";
import type { DeltaCheckpoint } from "./persistence/delta-checkpoint.js";
import type { DurableEventSequence } from "./persistence/event-sequence.js";
import type { MutationBuffer } from "./transactions/mutation-buffer.js";
import type { SessionDatabase } from "./session-database.js";
import type { TransactionCoordinator } from "./transactions/transaction-coordinator.js";
import type { ChatStoragePersistence } from "./persistence/chat-persistence.js";
import type { TemporaryControlRecords } from "./persistence/temporary-control-records.js";
import type { TransactionJournal } from "./transactions/transaction-journal.js";

export interface StorageContext {
  database: SessionDatabase;
  state: SessionState;
  mutations: MutationBuffer;
  eventSequence: DurableEventSequence;
  deltaCheckpoint: DeltaCheckpoint;
  coordinator?: TransactionCoordinator;
  chatPersistence?: ChatStoragePersistence;
  temporaryControls?: TemporaryControlRecords;
  rollback?: TransactionJournal;
  atomic<T>(work: () => T): T;
  deferUntilCommit?(callback: () => void): void;
  assertWritable(): void;
}
