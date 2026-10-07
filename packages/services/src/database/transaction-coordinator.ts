import {
  clearMutationBuffer,
  cloneMutationBuffer,
  hasPendingMutations,
  restoreMutationBuffer,
} from "./mutation-buffer.js";
import type { StorageContext } from "./storage-context.js";
import { assertSynchronousCommit } from "./chat-persistence.js";
import { TransactionJournal } from "./transaction-journal.js";

export interface TransactionCoordinatorHooks {
  beforeFlush?: () => void;
  afterMutationSql?: () => void;
  beforeCommit?: () => void;
}

export interface TransactionCoordinatorOptions {
  storage: StorageContext;
  persistChanges?: () => void;
  flushDeltas?: () => void;
  hooks?: TransactionCoordinatorHooks;
}

export class TransactionCoordinator {
  private depth = 0;
  private saveRequested = false;
  private deferredCallbacks: Array<() => void> = [];
  private rollbackCallbacks: Array<() => void> = [];
  private hooks?: TransactionCoordinatorHooks;
  private readonly storage: StorageContext;
  private readonly persistChangesFn?: () => void;
  private readonly flushDeltasFn?: () => void;

  constructor(options: TransactionCoordinatorOptions) {
    this.storage = options.storage;
    this.persistChangesFn = options.persistChanges;
    this.flushDeltasFn = options.flushDeltas;
    this.hooks = options.hooks;
    this.storage.coordinator = this;
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  setHooks(hooks?: TransactionCoordinatorHooks): void {
    this.hooks = hooks;
  }

  requestSave(): void {
    if (this.depth > 0) {
      this.saveRequested = true;
    }
  }

  deferUntilCommit(callback: () => void): void {
    if (this.depth === 0) {
      callback();
    } else {
      this.deferredCallbacks.push(callback);
    }
  }

  deferUntilRollback(callback: () => void): void {
    if (this.depth === 0)
      throw new Error("Rollback callback requires an active transaction");
    this.rollbackCallbacks.push(callback);
  }

  atomic<T>(work: () => T): T {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return work();
      } finally {
        this.depth -= 1;
      }
    }

    this.storage.assertWritable();
    const previousDeltaCheckpoint = this.storage.deltaCheckpoint.snapshot();
    const previousEventSequence = this.storage.eventSequence.snapshot();
    const previousMutations = cloneMutationBuffer(this.storage.mutations);
    const previousSaveRequested = this.saveRequested;
    const previousJournal = this.storage.rollback;
    const journal = new TransactionJournal();
    journal.captureEvents(this.storage.state);
    this.storage.rollback = journal;

    this.depth = 1;
    this.saveRequested = false;
    this.deferredCallbacks = [];
    this.rollbackCallbacks = [];

    let persisted = false;

    let result: T;
    try {
      result = this.storage.database.connection.transaction(() => {
        const value = work();
        this.hooks?.beforeFlush?.();

        const shouldPersist =
          this.saveRequested || hasPendingMutations(this.storage.mutations);

        if (shouldPersist && this.persistChangesFn) {
          assertSynchronousCommit(this.persistChangesFn());
          persisted = true;
        }

        this.hooks?.afterMutationSql?.();
        this.hooks?.beforeCommit?.();
        return value;
      })();
    } catch (error) {
      this.storage.rollback = previousJournal;
      this.saveRequested = previousSaveRequested;
      this.deferredCallbacks = [];
      this.depth = 0;
      const callbacks = this.rollbackCallbacks;
      this.rollbackCallbacks = [];
      const rollbackErrors: unknown[] = [];
      for (const restore of [
        () => journal.rollback(),
        () => this.storage.eventSequence.restore(previousEventSequence),
        () => this.storage.deltaCheckpoint.restore(previousDeltaCheckpoint),
        () => restoreMutationBuffer(this.storage.mutations, previousMutations),
        ...callbacks.reverse(),
      ]) {
        try {
          restore();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length)
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Transaction rollback failed",
          { cause: error },
        );
      throw error;
    }

    this.storage.rollback = previousJournal;
    journal.clear();
    this.depth = 0;
    this.saveRequested = previousSaveRequested;
    this.rollbackCallbacks = [];
    if (persisted) {
      this.storage.deltaCheckpoint.clear();
      clearMutationBuffer(this.storage.mutations);
    }

    try {
      const callbacks = this.deferredCallbacks;
      this.deferredCallbacks = [];
      for (const callback of callbacks) callback();
      return result;
    } finally {
      if (this.storage.deltaCheckpoint.dirtyPartIds().length > 0) {
        if (this.storage.deltaCheckpoint.reachedThreshold()) {
          this.flushDeltasFn?.();
        } else {
          this.storage.deltaCheckpoint.schedule();
        }
      }
    }
  }
}
