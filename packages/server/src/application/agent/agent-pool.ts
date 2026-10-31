import type { HostedAgent, NodeAgentHost } from "@vykor/agent-runtime";
import {
  createCompactContextProvider,
  type VykorAgent,
} from "@vykor/agent-runtime";
import type { CompactContextSection } from "@vykor/core";
import type { SessionMessagePartRecord, SessionMessageRecord, SessionRecord } from "@vykor/domain-contracts/sessions";

import type { LoadDaemonAgent } from "../../daemon/daemon-agent.js";

export interface AgentPoolSessionQueries {
  getSession(sessionId: string): SessionRecord | undefined;
  listSessions(options?: {
    cwd?: string;
    includeArchived?: boolean;
  }): SessionRecord[];
  listMessages(sessionId: string): SessionMessageRecord[];
  listMessageParts(sessionId: string): SessionMessagePartRecord[];
}

export interface AgentPoolContext {
  store?: AgentPoolSessionQueries;
  sessionQueries?: AgentPoolSessionQueries;
  loadAgent?: LoadDaemonAgent;
  supplementalSections?(
    sessionId: string,
  ): CompactContextSection[] | Promise<CompactContextSection[]>;
  sessionMemory?(sessionId: string): string | Promise<string>;
  isSessionExternallyOwned?(sessionId: string): boolean;
  /** Host opt-in: idle warm roots expire after this duration; absent/0 disables. */
  idleTimeoutMs?: number;
  /** Includes queued input, approvals/questions, background work and run cleanup. */
  hasSessionWork?(sessionId: string): boolean;
  /** Atomically excludes normal session operations and verifies the daemon owner. */
  enterIdleEviction?(
    sessionId: string,
    isIdle: () => boolean,
  ): { release(): void } | undefined;
  onIdleEvictionError?(error: unknown, sessionId: string): void;
}

interface AgentPoolEntry {
  promise: Promise<VykorAgent>;
  agent?: VykorAgent;
  host?: NodeAgentHost;
  state: "active" | "closing" | "cleanup_failed";
  closePromise?: Promise<void>;
  /** Soft settings changed while this agent was busy; close once idle. */
  stale?: boolean;
  generation: number;
  idleSince?: number;
  /** Failed idle cleanup retains the resource owner until a confirmed close. */
  retainOnCloseFailure?: boolean;
}

/** One warm framework agent per pool-owned durable session; live children stay framework-owned. */
export class AgentPool {
  private readonly agents = new Map<string, AgentPoolEntry>();
  private readonly sessionQueries: AgentPoolSessionQueries;
  private idleTimer?: ReturnType<typeof setInterval>;
  private idleSweepRunning = false;
  private idleEvictionStopped = false;
  private readonly idleTimeoutMs: number;

  constructor(private readonly context: AgentPoolContext) {
    const queries = context.sessionQueries ?? context.store;
    if (!queries) {
      throw new Error("AgentPool requires sessionQueries");
    }
    this.sessionQueries = queries;
    this.idleTimeoutMs = context.idleTimeoutMs ?? 0;
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs < 0)
      throw new Error("AgentPool idleTimeoutMs must be a finite non-negative number");
    if (this.idleTimeoutMs > 0) {
      this.idleTimer = setInterval(() => {
        void this.evictIdleAgents();
      }, Math.min(30_000, this.idleTimeoutMs));
      this.idleTimer.unref?.();
    }
  }

  /** Daemon shutdown stops the timer before draining operations and closing roots. */
  stopIdleEviction(): void {
    this.idleEvictionStopped = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
  }

  get configured(): boolean {
    return this.context.loadAgent !== undefined;
  }

  peekHost(sessionId: string): NodeAgentHost | undefined { return this.agents.get(sessionId)?.host; }

  get size(): number {
    return this.agents.size;
  }

  hasActiveWork(): boolean {
    return [...this.agents.values()].some((entry) =>
      this.entryHasActiveWork(entry),
    );
  }

  hasActiveWorkForSession(sessionId: string): boolean {
    const entry = this.agents.get(sessionId);
    return entry ? this.entryHasActiveWork(entry) : false;
  }

  hasActiveWorkForCwd(cwd: string): boolean {
    return this.sessionQueries
      .listSessions({ cwd, includeArchived: true })
      .some((session) => this.hasActiveWorkForSession(session.id));
  }

  async warm(sessionId: string): Promise<void> {
    if (
      !this.configured ||
      this.agents.has(sessionId) ||
      this.context.isSessionExternallyOwned?.(sessionId)
    )
      return;
    const session = this.sessionQueries.getSession(sessionId);
    if (
      !session ||
      session.status === "closing" ||
      session.status === "archived"
    )
      return;
    await this.acquireSession(sessionId).catch(() => {});
  }

  async get(sessionId: string): Promise<VykorAgent | undefined> {
    const entry = this.agents.get(sessionId);
    return entry?.state === "active" ? await entry.promise : undefined;
  }

  async acquireHostedSession(sessionId: string): Promise<HostedAgent> {
    const agent = await this.acquire(sessionId);
    const entry = this.agents.get(sessionId);
    if (entry?.agent !== agent)
      throw new Error(`Agent runtime generation changed: ${sessionId}`);
    return { agent, host: entry.host };
  }

  async getHosted(sessionId: string): Promise<HostedAgent | undefined> {
    const agent = await this.get(sessionId);
    const entry = this.agents.get(sessionId);
    return agent && entry?.agent === agent
      ? { agent, host: entry.host }
      : undefined;
  }

  async acquireSession(sessionId: string): Promise<VykorAgent> {
    return await this.acquire(sessionId);
  }

  private async acquire(sessionId: string): Promise<VykorAgent> {
    if (!this.configured) throw new Error("Agent runtime is not configured");
    if (this.context.isSessionExternallyOwned?.(sessionId)) {
      throw new Error(
        `Session runtime is owned by a live child agent: ${sessionId}`,
      );
    }
    const current = this.sessionQueries.getSession(sessionId);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    if (current.status === "closing" || current.status === "archived") {
      throw new Error(`Session runtime is not available: ${sessionId}`);
    }
    const existing = this.agents.get(sessionId);
    if (existing?.state === "active") {
      existing.generation++;
      existing.idleSince = undefined;
      if (existing.stale && !this.entryHasActiveWork(existing)) {
        await this.close(sessionId);
        return await this.acquire(sessionId);
      }
      return await existing.promise;
    }
    if (existing?.closePromise) {
      await existing.closePromise;
      return await this.acquire(sessionId);
    }
    if (existing?.state === "cleanup_failed") {
      await this.close(sessionId);
      return await this.acquire(sessionId);
    }

    const entry = { state: "active" as const, generation: 0 } as AgentPoolEntry;
    const promise = this.create(
      current,
      this.sessionQueries.listMessages(sessionId),
      this.sessionQueries.listMessageParts(sessionId),
      entry,
    ).catch((error) => {
      if (entry.state === "active" && this.agents.get(sessionId) === entry)
        this.agents.delete(sessionId);
      throw error;
    });
    entry.promise = promise;
    this.agents.set(sessionId, entry);
    return await promise;
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.agents.get(sessionId);
    if (!entry) return;
    if (entry.closePromise) return await entry.closePromise;
    entry.state = "closing";
    const closing = (async () => {
      let closed = false;
      try {
        let agent: VykorAgent;
        try {
          agent = entry.agent ?? await entry.promise;
        } catch {
          // Failed creation has no usable agent resource to close.
          closed = true;
          return;
        }
        await agent.close();
        closed = true;
      } finally {
        if (!closed && entry.retainOnCloseFailure) {
          entry.state = "cleanup_failed";
        } else {
          entry.agent = undefined;
          if (this.agents.get(sessionId) === entry) this.agents.delete(sessionId);
        }
      }
    })();
    entry.closePromise = closing;
    try {
      await closing;
    } catch (error) {
      // Also handles a close() that throws before its first await.
      if (entry.retainOnCloseFailure && entry.closePromise === closing)
        entry.closePromise = undefined;
      throw error;
    }
  }

  async closeForCwd(cwd: string): Promise<void> {
    const sessions = this.sessionQueries.listSessions({
      cwd,
      includeArchived: true,
    });
    await this.closeSessions(
      sessions.map((session) => session.id),
      `Agent pool cleanup failed for cwd: ${cwd}`,
    );
  }

  async closeAll(): Promise<void> {
    await this.closeSessions(
      [...this.agents.keys()],
      "Agent pool cleanup failed",
    );
  }

  /**
   * Drop idle warm agents immediately; mark busy ones so they recreate after the
   * current run. Used when soft settings (e.g. workStyle) change mid-flight.
   */
  async invalidateWarmAgents(): Promise<void> {
    const idleSessionIds: string[] = [];
    for (const [sessionId, entry] of this.agents) {
      if (this.entryHasActiveWork(entry)) {
        entry.stale = true;
      } else {
        idleSessionIds.push(sessionId);
      }
    }
    if (idleSessionIds.length === 0) return;
    await this.closeSessions(
      idleSessionIds,
      "Agent pool soft invalidation failed",
    );
  }

  async closeIfStale(sessionId: string): Promise<void> {
    const entry = this.agents.get(sessionId);
    if (!entry?.stale) return;
    if (this.entryHasActiveWork(entry)) return;
    await this.close(sessionId);
  }

  private async create(
    session: SessionRecord,
    history: SessionMessageRecord[],
    parts: SessionMessagePartRecord[],
    entry: AgentPoolEntry,
  ): Promise<VykorAgent> {
    const loadAgent = this.context.loadAgent;
    if (!loadAgent) throw new Error("Agent runtime is not configured");
    const hosted = await loadAgent({ session, history, parts });
    const agent = hosted.agent;
    entry.host = hosted.host;
    if (this.context.supplementalSections || this.context.sessionMemory) {
      agent.setCompactContextProvider(
        createCompactContextProvider({
          ...(this.context.supplementalSections
            ? {
                supplementalSections: () =>
                  this.context.supplementalSections!(session.id),
              }
            : {}),
          ...(this.context.sessionMemory
            ? { sessionMemory: () => this.context.sessionMemory!(session.id) }
            : {}),
        }),
      );
    }
    entry.agent = agent;
    return agent;
  }

  private entryHasActiveWork(entry: AgentPoolEntry): boolean {
    if (entry.state !== "active" || !entry.agent) return true;
    if (entry.agent.state !== "idle") return true;
    return entry.agent.children
      .list()
      .some(
        (child) =>
          child.state === "starting" ||
          child.state === "running" ||
          child.state === "closing",
      );
  }

  private sessionIsIdle(sessionId: string, entry: AgentPoolEntry): boolean {
    return this.agents.get(sessionId) === entry &&
      !this.context.isSessionExternallyOwned?.(sessionId) &&
      !this.context.hasSessionWork?.(sessionId) &&
      this.sessionQueries.getSession(sessionId)?.status === "idle" &&
      !this.entryHasActiveWork(entry);
  }

  private async evictIdleAgents(): Promise<void> {
    if (this.idleEvictionStopped || this.idleSweepRunning) return;
    this.idleSweepRunning = true;
    try {
      for (const [sessionId, entry] of this.agents) {
        try {
          if (!this.sessionIsIdle(sessionId, entry)) {
            entry.idleSince = undefined;
            continue;
          }
          const generation = entry.generation;
          // The framework also checks maintenance and retained descendants.
          // An async check cannot reserve this instance: recheck its generation.
          if (!entry.agent?.canSuspend || !await entry.agent.canSuspend()) {
            entry.idleSince = undefined;
            continue;
          }
          const jobs = await entry.host?.jobs.list({ sessionId, includeFinished: false });
          if (jobs && (jobs.jobs.length > 0 || jobs.errors.length > 0)) {
            entry.idleSince = undefined;
            continue;
          }
          if (this.idleEvictionStopped || generation !== entry.generation || !this.sessionIsIdle(sessionId, entry)) continue;
          const now = Date.now();
          entry.idleSince ??= now;
          if (now - entry.idleSince < this.idleTimeoutMs) continue;
          const isIdle = () => !this.idleEvictionStopped && generation === entry.generation && this.sessionIsIdle(sessionId, entry);
          const lease = this.context.enterIdleEviction
            ? this.context.enterIdleEviction(sessionId, isIdle)
            : isIdle() ? { release() {} } : undefined;
          if (!lease) continue;
          try {
            if (!isIdle()) continue;
            entry.retainOnCloseFailure = true;
            await this.close(sessionId);
          } finally {
            lease.release();
          }
        } catch (error) {
          // A host logger must not turn timer cleanup into an unhandled rejection.
          try { this.context.onIdleEvictionError?.(error, sessionId); } catch {}
        }
      }
    } finally {
      this.idleSweepRunning = false;
    }
  }

  private async closeSessions(
    sessionIds: string[],
    message: string,
  ): Promise<void> {
    const settled = await Promise.allSettled(
      sessionIds.map((sessionId) => this.close(sessionId)),
    );
    const failures = settled
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, message);
  }
}
