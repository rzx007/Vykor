import { canonicalToolName, canonicalToolNames } from "@vykor/agent-contracts";
import {
  AgentChildBudgetExceededError,
  AgentRunNotAcceptingInputError,
  ChildRunTerminationError,
  readonlyMap,
} from "@vykor/agent-contracts";
import type {
  AgentChildBudget,
  AgentChildBudgetSnapshot,
  AgentChildController,
  AgentChildDirectory,
  AgentChildHandle,
  AgentChildInput,
  AgentChildInvocation,
  AgentChildSpawnInput,
  AgentInputReceipt,
  AgentExecutionLimits,
  AgentRunHandle,
  AgentRunScope,
  ChildActivitySnapshot,
  AgentChildResult,
  ChildFailureKind,
  RunToolBinding,
  AgentModelConfiguration,
} from "@vykor/agent-contracts";
import { MaxTurnsExceeded } from "@vykor/core/engine";
import type { VykorAgent } from "../agent.js";
import {
  createInProcessChildEnvironmentProvider,
  type AgentChildEnvironmentLease,
  type AgentChildEnvironmentProvider,
} from "./child-environment.js";
import type { AgentEventBus } from "../event-source.js";
import {
  AgentChildRegistry,
  type AgentChildBudgetReservation,
} from "./child-registry.js";
import {
  applyChildActivityEvent,
  partialResultFields,
  type ChildActivityState,
} from "./child-activity.js";
const randomUUID = () => globalThis.crypto.randomUUID();
import { equalData as isDeepStrictEqual } from "../equality.js";
export type {
  AgentChildEnvironmentLease,
  AgentChildEnvironmentProvider,
} from "./child-environment.js";
export {
  AgentChildRegistry,
  DEFAULT_AGENT_CHILD_BUDGET,
} from "./child-registry.js";
type ChildTools = ReadonlyMap<string, RunToolBinding>;
/** Captured by the host at submission, never read from model input metadata. */
export type TrustedChildRunParent = Pick<
  AgentRunScope,
  "sessionId" | "runId" | "signal"
> & { limits?: AgentExecutionLimits };

interface ChildRecord {
  id: string;
  sessionId: string;
  cwd: string;
  spawn: AgentChildSpawnInput;
  parentScope: AgentRunScope;
  /** Trusted host-owned system child (post-run review); never set from Agent tool input. */
  system: boolean;
  tools?: ChildTools;
  hardMaxTurns?: number | (() => number | undefined);
  lease: AgentChildEnvironmentLease;
  createAgent(): Promise<VykorAgent>;
  agent?: VykorAgent;
  creating?: Promise<VykorAgent>;
  suspendedHistory?: ReturnType<VykorAgent["getHistory"]>;
  idleTimer?: ReturnType<typeof setTimeout>;
  runDeadline?: ReturnType<typeof setTimeout>;
  suspending?: Promise<void>;
  abortController?: AbortController;
  currentRun?: AgentRunHandle;
  result: Promise<AgentChildResult>;
  startChain: Promise<void>;
  lastResult?: AgentChildResult;
  currentRunParent?: TrustedChildRunParent | null;
  requests: Map<
    string,
    {
      input: AgentChildInput;
      parent: TrustedChildRunParent | null;
      receipt: Promise<AgentInputReceipt>;
      settled: boolean;
    }
  >;
  state: AgentChildHandle["state"];
  activity?: ChildActivityState;
  activityRunId?: string;
  activityUnsubscribe?: () => void;
  /** Trusted origin of an explicit cancellation, never inferred from reason text. */
  cancelSource?: Extract<
    ChildFailureKind,
    "user_cancelled" | "parent_interrupted"
  >;
  closePromise?: Promise<void>;
  cleanupPromise?: Promise<void>;
  handle: ChildHandle;
  budgetReservation: AgentChildBudgetReservation;
}

const MAX_CHILD_REQUEST_HISTORY = 256;

function authorizesChildTools(child: ChildTools, parent?: ChildTools): boolean {
  if (!parent) return child.size === 0;
  for (const [name, binding] of child) {
    const current = parent.get(name);
    if (
      !current ||
      current.definitionIdentity !== binding.definitionIdentity ||
      current.definition.execute !== binding.definition.execute ||
      !isDeepStrictEqual(current.source, binding.source)
    )
      return false;
  }
  return true;
}
export interface ResolvedChildExecution {
  spawn: AgentChildSpawnInput;
  parentRequestConfiguration?: AgentModelConfiguration;
  hardMaxTurns?: number | (() => number | undefined);
  createAgent(): Promise<VykorAgent>;
}

export interface AgentChildManagerOptions {
  cwd: string;
  budget?: AgentChildBudget;
  idleTtlMs?: number;
  eventBus: AgentEventBus;
  directory?: AgentChildRegistry;
  environment?: AgentChildEnvironmentProvider;
  onWarning?(event: Record<string, unknown>): void;
  resolveChild(input: {
    spawn: AgentChildSpawnInput;
    lease: AgentChildEnvironmentLease;
    childId: string;
    sessionId: string;
    parentScope: AgentRunScope;
    tools?: ChildTools;
    system: boolean;
  }): ResolvedChildExecution;
}

export class AgentChildManager implements AgentChildDirectory {
  private readonly records = new Map<string, ChildRecord>();
  private readonly backgroundClosures = new Set<Promise<void>>();
  private readonly environment: AgentChildEnvironmentProvider;
  private readonly directory: AgentChildRegistry;
  private systemChildId?: string;

  constructor(private readonly options: AgentChildManagerOptions) {
    this.environment =
      options.environment ?? createInProcessChildEnvironmentProvider();
    this.directory = options.directory ?? new AgentChildRegistry();
    this.directory.configureBudget(
      options.budget ?? this.directory.snapshotBudget(),
    );
  }

  get cwd(): string {
    return this.options.cwd;
  }

  createController(
    parentScope: AgentRunScope & { limits?: AgentExecutionLimits },
    tools?: ChildTools,
  ): AgentChildController {
    const captured = tools && readonlyMap(tools);
    return {
      hasChildAgent: (id) => this.find(id) !== undefined,
      spawnChildAgent: (input) => this.spawn(parentScope, input, captured),
      sendChildInput: (id, input) =>
        this.send(id, input, captured, captureParent(parentScope)),
      interruptChildAgent: (id, reason) => this.interrupt(id, reason),
      awaitChildAgent: (id) => this.awaitResult(id),
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
      ...[...this.records.keys()].map((id) =>
        this.close(id, "Parent agent closed"),
      ),
      ...background,
    ]);
    for (const closing of background) this.backgroundClosures.delete(closing);
    const failures = [
      ...new Set(
        settled
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason),
      ),
    ];
    throwFailures(failures, "Child agent cleanup failed");
  }

  /**
   * Trusted host-only spawn for a bounded post-run system child (for example a
   * read-only reviewer). It counts toward depth and activeChildren, runs at most
   * one at a time, never consumes the model-callable cumulative child budget, and
   * is force-limited to zero model-visible tools. The sensitive initial content is
   * the child's first message; it never appears in persisted spawn summaries.
   */
  async spawnSystemChild(
    parentScope: AgentRunScope & { limits?: AgentExecutionLimits },
    input: AgentChildSpawnInput,
    sensitiveInitialContent: string,
    tools?: ChildTools,
  ): Promise<AgentChildInvocation> {
    if (this.systemChildId !== undefined) {
      throw new Error("A system review child is already active");
    }
    return await this.spawnInternal(parentScope, input, {
      system: true,
      ...(tools ? { tools } : {}),
      initialContent: sensitiveInitialContent,
    });
  }

  private async spawn(
    parentScope: AgentRunScope & { limits?: AgentExecutionLimits },
    input: AgentChildSpawnInput,
    tools?: ChildTools,
  ): Promise<AgentChildInvocation> {
    return await this.spawnInternal(parentScope, input, { tools });
  }

  private async spawnInternal(
    parentScope: AgentRunScope & { limits?: AgentExecutionLimits },
    input: AgentChildSpawnInput,
    options: {
      tools?: ChildTools;
      system?: boolean;
      initialContent?: string;
    },
  ): Promise<AgentChildInvocation> {
    await parentScope.limits?.check("child");
    const system = options.system === true;

    const childId = `child_${randomUUID()}`;
    const sessionId = input.sessionId ?? `agent_session_${randomUUID()}`;
    if (system) {
      if (this.systemChildId !== undefined) {
        throw new Error("A system review child is already active");
      }
      this.systemChildId = childId;
    }
    if (this.directory.getBySessionId(sessionId)) {
      if (system && this.systemChildId === childId)
        this.systemChildId = undefined;
      throw new Error(`Child agent session is already live: ${sessionId}`);
    }
    let budgetReservation: AgentChildBudgetReservation;
    try {
      budgetReservation = this.directory.reserve(
        parentScope.sessionId,
        sessionId,
        { system },
      );
    } catch (error) {
      if (system && this.systemChildId === childId)
        this.systemChildId = undefined;
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
    let resolved: ResolvedChildExecution;
    try {
      resolved = this.options.resolveChild({
        spawn: input,
        lease,
        childId,
        sessionId,
        parentScope,
        tools: options.tools,
        system,
      });
    } catch (error) {
      budgetReservation.rollback();
      if (system && this.systemChildId === childId)
        this.systemChildId = undefined;
      await lease.release(failedResult(error));
      throw error;
    }
    const parentRequestConfiguration: Partial<AgentModelConfiguration> & {
      baseUrl?: string;
    } = resolved.parentRequestConfiguration ?? {};
    const resolvedSpawn = resolved.spawn;
    const allowed =
      resolvedSpawn.allowedTools &&
      new Set(canonicalToolNames(resolvedSpawn.allowedTools));
    const denied = new Set(
      canonicalToolNames(resolvedSpawn.disallowedTools ?? []),
    );
    const tools =
      options.tools &&
      readonlyMap(
        [...options.tools].filter(
          ([name]) =>
            (!allowed ||
              allowed.has("*") ||
              allowed.has(canonicalToolName(name))) &&
            !denied.has("*") &&
            !denied.has(canonicalToolName(name)),
        ),
      );
    const handle = new ChildHandle(this, () => record);
    Object.assign(record, {
      id: childId,
      sessionId,
      cwd: lease.cwd,
      spawn: resolvedSpawn,
      parentScope,
      system,
      lease,
      // The child session exists only after child.created has been projected.
      createAgent: resolved.createAgent,
      tools,
      hardMaxTurns: resolved.hardMaxTurns,
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
      record.activityUnsubscribe = this.options.eventBus.subscribe((event) => {
        applyChildActivityEvent(record, event);
      });
      await this.emitChild(record, {
        type: "child.created",
        data: {
          childId,
          sessionId,
          spawn: resolvedSpawn,
          ...(parentRequestConfiguration.model
            ? {
                parentRequestConfiguration: {
                  model: parentRequestConfiguration.model,
                  ...(parentRequestConfiguration.provider
                    ? { provider: parentRequestConfiguration.provider }
                    : {}),
                  ...(parentRequestConfiguration.baseUrl !== undefined
                    ? { baseUrl: parentRequestConfiguration.baseUrl }
                    : {}),
                  ...(parentRequestConfiguration.apiFormat
                    ? { apiFormat: parentRequestConfiguration.apiFormat }
                    : {}),
                  ...(parentRequestConfiguration.effort !== undefined
                    ? { effort: parentRequestConfiguration.effort }
                    : {}),
                },
              }
            : {}),
          cwd: lease.cwd,
          ...(lease.worktree ? { worktree: lease.worktree } : {}),
        },
      });
      announced = true;
      if (environmentFailure) throw environmentFailure.error;
      await this.ensureAgent(record, false);
      const receipt = await this.beginRun(
        record,
        {
          content: options.initialContent ?? childInitialTask(input),
          ...(system ? { metadata: { sensitiveInput: true } } : {}),
        },
        captureParent(parentScope),
      );
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
        throw new AggregateError(
          [error, cleanupError],
          `Child agent startup cleanup failed: ${childId}`,
        );
      }
      throw error;
    }
  }

  async send(
    childId: string,
    input: AgentChildInput,
    authorization?: ChildTools,
    parent: TrustedChildRunParent | null = null,
  ): Promise<AgentInputReceipt> {
    const record = this.require(childId);
    if (isChildUnavailable(record))
      throw new Error(`Child agent is closing or closed: ${childId}`);
    const childView = record.tools;
    if (childView && !authorizesChildTools(childView, authorization)) {
      throw new Error("Child tools are not authorized for this Run.");
    }
    if (input.id) {
      const existing = record.requests.get(input.id);
      if (existing) {
        if (
          !sameChildInput(existing.input, input) ||
          !sameParent(existing.parent, parent)
        )
          throw new Error(`Child input id is already used: ${input.id}`);
        return await existing.receipt;
      }
      const receipt = this.sendToRecord(record, input, parent);
      const request = { input, parent, receipt, settled: false };
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
    return await this.sendToRecord(record, input, parent);
  }

  async interruptRun(
    childId: string,
    expectedRunId: string,
    reason = "Child run interrupted",
  ): Promise<boolean> {
    const record = this.find(childId);
    const run = record?.currentRun;
    if (!record || !run || run.id !== expectedRunId) return false;
    const result = record.result;
    record.cancelSource = "user_cancelled";
    record.abortController?.abort(
      new ChildRunTerminationError("user_cancelled", reason),
    );
    await run.interrupt(reason);
    await result;
    return true;
  }

  async interrupt(childId: string, reason?: string): Promise<void> {
    const record = this.find(childId);
    if (record && !record.cancelSource) record.cancelSource = "user_cancelled";
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
      record.abortController?.abort(
        record.cancelSource
          ? new ChildRunTerminationError(
              record.cancelSource,
              reason ?? "Child agent closed",
            )
          : (reason ?? "Child agent closed"),
      );
      try {
        await activeRun?.interrupt(reason ?? "Child agent closed");
      } catch (error) {
        failures.push(error);
      }
      const settled =
        activeRun && failures.length === 0
          ? await record.result.catch((error) => failedResult(error))
          : undefined;
      const result = activeRun
        ? (settled ?? {
            status: "interrupted" as const,
            output: reason ?? "Child agent stopped",
          })
        : (record.lastResult ?? {
            status: "stopped" as const,
            output: reason ?? "Child agent stopped",
          });
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

  private async sendToRecord(
    record: ChildRecord,
    input: AgentChildInput,
    parent: TrustedChildRunParent | null,
  ): Promise<AgentInputReceipt> {
    const activeRun = record.currentRun;
    if (parent?.signal.aborted) throw new Error("Parent run interrupted");
    if (
      input.delivery !== "queue" &&
      activeRun &&
      parent &&
      sameParent(record.currentRunParent, parent)
    ) {
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
      if (isChildUnavailable(record))
        throw new Error(`Child agent is closing or closed: ${record.id}`);
      receipt = await this.beginRun(record, input, parent);
    });
    record.startChain = scheduled.then(
      () => {},
      () => {},
    );
    await scheduled;
    return receipt!;
  }

  private async beginRun(
    record: ChildRecord,
    input: AgentChildInput,
    parent: TrustedChildRunParent | null,
  ): Promise<AgentInputReceipt> {
    await parent?.limits?.check("child");
    if (parent?.signal.aborted) throw new Error("Parent run interrupted");
    const agent = await this.ensureAgent(record);
    if (isChildUnavailable(record))
      throw new Error(`Child agent is closing or closed: ${record.id}`);
    if (parent?.signal.aborted) throw new Error("Parent run interrupted");
    const controller = new AbortController();
    record.abortController = controller;
    record.currentRunParent = parent;
    record.cancelSource = undefined;
    const parentAbortHandler = () => {
      if (record.abortController !== controller) return;
      record.cancelSource = "parent_interrupted";
      controller.abort(
        new ChildRunTerminationError(
          "parent_interrupted",
          "Parent run interrupted",
        ),
      );
      void record.currentRun
        ?.interrupt("Parent run interrupted")
        .catch(() => {});
    };
    parent?.signal.addEventListener("abort", parentAbortHandler, {
      once: true,
    });
    record.state = "running";
    const ids = {
      inputId: input.id ?? `input_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      traceId: input.traceId ?? randomUUID(),
    };
    record.activityRunId = ids.runId;
    record.activity = undefined;
    const hardMaxTurns =
      typeof record.hardMaxTurns === "function"
        ? record.hardMaxTurns()
        : record.hardMaxTurns;
    const timeoutMs = childRunTimeoutMs(record.spawn);
    let timedOut = false;
    if (timeoutMs !== undefined) {
      // Trusted deadline source: the flag, never the abort reason text, classifies the failure.
      record.runDeadline = setTimeout(() => {
        timedOut = true;
        controller.abort(
          new ChildRunTerminationError(
            "timeout",
            childTimeoutMessage(timeoutMs),
          ),
        );
      }, timeoutMs);
      record.runDeadline.unref?.();
    }
    let run: AgentRunHandle;
    try {
      run = agent.submitMessage(input.content, {
        childRunParent: parent,
        limits: parent?.limits?.forChildRun?.(ids.runId) ?? parent?.limits,
        tools: record.tools,
        ids,
        inputItems: input.inputItems,
        signal: controller.signal,
        delivery: input.delivery ?? "queue",
        metadata: input.metadata,
        ...(hardMaxTurns !== undefined ? { hardMaxTurns } : {}),
      });
    } catch (error) {
      parent?.signal.removeEventListener("abort", parentAbortHandler);
      this.clearRunDeadline(record);
      if (record.abortController === controller)
        record.abortController = undefined;
      throw error;
    }
    record.currentRun = run;
    const result = run.result
      .then<AgentChildResult>((completed) => ({
        status: "completed",
        output: completed.output,
      }))
      .catch<AgentChildResult>((error) => {
        const message = errorMessage(error);
        if (timedOut) {
          const timeoutMessage = childTimeoutMessage(timeoutMs!);
          return {
            status: "failed",
            output: timeoutMessage,
            error: timeoutMessage,
            failureKind: "timeout",
            ...partialResultFields(record, ids.runId),
          };
        }
        if (error instanceof MaxTurnsExceeded) {
          return {
            status: "failed",
            output: message,
            error: message,
            failureKind: "max_turns",
            ...partialResultFields(record, ids.runId, error.finalizationText),
          };
        }
        if (controller.signal.aborted) {
          return {
            status: "interrupted",
            output: "",
            error: message,
            failureKind: record.cancelSource ?? "unknown",
            ...partialResultFields(record, ids.runId),
          };
        }
        return {
          status: "failed",
          output: message,
          error: message,
          failureKind: "unknown",
          ...partialResultFields(record, ids.runId),
        };
      });
    record.result = result
      .finally(() => {
        parent?.signal.removeEventListener("abort", parentAbortHandler);
        this.clearRunDeadline(record);
        if (record.abortController === controller)
          record.abortController = undefined;
        if (record.currentRun === run) record.currentRun = undefined;
        if (!isChildUnavailable(record)) record.state = "idle";
      })
      .then((settled) => {
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
      throw new Error(
        `Child run identity conflict: ${receipt.sessionId}/${receipt.inputId}/${receipt.runId}`,
      );
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

  private async ensureAgent(
    record: ChildRecord,
    announceResume = true,
  ): Promise<VykorAgent> {
    this.clearIdleTimer(record);
    await record.suspending;
    if (isChildUnavailable(record))
      throw new Error(`Child agent is closing or closed: ${record.id}`);
    if (record.agent) return record.agent;
    const creating = record.creating ?? record.createAgent();
    record.creating = creating;
    void creating.catch(() => {});
    try {
      const agent = await creating;
      if (isChildUnavailable(record))
        throw new Error(`Child agent is closing or closed: ${record.id}`);
      if (record.suspendedHistory) agent.loadHistory(record.suspendedHistory);
      record.agent = agent;
      record.state = "idle";
      if (announceResume) {
        await this.emitChild(record, {
          type: "child.resumed",
          data: { childId: record.id, sessionId: record.sessionId },
        });
      }
      if (isChildUnavailable(record))
        throw new Error(`Child agent is closing or closed: ${record.id}`);
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

  private closeRecord(
    record: ChildRecord,
    result: AgentChildResult,
    emit: boolean,
  ): Promise<void> {
    if (record.cleanupPromise) return record.cleanupPromise;
    const cleanup = this.closeRecordWork(record, result, emit);
    record.cleanupPromise = cleanup;
    return cleanup;
  }

  private async closeRecordWork(
    record: ChildRecord,
    result: AgentChildResult,
    emit: boolean,
  ): Promise<void> {
    if (record.state === "closed" && !this.records.has(record.id)) return;
    const failures: unknown[] = [];
    record.state = "closed";
    this.clearIdleTimer(record);
    this.clearRunDeadline(record);
    try {
      await record.suspending;
    } catch (error) {
      failures.push(error);
    }
    const creating = record.creating;
    const created = creating
      ? await creating.catch(() => undefined)
      : undefined;
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

  private async emitChild(
    record: ChildRecord,
    event: Parameters<AgentEventBus["emit"]>[0],
  ): Promise<void> {
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
    record.activityUnsubscribe?.();
    record.activityUnsubscribe = undefined;
    this.directory.unregister(record.handle);
    this.records.delete(record.id);
    if (record.system && this.systemChildId === record.id)
      this.systemChildId = undefined;
    record.budgetReservation.release();
  }

  private clearIdleTimer(record: ChildRecord): void {
    if (!record.idleTimer) return;
    clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
  }

  private clearRunDeadline(record: ChildRecord): void {
    if (!record.runDeadline) return;
    clearTimeout(record.runDeadline);
    record.runDeadline = undefined;
  }
}

class ChildHandle implements AgentChildHandle {
  constructor(
    private readonly manager: AgentChildManager,
    private readonly record: () => ChildRecord,
  ) {}

  get id(): string {
    return this.record().id;
  }
  get sessionId(): string {
    return this.record().sessionId;
  }
  get state(): AgentChildHandle["state"] {
    return this.record().state;
  }
  get result(): Promise<AgentChildResult> {
    return this.record().result;
  }
  get activity(): ChildActivitySnapshot | undefined {
    const snapshot = this.record().activity?.snapshot;
    if (!snapshot) return undefined;
    return {
      ...snapshot,
      ...(snapshot.latestTool
        ? { latestTool: { ...snapshot.latestTool } }
        : {}),
      ...(snapshot.usage ? { usage: { ...snapshot.usage } } : {}),
    };
  }
  send(
    input: AgentChildInput,
    authorization?: ChildTools,
  ): Promise<AgentInputReceipt> {
    return this.manager.send(this.id, input, authorization);
  }
  interrupt(reason?: string): Promise<void> {
    return this.manager.interrupt(this.id, reason);
  }
  interruptRun(expectedRunId: string, reason?: string): Promise<boolean> {
    return this.manager.interruptRun(this.id, expectedRunId, reason);
  }
  close(): Promise<void> {
    return this.manager.close(this.id);
  }
}

function captureParent(scope: TrustedChildRunParent): TrustedChildRunParent {
  return {
    sessionId: scope.sessionId,
    runId: scope.runId,
    signal: scope.signal,
    ...(scope.limits ? { limits: scope.limits } : {}),
  };
}

function sameParent(
  left: TrustedChildRunParent | null | undefined,
  right: TrustedChildRunParent | null,
): boolean {
  return left == null
    ? right === null
    : right !== null &&
        left.sessionId === right.sessionId &&
        left.runId === right.runId;
}

function sameChildInput(
  left: AgentChildInput,
  right: AgentChildInput,
): boolean {
  return (
    left.content === right.content &&
    (left.delivery ?? "steer") === (right.delivery ?? "steer") &&
    isDeepStrictEqual(left.metadata ?? {}, right.metadata ?? {})
  );
}

function isChildUnavailable(record: ChildRecord): boolean {
  return record.state === "closing" || record.state === "closed";
}

/** Scope and expected result are task context only; they never widen the child's permissions. */
function childInitialTask(input: AgentChildSpawnInput): string {
  const sections = [input.prompt];
  if (input.scope) sections.push("", "Task scope:", input.scope);
  if (input.expectedResult)
    sections.push("", "Expected result:", input.expectedResult);
  return sections.join("\n");
}

/** No configured time budget means no timer; a caller request can only tighten the role budget. */
function childRunTimeoutMs(spawn: AgentChildSpawnInput): number | undefined {
  const role = positiveSeconds(spawn.timeoutSeconds);
  const requested = positiveSeconds(spawn.requestedTimeoutSeconds);
  const seconds =
    role === undefined
      ? requested
      : requested === undefined
        ? role
        : Math.min(role, requested);
  return seconds === undefined ? undefined : seconds * 1000;
}

function positiveSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function childTimeoutMessage(timeoutMs: number): string {
  return `Child run exceeded its time budget (${timeoutMs / 1000} seconds)`;
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

function combineFailures(
  primary: unknown,
  cleanup: unknown,
  message: string,
): unknown {
  const cleanupFailures =
    cleanup instanceof AggregateError ? cleanup.errors : [cleanup];
  const failures = [
    primary,
    ...cleanupFailures.filter((failure) => failure !== primary),
  ];
  return failures.length === 1
    ? primary
    : new AggregateError(failures, message);
}
