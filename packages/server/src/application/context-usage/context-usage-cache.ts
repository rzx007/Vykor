import type { ContextUsageSnapshot } from "@vykor/core";

/** In-memory sessionId → ContextUsageSnapshot cache (not persisted to disk). */
export class ContextUsageCache {
  private readonly store = new Map<string, ContextUsageSnapshot>();

  get(sessionId: string): ContextUsageSnapshot | undefined {
    return this.store.get(sessionId);
  }

  set(sessionId: string, snapshot: ContextUsageSnapshot): void {
    this.store.set(sessionId, snapshot);
  }

  delete(sessionId: string): void {
    this.store.delete(sessionId);
  }

  /** Alias for delete — preferred name in invalidation call sites. */
  invalidate(sessionId: string): void {
    this.delete(sessionId);
  }

  clear(): void {
    this.store.clear();
  }
}

export function createContextUsageCache(): ContextUsageCache {
  return new ContextUsageCache();
}

/** Process-wide default cache shared by ContextService and (task 6) run wiring. */
export const sharedContextUsageCache = createContextUsageCache();

export function getSharedContextUsageCache(): ContextUsageCache {
  return sharedContextUsageCache;
}
