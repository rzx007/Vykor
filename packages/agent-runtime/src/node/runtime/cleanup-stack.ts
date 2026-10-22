export type Cleanup = () => void | Promise<void>;

interface CleanupEntry {
  cleanup: Cleanup;
  identity: object;
}

const cleanupStackAggregates = new WeakSet<AggregateError>();

export class CleanupStack {
  private readonly entries: CleanupEntry[] = [];
  private readonly identities = new Set<object>();
  private closePromise?: Promise<void>;

  add(cleanup: Cleanup, identity: object = cleanup): void {
    if (this.closePromise) {
      throw new Error("Cannot add cleanup after closing has started.");
    }
    if (this.identities.has(identity)) return;

    this.identities.add(identity);
    this.entries.push({ cleanup, identity });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closePromise = Promise.resolve().then(() => this.runCleanups());
    return this.closePromise;
  }

  private async runCleanups(): Promise<void> {
    const failures: unknown[] = [];
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      try {
        await this.entries[index]!.cleanup();
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      const aggregate = new AggregateError(failures, "Capability cleanup failed");
      cleanupStackAggregates.add(aggregate);
      throw aggregate;
    }
  }
}

export async function cleanupAfterInitializationFailure(
  stack: CleanupStack,
  initializationFailure: unknown,
): Promise<never> {
  try {
    await stack.close();
  } catch (cleanupFailure) {
    const cleanupFailures = cleanupFailure instanceof AggregateError
      && cleanupStackAggregates.has(cleanupFailure)
      ? cleanupFailure.errors
      : [cleanupFailure];
    throw new AggregateError(
      [initializationFailure, ...cleanupFailures],
      "Capability initialization and cleanup failed",
    );
  }
  throw initializationFailure;
}
