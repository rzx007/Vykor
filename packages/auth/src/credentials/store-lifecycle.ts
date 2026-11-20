/** Drain accepted file operations before a host disposes and rebuilds its stores. */
export class StoreLifecycle {
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Credential store is closed");
    const pending = operation();
    this.pending.add(pending);
    try { return await pending; }
    finally { this.pending.delete(pending); }
  }

  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.pending]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
