import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  AgentChildBudget,
  AgentChildBudgetSnapshot,
  AgentChildController,
  AgentChildDirectory,
  AgentChildHandle,
  AgentChildInput,
  AgentChildInvocation,
  AgentChildResult,
  AgentChildSpawnInput,
  AgentInputReceipt,
  AgentRunHandle,
  AgentRunScope,
  RunCapabilityView,
  Settings,
} from "@openharness/core";
import { AgentChildBudgetExceededError, AgentRunNotAcceptingInputError } from "@openharness/core";

import type { OpenHarnessAgent, OpenHarnessAgentOptions } from "./agent.js";
import type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  OpenHarnessAgentConfiguration,
} from "./agent-options.js";
import {
  createInProcessChildEnvironmentProvider,
  type AgentChildEnvironmentLease,
  type AgentChildEnvironmentProvider,
} from "./child-environment.js";
import type { AgentEventBus } from "./event-source.js";
import { deriveChildAgentOptions, deriveChildCapabilityView } from "./child-agent-options.js";

export type { AgentChildEnvironmentLease, AgentChildEnvironmentProvider } from "./child-environment.js";

interface ChildRecord {
  id: string;
  sessionId: string;
  cwd: string;
  spawn: AgentChildSpawnInput;
  parentScope: AgentRunScope;
  capabilityView?: RunCapabilityView;
  lease: AgentChildEnvironmentLease;
  createAgent(): Promise<OpenHarnessAgent>;
  agent?: OpenHarnessAgent;
  creating?: Promise<OpenHarnessAgent>;
  suspendedHistory?: ReturnType<OpenHarnessAgent["getHistory"]>;
  idleTimer?: ReturnType<typeof setTimeout>;
  suspending?: Promise<void>;
  abortController?: AbortController;
  currentRun?: AgentRunHandle;
  result: Promise<AgentChildResult>;
  startChain: Promise<void>;
  lastResult?: AgentChildResult;
  parentAbortHandler?: () => void;
  requests: Map<string, { input: AgentChildInput; receipt: Promise<AgentInputReceipt>; settled: boolean }>;
  state: AgentChildHandle["state"];
  closePromise?: Promise<void>;
  cleanupPromise?: Promise<void>;
  handle: ChildHandle;
  budgetReservation: AgentChildBudgetReservation;
}

const MAX_CHILD_REQUEST_HISTORY = 256;
export const DEFAULT_AGENT_CHILD_BUDGET: AgentChildBudget = {
  maxDepth: 4,
  maxActiveChildren: 8,
  maxTotalChildren: 64,
};

interface AgentChildBudgetReservation {
  commit(): void;
  rollback(): void;
  release(): void;
}

export interface AgentChildManagerOptions {
  settings: Settings;
  configuration: OpenHarnessAgentConfiguration;
  capabilityOverrides?: AgentCapabilityOverrides;
  effects?: AgentEffectOverrides;
  cwd: string;
  idleTtlMs?: number;
  eventBus: AgentEventBus;
  directory?: AgentChildRegistry;
  environment?: AgentChildEnvironmentProvider;
  onWarning?(event: Record<string, unknown>): void;
  createAgent(
    options: OpenHarnessAgentOptions,
    identity: { childId: string; parentSessionId: string; parentRunId: string },
  ): Promise<OpenHarnessAgent>;
}

/** Shared live-handle index for the complete descendant tree of one root agent. */
export class AgentChildRegistry implements AgentChildDirectory {
  private readonly byId = new Map<string, AgentChildHandle>();
  private readonly bySessionId = new Map<string, AgentChildHandle>();
  private readonly depthBySessionId = new Map<string, number>();
  private budget: AgentChildBudget;
  private activeChildren = 0;
  private totalChildren = 0;

  constructor(budget: AgentChildBudget = DEFAULT_AGENT_CHILD_BUDGET) {
    this.budget = normalizeChildBudget(budget);
  }

  configureBudget(budget: AgentChildBudget): void {
    if (this.activeChildren > 0 || this.totalChildren > 0) {
      if (!isDeepStrictEqual(this.budget, budget)) {
        throw new Error("Child budget cannot change after the root tree starts allocating children");
      }
      return;
    }
    this.budget = normalizeChildBudget(budget);
  }

  snapshotBudget(): AgentChildBudgetSnapshot {
    return { ...this.budget, activeChildren: this.activeChildren, totalChildren: this.totalChildren };
  }

  reserve(parentSessionId: string, childSessionId: string): AgentChildBudgetReservation {
    if (this.depthBySessionId.has(childSessionId)) {
      throw new Error(`Child agent session is already live or being allocated: ${childSessionId}`);
    }
    const childDepth = (this.depthBySessionId.get(parentSessionId) ?? 0) + 1;
    if (childDepth > this.budget.maxDepth) {
      throw new AgentChildBudgetExceededError("depth", this.budget.maxDepth, childDepth);
    }
    if (this.activeChildren >= this.budget.maxActiveChildren) {
      throw new AgentChildBudgetExceededError(
        "activeChildren",
        this.budget.maxActiveChildren,
        this.activeChildren,
      );
    }
    if (this.totalChildren >= this.budget.maxTotalChildren) {
      throw new AgentChildBudgetExceededError(
        "totalChildren",
        this.budget.maxTotalChildren,
        this.totalChildren,
      );
    }

    this.activeChildren++;
    this.totalChildren++;
    this.depthBySessionId.set(childSessionId, childDepth);
    let state: "reserved" | "committed" | "released" = "reserved";
    return {
      commit: () => {
        if (state === "reserved") state = "committed";
      },
      rollback: () => {
        if (state !== "reserved") return;
        state = "released";
        this.activeChildren--;
        this.totalChildren--;
        this.depthBySessionId.delete(childSessionId);
      },
      release: () => {
        if (state === "released") return;
        const rollbackTotal = state === "reserved";
        state = "released";
        this.activeChildren--;
        if (rollbackTotal) this.totalChildren--;
        this.depthBySessionId.delete(childSessionId);
      },
    };
  }

  register(handle: AgentChildHandle): void {
    const existingId = this.byId.get(handle.id);
    const existingSession = this.bySessionId.get(handle.sessionId);
    if ((existingId && existingId !== handle) || (existingSession && existingSession !== handle)) {
      throw new Error(`Child agent identity is already live: ${handle.id}/${handle.sessionId}`);
    }
    this.byId.set(handle.id, handle);
    this.bySessionId.set(handle.sessionId, handle);
  }

  unregister(handle: AgentChildHandle): void {
    if (this.byId.get(handle.id) === handle) this.byId.delete(handle.id);
    if (this.bySessionId.get(handle.sessionId) === handle) this.bySessionId.delete(handle.sessionId);
  }

  get(childId: string): AgentChildHandle | undefined {
    return this.byId.get(childId);
  }

  getBySessionId(sessionId: string): AgentChildHandle | undefined {
    return this.bySessionId.get(sessionId);
  }

  list(): AgentChildHandle[] {
    return [...this.byId.values()];
  }
}

export class AgentChildManager implements AgentChildDirectory {
  private readonly records = new Map<string, ChildRecord>();
  private readonly backgroundClosures = new Set<Promise<void>>();
  private readonly environment: AgentChildEnvironmentProvider;
  private readonly directory: AgentChildRegistry;

  constructor(private readonly options: AgentChildManagerOptions) {
    this.environment =
      options.environment ?? createInProcessChildEnvironmentProvider();
    this.directory = options.directory ?? new AgentChildRegistry();
    this.directory.configureBudget(resolveChildBudget(options.settings.childBudget, options.configuration.childBudget));
  }

  get cwd(): string {
    return this.options.cwd;
  }

  createController(parentScope: AgentRunScope, parentView?: RunCapabilityView): AgentChildController {
    return {
      hasChildAgent: (childId) => this.find(childId) !== undefined,
      spawnChildAgent: (input) => this.spawn(parentScope, input, parentView),
      sendChildInput: (childId, input) => this.send(childId, input),
      interruptChildAgent: (childId, reason) => this.interrupt(childId, reason),
      awaitChildAgent: (childId) => this.awaitResult(childId),
    };
  }

  get(childId: string): AgentChildHandle | undefined {
    return this.find(childId)?.handle;
  }

  getBySessionId(sessionId: string): AgentChildHandle | undefined {
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId) return record.handle;
    }
    return undefined;
  }

  list(): AgentChildHandle[] {
    return [...this.records.values()].map((record) => record.handle);
  }

  getBudgetSnapshot(): AgentChildBudgetSnapshot {
    return this.directory.snapshotBudget();
  }

  async closeAll(): Promise<void> {
    const background = [...this.backgroundClosures];
    const settled = await Promise.allSettled([
      ...[...this.records.keys()].map((id) => this.close(id, "Parent agent closed")),
      ...background,
    ]);
    for (const closing of background) this.backgroundClosures.delete(closing);
    const failures = [...new Set(settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason))];
    throwFailures(failures, "Child agent cleanup failed");
  }

  private async spawn(parentScope: AgentRunScope, input: AgentChildSpawnInput, parentView?: RunCapabilityView): Promise<AgentChildInvocation> {
    const childId = `child_${randomUUID()}`;
    const sessionId = input.sessionId ?? `agent_session_${randomUUID()}`;
    if (this.directory.getBySessionId(sessionId)) {
      throw new Error(`Child agent session is already live: ${sessionId}`);
    }
    let budgetReservation: AgentChildBudgetReservation;
    try {
      budgetReservation = this.directory.reserve(parentScope.sessionId, sessionId);
    } catch (error) {
      if (error instanceof AgentChildBudgetExceededError) {
        this.options.onWarning?.({
          level: "warn",
          event: "agent.child_budget_exceeded",
          dimension: error.dimension,
          limit: error.limit,
          current: error.current,
          parentSessionId: parentScope.sessionId,
        });
      }
      throw error;
    }
    let lease: AgentChildEnvironmentLease;
    let environmentFailure: { error: unknown } | undefined;
    try {
      lease = await this.environment.acquire(input, childId);
    } catch (error) {
      environmentFailure = { error };
      // Announce the failed attempt so the host can persist a failed Child Run.
      lease = { cwd: input.cwd, release: async () => {} };
    }
    const record = {} as ChildRecord;
    const handle = new ChildHandle(this, () => record);
    Object.assign(record, {
      id: childId,
      sessionId,
      cwd: lease.cwd,
      spawn: input,
      parentScope,
      lease,
      createAgent: () => this.options.createAgent(deriveChildAgentOptions({
        configuration: this.options.configuration,
        settings: this.options.settings,
        capabilityOverrides: this.options.capabilityOverrides,
        effects: this.options.effects,
        child: input,
        cwd: lease.cwd,
        sessionId,
      }), {
        childId,
        parentSessionId: parentScope.sessionId,
        parentRunId: parentScope.runId,
      }),
      result: Promise.resolve({ status: "completed", output: "" }),
      startChain: Promise.resolve(),
      requests: new Map(),
      state: "starting",
      handle,
      budgetReservation,
    } satisfies Partial<ChildRecord>);

    let announced = false;
    try {
      this.directory.register(handle);
      this.records.set(childId, record);
      await this.emitChild(record, {
        type: "child.created",
        data: {
          childId,
          sessionId,
          spawn: input,
          cwd: lease.cwd,
          ...(lease.worktree ? { worktree: lease.worktree } : {}),
        },
      });
      announced = true;
      if (environmentFailure) throw environmentFailure.error;
      // A normal Coordinator role is not the host ceiling for its workers.
      // Normal children rebuild their non-plugin baseline under their own role;
      // a selected plugin keeps the parent's captured bindings and cannot widen.
      record.capabilityView = parentView?.pluginId
        ? deriveChildCapabilityView(parentView, input)
        : undefined;
      await this.ensureAgent(record, false);
      const parentAbortHandler = () => {
        void this.interrupt(childId, "Parent run interrupted").catch(() => {});
      };
      record.parentAbortHandler = parentAbortHandler;
      parentScope.signal.addEventListener("abort", parentAbortHandler, { once: true });
      if (parentScope.signal.aborted) {
        await this.interrupt(childId, "Parent run interrupted");
        throw new Error("Parent run interrupted");
      }
      const receipt = await this.beginRun(record, { content: input.prompt });
      budgetReservation.commit();
      return {
        id: childId,
        sessionId,
        inputId: receipt.inputId,
        runId: receipt.runId,
        result: record.result,
        ...(lease.worktree ? { worktree: lease.worktree } : {}),
      };
    } catch (error) {
      try {
        await this.closeRecord(record, failedResult(error), announced);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Child agent startup cleanup failed: ${childId}`);
      }
      throw error;
    }
  }

  async send(childId: string, input: AgentChildInput): Promise<AgentInputReceipt> {
    const record = this.require(childId);
    if (isChildUnavailable(record)) throw new Error(`Child agent is closing or closed: ${childId}`);
    if (input.id) {
      const existing = record.requests.get(input.id);
      if (existing) {
        if (!sameChildInput(existing.input, input)) throw new Error(`Child input id is already used: ${input.id}`);
        return await existing.receipt;
      }
      const receipt = this.sendToRecord(record, input);
      const request = { input, receipt, settled: false };
      record.requests.set(input.id, request);
      void receipt.then(
        () => {
          request.settled = true;
          this.trimRequestHistory(record);
        },
        () => {
          request.settled = true;
          this.trimRequestHistory(record);
        },
      );
      return await receipt;
    }
    return await this.sendToRecord(record, input);
  }

  async interrupt(childId: string, reason?: string): Promise<void> {
    await this.close(childId, reason ?? "Child agent interrupted");
  }

  async close(childId: string, reason?: string): Promise<void> {
    const record = this.find(childId);
    if (!record) return;
    if (record.closePromise) return await record.closePromise;
    record.state = "closing";
    const closing = (async () => {
      const failures: unknown[] = [];
      const activeRun = record.currentRun;
      record.abortController?.abort(reason ?? "Child agent closed");
      try {
        await activeRun?.interrupt(reason ?? "Child agent closed");
      } catch (error) {
        failures.push(error);
      }
      const settled = activeRun && failures.length === 0
        ? await record.result.catch((error) => failedResult(error))
        : undefined;
      const result = activeRun
        ? settled ?? { status: "interrupted" as const, output: reason ?? "Child agent stopped" }
        : record.lastResult ?? { status: "stopped" as const, output: reason ?? "Child agent stopped" };
      try {
        await this.closeRecord(record, result, true);
      } catch (error) {
        failures.push(error);
      }
      throwFailures(failures, `Child agent cleanup failed: ${childId}`);
    })();
    record.closePromise = closing;
    await closing;
  }

  private async sendToRecord(record: ChildRecord, input: AgentChildInput): Promise<AgentInputReceipt> {
    const activeRun = record.currentRun;
    if (input.delivery !== "queue" && activeRun) {
      try {
        return await activeRun.steer(input);
      } catch (error) {
        if (!(error instanceof AgentRunNotAcceptingInputError)) throw error;
        await activeRun.result.catch(() => {});
      }
    }
    let receipt: AgentInputReceipt | undefined;
    const scheduled = record.startChain.then(async () => {
      await record.result.catch(() => {});
      if (isChildUnavailable(record)) throw new Error(`Child agent is closing or closed: ${record.id}`);
      receipt = await this.beginRun(record, input);
    });
    record.startChain = scheduled.then(() => {}, () => {});
    await scheduled;
    return receipt!;
  }

  private async beginRun(record: ChildRecord, input: AgentChildInput): Promise<AgentInputReceipt> {
    const agent = await this.ensureAgent(record);
    if (isChildUnavailable(record)) throw new Error(`Child agent is closing or closed: ${record.id}`);
    const controller = new AbortController();
    record.abortController = controller;
    record.state = "running";
    const ids = {
      inputId: input.id ?? `input_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      traceId: input.traceId ?? randomUUID(),
    };
    const run = agent.submitMessage(input.content, {
      capabilityView: record.capabilityView,
      ids,
      inputItems: input.inputItems,
      signal: controller.signal,
      delivery: input.delivery ?? "queue",
      metadata: input.metadata,
    });
    record.currentRun = run;
    const result = run.result.then<AgentChildResult>((completed) => ({
      status: "completed",
      output: completed.output,
    })).catch<AgentChildResult>((error) => controller.signal.aborted
      ? { status: "interrupted", output: "", error: errorMessage(error) }
      : failedResult(error));
    record.result = result.finally(() => {
      if (record.abortController === controller) record.abortController = undefined;
      if (record.currentRun === run) record.currentRun = undefined;
      if (!isChildUnavailable(record)) record.state = "idle";
    }).then((settled) => {
      record.lastResult = settled;
      this.scheduleSuspend(record);
      return settled;
    });
    void record.result.catch(() => {});
    const receipt = await run.started;
    if (
      receipt.sessionId !== record.sessionId ||
      receipt.inputId !== ids.inputId ||
      receipt.runId !== ids.runId
    ) {
      await run.interrupt("Child run started with unexpected identity");
      throw new Error(`Child run identity conflict: ${receipt.sessionId}/${receipt.inputId}/${receipt.runId}`);
    }
    return receipt;
  }

  private async awaitResult(childId: string): Promise<AgentChildResult> {
    return await this.require(childId).result;
  }

  private trimRequestHistory(record: ChildRecord): void {
    if (record.requests.size <= MAX_CHILD_REQUEST_HISTORY) return;
    for (const [id, request] of record.requests) {
      if (!request.settled) continue;
      record.requests.delete(id);
      if (record.requests.size <= MAX_CHILD_REQUEST_HISTORY) return;
    }
  }

  private async ensureAgent(record: ChildRecord, announceResume = true): Promise<OpenHarnessAgent> {
    this.clearIdleTimer(record);
    await record.suspending;
    if (isChildUnavailable(record)) throw new Error(`Child agent is closing or closed: ${record.id}`);
    if (record.agent) return record.agent;
    const creating = record.creating ?? record.createAgent();
    record.creating = creating;
    void creating.catch(() => {});
    try {
      const agent = await creating;
      if (isChildUnavailable(record)) throw new Error(`Child agent is closing or closed: ${record.id}`);
      if (record.suspendedHistory) agent.loadHistory(record.suspendedHistory);
      record.agent = agent;
      record.state = "idle";
      if (announceResume) {
        await this.emitChild(record, {
          type: "child.resumed",
          data: { childId: record.id, sessionId: record.sessionId },
        });
      }
      if (isChildUnavailable(record)) throw new Error(`Child agent is closing or closed: ${record.id}`);
      return agent;
    } catch (error) {
      const agent = await creating.catch(() => undefined);
      if (agent) {
        if (record.agent === agent) record.agent = undefined;
        if (!record.cleanupPromise) {
          try {
            await agent.close();
          } catch (cleanupError) {
            throw combineFailures(
              error,
              cleanupError,
              `Child agent initialization and cleanup failed: ${record.id}`,
            );
          }
        }
      }
      throw error;
    } finally {
      if (record.creating === creating) record.creating = undefined;
    }
  }

  private scheduleSuspend(record: ChildRecord): void {
    const idleTtlMs = this.options.idleTtlMs ?? 5 * 60_000;
    if (idleTtlMs <= 0 || isChildUnavailable(record)) return;
    this.clearIdleTimer(record);
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      if (record.state !== "idle" || !record.agent) return;
      const agent = record.agent;
      const suspending = (async () => {
        record.suspendedHistory = agent.getHistory();
        await agent.close();
        if (record.agent === agent) record.agent = undefined;
        if (isChildUnavailable(record)) return;
        record.state = "suspended";
        await this.emitChild(record, {
          type: "child.suspended",
          data: { childId: record.id, sessionId: record.sessionId },
        });
      })().finally(() => {
        if (record.suspending === suspending) record.suspending = undefined;
      });
      record.suspending = suspending;
      void suspending.catch((error) => {
        if (isChildUnavailable(record) || !this.records.has(record.id)) return;
        record.state = "closing";
        const closing = (async () => {
          try {
            await this.closeRecord(record, failedResult(error), true);
          } catch (cleanupError) {
            throw combineFailures(
              error,
              cleanupError,
              `Child agent suspension and cleanup failed: ${record.id}`,
            );
          }
          throw error;
        })();
        record.closePromise = closing;
        this.backgroundClosures.add(closing);
        void closing.catch(() => {});
      });
    }, idleTtlMs);
    record.idleTimer.unref?.();
  }

  private closeRecord(record: ChildRecord, result: AgentChildResult, emit: boolean): Promise<void> {
    if (record.cleanupPromise) return record.cleanupPromise;
    const cleanup = this.closeRecordWork(record, result, emit);
    record.cleanupPromise = cleanup;
    return cleanup;
  }

  private async closeRecordWork(record: ChildRecord, result: AgentChildResult, emit: boolean): Promise<void> {
    if (record.state === "closed" && !this.records.has(record.id)) return;
    const failures: unknown[] = [];
    record.state = "closed";
    this.detachParentAbort(record);
    this.clearIdleTimer(record);
    try {
      await record.suspending;
    } catch (error) {
      failures.push(error);
    }
    const creating = record.creating;
    const created = creating ? await creating.catch(() => undefined) : undefined;
    try {
      await (record.agent ?? created)?.close();
    } catch (error) {
      failures.push(error);
    }
    record.agent = undefined;
    try {
      await record.lease.release(result);
    } catch (error) {
      failures.push(error);
    }
    try {
      if (emit) {
        try {
          await this.emitChild(record, {
            type: "child.closed",
            data: { childId: record.id, sessionId: record.sessionId, result },
          });
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      this.deleteRecord(record);
    }
    throwFailures(failures, `Child agent cleanup failed: ${record.id}`);
  }

  private async emitChild(record: ChildRecord, event: Parameters<AgentEventBus["emit"]>[0]): Promise<void> {
    await this.options.eventBus.emit(event, {
      agentId: record.parentScope.agentId,
      sessionId: record.parentScope.sessionId,
      inputId: record.parentScope.inputId,
      runId: record.parentScope.runId,
      traceId: record.parentScope.traceId,
      childId: record.id,
    });
  }

  private find(value: string): ChildRecord | undefined {
    return this.records.get(value);
  }

  private require(value: string): ChildRecord {
    const record = this.find(value);
    if (!record) throw new Error(`Child agent not found: ${value}`);
    return record;
  }

  private deleteRecord(record: ChildRecord): void {
    this.directory.unregister(record.handle);
    this.records.delete(record.id);
    record.budgetReservation.release();
  }

  private clearIdleTimer(record: ChildRecord): void {
    if (!record.idleTimer) return;
    clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
  }

  private detachParentAbort(record: ChildRecord): void {
    if (!record.parentAbortHandler) return;
    record.parentScope.signal.removeEventListener("abort", record.parentAbortHandler);
    record.parentAbortHandler = undefined;
  }
}

class ChildHandle implements AgentChildHandle {
  constructor(
    private readonly manager: AgentChildManager,
    private readonly record: () => ChildRecord,
  ) {}

  get id(): string { return this.record().id; }
  get sessionId(): string { return this.record().sessionId; }
  get state(): AgentChildHandle["state"] { return this.record().state; }
  get result(): Promise<AgentChildResult> { return this.record().result; }
  send(input: AgentChildInput): Promise<AgentInputReceipt> { return this.manager.send(this.id, input); }
  interrupt(reason?: string): Promise<void> { return this.manager.interrupt(this.id, reason); }
  close(): Promise<void> { return this.manager.close(this.id); }
}

function sameChildInput(left: AgentChildInput, right: AgentChildInput): boolean {
  return left.content === right.content &&
    (left.delivery ?? "steer") === (right.delivery ?? "steer") &&
    isDeepStrictEqual(left.metadata ?? {}, right.metadata ?? {});
}

function resolveChildBudget(
  settings: Partial<AgentChildBudget> | undefined,
  configuration: Partial<AgentChildBudget> | undefined,
): AgentChildBudget {
  return normalizeChildBudget({ ...DEFAULT_AGENT_CHILD_BUDGET, ...settings, ...configuration });
}

function normalizeChildBudget(budget: AgentChildBudget): AgentChildBudget {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Child budget ${name} must be a non-negative safe integer`);
    }
  }
  return { ...budget };
}

function isChildUnavailable(record: ChildRecord): boolean {
  return record.state === "closing" || record.state === "closed";
}

function failedResult(error: unknown): AgentChildResult {
  const message = errorMessage(error);
  return { status: "failed", output: message, error: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

function combineFailures(primary: unknown, cleanup: unknown, message: string): unknown {
  const cleanupFailures = cleanup instanceof AggregateError ? cleanup.errors : [cleanup];
  const failures = [primary, ...cleanupFailures.filter((failure) => failure !== primary)];
  return failures.length === 1 ? primary : new AggregateError(failures, message);
}
