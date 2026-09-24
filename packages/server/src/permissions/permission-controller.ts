import type { AgentPermissionDecision } from "@vykor/core";

export interface PermissionControllerWaitInput {
  requestId: string;
  signal?: AbortSignal;
  expire(reason: string): void;
}

type PermissionWaiter = (decision: AgentPermissionDecision) => void;

export class PermissionController {
  private readonly waiters = new Map<string, Set<PermissionWaiter>>();

  wait(input: PermissionControllerWaitInput): Promise<AgentPermissionDecision> {
    if (input.signal?.aborted) {
      const reason = "Run interrupted before permission reply";
      input.expire(reason);
      return Promise.resolve({ status: "expired", reason });
    }

    return new Promise<AgentPermissionDecision>((resolve) => {
      const waiter: PermissionWaiter = (decision) => {
        cleanup();
        resolve(decision);
      };
      const abort = () => {
        cleanup();
        const reason = "Run interrupted while waiting for permission";
        input.expire(reason);
        resolve({ status: "expired", reason });
      };
      const cleanup = () => {
        const waiters = this.waiters.get(input.requestId);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.waiters.delete(input.requestId);
        input.signal?.removeEventListener("abort", abort);
      };

      const waiters = this.waiters.get(input.requestId) ?? new Set<PermissionWaiter>();
      waiters.add(waiter);
      this.waiters.set(input.requestId, waiters);
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
    });
  }

  resolve(requestId: string, decision: AgentPermissionDecision): boolean {
    const waiters = this.waiters.get(requestId);
    if (!waiters) return false;
    this.waiters.delete(requestId);
    for (const waiter of waiters) waiter(decision);
    return true;
  }

  pendingCount(requestId?: string): number {
    if (requestId) return this.waiters.get(requestId)?.size ?? 0;
    let count = 0;
    for (const waiters of this.waiters.values()) count += waiters.size;
    return count;
  }
}
