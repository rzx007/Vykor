import {
  clearMutationBuffer,
  cloneMutationBuffer,
  hasPendingMutations,
  restoreMutationBuffer,
} from "./mutation-buffer.js";
import type { StorageContext } from "./storage-context.js";
import { assertSynchronousCommit } from "./chat-persistence.js";

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

    const previousState = structuredClone(this.storage.state);
    const previousMemory = this.storage.chatPersistence?.snapshot();
    const previousControls = this.storage.temporaryControls?.snapshot();
    const previousTransactionState = this.storage.transactionState;
    this.storage.transactionState = previousState;
    const previousDeltaCheckpoint = this.storage.deltaCheckpoint.snapshot();
    const previousEventSequence = this.storage.eventSequence.snapshot();
    const previousMutations = cloneMutationBuffer(this.storage.mutations);
    const previousSaveRequested = this.saveRequested;

    this.depth = 1;
    this.saveRequested = false;
    this.deferredCallbacks = [];
    this.rollbackCallbacks = [];

    let persisted = false;
    let completed = false;

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
      Object.assign(this.storage.state, previousState);
      if (previousMemory) this.storage.chatPersistence?.restore(previousMemory);
      if (previousControls)
        this.storage.temporaryControls?.restore(previousControls);
      this.storage.transactionState = previousTransactionState;
      this.storage.eventSequence.restore(previousEventSequence);
      this.storage.deltaCheckpoint.restore(previousDeltaCheckpoint);
      restoreMutationBuffer(this.storage.mutations, previousMutations);
      this.saveRequested = previousSaveRequested;
      this.deferredCallbacks = [];
      this.depth = 0;
      const rollbackErrors: unknown[] = [];
      for (const callback of this.rollbackCallbacks.reverse()) {
        try {
          callback();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      this.rollbackCallbacks = [];
      if (this.storage.deltaCheckpoint.dirtyPartIds().length > 0) {
        this.storage.deltaCheckpoint.schedule();
      }
      if (rollbackErrors.length)
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Transaction rollback failed",
        );
      throw error;
    }

    if (persisted) {
      this.storage.deltaCheckpoint.clear();
      clearMutationBuffer(this.storage.mutations);
    }
    completed = true;
    this.rollbackCallbacks = [];

    try {
      const callbacks = this.deferredCallbacks;
      this.deferredCallbacks = [];
      for (const callback of callbacks) callback();
      return result;
    } finally {
      this.depth = 0;
      this.storage.transactionState = previousTransactionState;
      this.saveRequested = previousSaveRequested;
      if (this.storage.deltaCheckpoint.dirtyPartIds().length > 0) {
        if (completed && this.storage.deltaCheckpoint.reachedThreshold()) {
          this.flushDeltasFn?.();
        } else {
          this.storage.deltaCheckpoint.schedule();
        }
      }
    }
  }
}
