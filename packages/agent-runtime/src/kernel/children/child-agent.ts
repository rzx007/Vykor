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
  AgentChildRunSnapshot,
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
  AgentOutputContract,
} from "@vykor/agent-contracts";
import type { VykorAgent } from "../agent.js";
import {
  createInProcessChildEnvironmentProvider,
  type AgentChildEnvironmentLease,
  type AgentChildEnvironmentProvider,
} from "./child-environment.js";
import type { AgentEventBus } from "../event-source.js";
import { AgentEventDeliveryError } from "../event-source.js";
import {
  AgentChildRegistry,
  type AgentChildBudgetReservation,
} from "./child-registry.js";
import {
  applyChildActivityEvent,
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
> & { limits?: AgentExecutionLimits; toolSafety?: import("@vykor/agent-contracts").AgentToolSafety };

interface ChildRequest {
  input: AgentChildInput;
  parent: TrustedChildRunParent | null;
  receipt: Promise<AgentInputReceipt>;
  settled: boolean;
  run?: AgentRunHandle;
  accepted?: AgentInputReceipt;
  startedAt?: number;
  updatedAt?: number;
  stopping?: boolean;
  resultPromise?: Promise<AgentChildResult>;
  result?: AgentChildResult;
  stoppedAt?: number;
  stopPromise?: Promise<void>;
  permit?: { release(): void };
  /** A newly allocated identity still owes startup confirmation or lease revocation. */
  identityPreparationPending?: boolean;
  projectionPending?: boolean;
  projectionError?: unknown;
  stopError?: unknown;
  /** Additional steer input IDs point at the one accepted run record. */
  canonical?: ChildRequest;
  completeResult?: (result: AgentChildResult) => void;
  preparationError?: unknown;
}

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
  currentRequest?: ChildRequest;
  currentRunParent?: TrustedChildRunParent | null;
  requests: Map<string, ChildRequest>;
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
  leaseReleased?: boolean;
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
    outputContract?: AgentOutputContract;
  }): ResolvedChildExecution | Promise<ResolvedChildExecution>;
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
    parentScope: AgentRunScope & { limits?: AgentExecutionLimits; toolSafety?: import("@vykor/agent-contracts").AgentToolSafety },
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
   * is force-limited to zero ordinary tools; a host contract may add SubmitResult.
   * The sensitive initial content is
   * the child's first message; it never appears in persisted spawn summaries.
   */
  async spawnSystemChild(
    parentScope: AgentRunScope & { limits?: AgentExecutionLimits; toolSafety?: import("@vykor/agent-contracts").AgentToolSafety },
    input: AgentChildSpawnInput,
    sensitiveInitialContent: string,
    tools?: ChildTools,
    outputContract?: AgentOutputContract,
  ): Promise<AgentChildInvocation> {
    if (this.systemChildId !== undefined) {
      throw new Error("A system review child is already active");
    }
    return await this.spawnInternal(parentScope, input, {
      system: true,
      ...(tools ? { tools } : {}),
      initialContent: sensitiveInitialContent,
      outputContract,
    });
  }

  private async spawn(
    parentScope: AgentRunScope & { limits?: AgentExecutionLimits; toolSafety?: import("@vykor/agent-contracts").AgentToolSafety },
    input: AgentChildSpawnInput,
    tools?: ChildTools,
  ): Promise<AgentChildInvocation> {
    return await this.spawnInternal(parentScope, input, { tools });
  }

  private async spawnInternal(
    parentScope: AgentRunScope & { limits?: AgentExecutionLimits; toolSafety?: import("@vykor/agent-contracts").AgentToolSafety },
    input: AgentChildSpawnInput,
    options: {
      tools?: ChildTools;
      system?: boolean;
      initialContent?: string;
      outputContract?: AgentOutputContract;
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
      budgetReservation = this.directory.reserveIdentity(
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
    const firstIds = { inputId: `input_${randomUUID()}`, runId: `run_${randomUUID()}`, traceId: randomUUID() };
    let firstPermit: { release(): void };
    try { firstPermit = this.directory.acquireRun(sessionId, firstIds.runId); }
    catch (error) {
      budgetReservation.rollback();
      if (system && this.systemChildId === childId) this.systemChildId = undefined;
      throw error;
    }
    const firstInput: AgentChildInput = {
      content: options.initialContent ?? childInitialTask(input),
      ...(system ? { metadata: { sensitiveInput: true } } : {}),
    };
    const firstRequest: ChildRequest = { input: firstInput, parent: captureParent(parentScope),
      receipt: Promise.resolve({ sessionId, ...firstIds }), settled: false, permit: firstPermit, identityPreparationPending: true };
    this.prepareResultWaiter(firstRequest);
    // Resolve model/authorization before acquiring a cwd/worktree or lease.
    // The same captured lease object is filled only after successful preflight.
    const lease: AgentChildEnvironmentLease = { cwd: input.cwd, release: async () => {} };
    let resolved: ResolvedChildExecution;
    try {
      resolved = await this.options.resolveChild({ spawn: input, lease, childId, sessionId, parentScope,
        tools: options.tools, system, ...(system && options.outputContract ? { outputContract: options.outputContract } : {}) });
    } catch (error) {
      firstPermit.release();
      budgetReservation.rollback();
      if (system && this.systemChildId === childId) this.systemChildId = undefined;
      throw error;
    }
    let environmentFailure: { error: unknown } | undefined;
    try { Object.assign(lease, await this.environment.acquire(resolved.spawn, childId)); }
    catch (error) { environmentFailure = { error }; }
    const record = {} as ChildRecord;
    Object.defineProperty(record, "result", { get: () => {
      const completion = record.currentRequest?.resultPromise;
      if (!completion) throw new Error("Child preparation has no result owner");
      return completion;
    } });
    const handle = new ChildHandle(this, () => record);
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
      startChain: Promise.resolve(),
      requests: new Map([[firstIds.inputId, firstRequest]]),
      currentRequest: firstRequest,
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
      const receipt = await this.beginRun(
        record,
        firstInput,
        captureParent(parentScope),
        { ids: firstIds, permit: firstPermit },
      );
      budgetReservation.commit();
      return {
        id: childId,
        sessionId,
        inputId: receipt.inputId,
        runId: receipt.runId,
        result: record.result.then(result => structuredClone(result)),
        ...(lease.worktree ? { worktree: lease.worktree } : {}),
      };
    } catch (error) {
      firstRequest.preparationError = error;
      if (record.currentRequest?.run) {
        const request = record.currentRequest;
        this.requestStop(record, request, "user_cancelled", "Child startup acknowledgement failed");
        const cleanup = request.resultPromise!.then(() => this.closeRecord(record, request.result!, announced));
        this.backgroundClosures.add(cleanup);
        void cleanup.catch(() => {});
        throw error;
      }
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
    expectedRunId?: string,
  ): Promise<AgentInputReceipt> {
    const record = this.require(childId);
    if (expectedRunId !== undefined && record.currentRequest?.accepted?.runId !== expectedRunId) throw new Error(`Child run conflict: expected ${expectedRunId}`);
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
      this.trimRequestHistory(record, MAX_CHILD_REQUEST_HISTORY - 1);
      if (record.requests.size >= MAX_CHILD_REQUEST_HISTORY) throw new Error("CHILD_RESULT_RETENTION_FULL: unresolved result storage prevents accepting another input");
      const receipt = this.sendToRecord(record, input, parent, expectedRunId);
      const request: ChildRequest = record.requests.get(input.id) ?? { input, parent, receipt, settled: false };
      request.receipt = receipt;
      record.requests.set(input.id, request);
      void receipt.then(
        accepted => {
          request.settled = true;
          const canonical = [...record.requests.values()].find(entry => entry.run?.id === accepted.runId);
          if (canonical && canonical !== request) request.canonical = canonical;
          this.trimRequestHistory(record);
        },
        () => {
          request.settled = true;
          if (!request.run && !request.canonical && !request.stopError && record.requests.get(input.id!) === request) record.requests.delete(input.id!);
          this.trimRequestHistory(record);
        },
      );
      return await receipt;
    }
    return await this.sendToRecord(record, input, parent, expectedRunId);
  }

  async interruptRun(
    childId: string,
    expectedRunId: string,
    reason = "Child run interrupted",
  ): Promise<boolean> {
    const record = this.find(childId);
    const run = record?.currentRun;
    if (!record || !run || run.id !== expectedRunId) return false;
    const request = record.currentRequest!;
    this.requestStop(record, request, "user_cancelled", reason);
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
    if (record.closePromise) {
      const request = record.currentRequest;
      if (request?.run?.cleanupUnconfirmed) void request.run.interrupt(reason ?? "Child agent closed").catch(error => { request.stopError = error; });
      return await record.closePromise;
    }
    record.state = "closing";
    const closing = (async () => {
      const failures: unknown[] = [];
      const activeRun = record.currentRun;
      const request = record.currentRequest;
      record.abortController?.abort(
        record.cancelSource
          ? new ChildRunTerminationError(
              record.cancelSource,
              reason ?? "Child agent closed",
            )
          : (reason ?? "Child agent closed"),
      );
      try {
        if (activeRun && request) {
          this.requestStop(record, request, record.cancelSource ?? "user_cancelled", reason ?? "Child agent closed");
          if (request.stopError) await activeRun.interrupt(reason ?? "Child agent closed");
          await request.resultPromise;
        }
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
        : (record.currentRequest?.result ?? {
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
    void closing.catch(() => { if (record.closePromise === closing && record.state !== "closed") record.closePromise = undefined; });
    await closing;
  }

  private async sendToRecord(
    record: ChildRecord,
    input: AgentChildInput,
    parent: TrustedChildRunParent | null,
    expectedRunId?: string,
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
      if (expectedRunId !== undefined && record.currentRequest?.accepted?.runId !== expectedRunId) throw new Error(`Child run conflict: expected ${expectedRunId}`);
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
    reserved?: { ids: { inputId: string; runId: string; traceId: string }; permit: { release(): void } },
  ): Promise<AgentInputReceipt> {
    await parent?.limits?.check("child");
    if (parent?.signal.aborted) throw new Error("Parent run interrupted");
    const alreadyRetained = input.id !== undefined && record.requests.has(input.id);
    this.trimRequestHistory(record, MAX_CHILD_REQUEST_HISTORY - (alreadyRetained ? 0 : 1));
    if (record.requests.size >= MAX_CHILD_REQUEST_HISTORY + (alreadyRetained ? 1 : 0)) throw new Error("CHILD_RESULT_RETENTION_FULL: unresolved result storage prevents accepting another run");
    const ids = reserved?.ids ?? { inputId: input.id ?? `input_${randomUUID()}`, runId: `run_${randomUUID()}`, traceId: input.traceId ?? randomUUID() };
    const permit = reserved?.permit ?? this.directory.acquireRun(record.sessionId, ids.runId);
    const request: ChildRequest = record.requests.get(ids.inputId) ?? { input, parent, receipt: Promise.resolve({ sessionId: record.sessionId, ...ids }), settled: false };
    request.permit = permit;
    request.identityPreparationPending = reserved !== undefined;
    this.prepareResultWaiter(request);
    record.requests.set(ids.inputId, request);
    let agent: VykorAgent | undefined;
    try {
      agent = await this.ensureAgent(record, reserved === undefined);
      if (isChildUnavailable(record)) throw new Error(`Child agent is closing or closed: ${record.id}`);
      if (parent?.signal.aborted) throw new Error("Parent run interrupted");
    } catch (error) {
      // No run was submitted. Revoke a possibly created/resumed instance before
      // returning its permit; failed cleanup retains ownership in this request.
      if (!reserved) {
        try {
          if (record.agent) {
            const prepared = record.agent;
            await prepared.close();
            if (record.agent === prepared) record.agent = undefined;
          }
          permit.release();
          record.requests.delete(ids.inputId);
        } catch (cleanupError) {
          request.stopping = true;
          request.stopError = cleanupError;
          throw combineFailures(error, cleanupError, `Child run preparation cleanup unconfirmed: ${record.id}`);
        }
      }
      throw error;
    }
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
      const request = record.currentRequest;
      if (request?.run && request.run === record.currentRun) this.requestStop(record, request, "parent_interrupted", "Parent run interrupted");
    };
    parent?.signal.addEventListener("abort", parentAbortHandler, {
      once: true,
    });
    record.state = "running";
    record.activityRunId = ids.runId;
    record.activity = undefined;
    const hardMaxTurns =
      typeof record.hardMaxTurns === "function"
        ? record.hardMaxTurns()
        : record.hardMaxTurns;
    const timeoutMs = childRunTimeoutMs(record.spawn);
    if (timeoutMs !== undefined) {
      // Trusted deadline source: the flag, never the abort reason text, classifies the failure.
      record.runDeadline = setTimeout(() => {
        controller.abort(
          new ChildRunTerminationError(
            "timeout",
            childTimeoutMessage(timeoutMs),
          ),
        );
        if (record.currentRequest?.run?.id === ids.runId) this.requestStop(record, record.currentRequest, "timeout", childTimeoutMessage(timeoutMs));
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
      if (!reserved) permit.release();
      throw error;
    }
    record.currentRun = run;
    request.receipt = run.started;
    request.run = run;
    request.accepted = { sessionId: record.sessionId, inputId: ids.inputId, runId: ids.runId };
    request.startedAt = request.updatedAt = Date.now();
    request.stopping = false;
    request.permit = permit;
    request.projectionPending = true;
    record.requests.set(ids.inputId, request);
    record.currentRequest = request;
    void run.settled.then(settlement => {
      parent?.signal.removeEventListener("abort", parentAbortHandler);
      const actual = settlement.result;
      const result: AgentChildResult = actual.status === "completed"
        ? { status: "completed", output: actual.output, ...(actual.delivery ? { delivery: structuredClone(actual.delivery) } : {}) }
        : { ...actual };
      this.finishRun(record, request, result, settlement.stoppedAt);
    });
    void run.result.then(() => {
      request.projectionPending = false;
    }, error => {
      request.projectionPending = false;
      // Execution errors remain the actual outcome; only reliable delivery errors
      // describe an unsaved result. Never replace that outcome with a save error.
      if (error instanceof AgentEventDeliveryError && error.event && ["run.completed", "run.failed", "run.interrupted"].includes(error.event.type)) request.projectionError = error;
      if (!request.result && !(error instanceof AgentEventDeliveryError)) {
        request.stopping = true;
        request.stopError = error;
      }
    });
    void record.result.catch(() => {});
    let receipt: AgentInputReceipt;
    try { receipt = await run.started; }
    catch (error) {
      this.requestStop(record, request, "user_cancelled", "Child startup acknowledgement failed");
      throw error;
    }
    if (
      receipt.sessionId !== record.sessionId ||
      receipt.inputId !== ids.inputId ||
      receipt.runId !== ids.runId
    ) {
      this.requestStop(record, request, "user_cancelled", "Child run started with unexpected identity");
      throw new Error(
        `Child run identity conflict: ${receipt.sessionId}/${receipt.inputId}/${receipt.runId}`,
      );
    }
    request.identityPreparationPending = false;
    this.releaseStoppedPermit(request);
    return receipt;
  }

  readRun(childId: string, runId: string): AgentChildRunSnapshot {
    const request = [...this.require(childId).requests.values()].find(entry => entry.accepted?.runId === runId);
    if (!request?.accepted || request.startedAt === undefined) throw new Error(`RUN_RESULT_NOT_RETAINED: ${runId}`);
    this.refreshProjection(request);
    const cleanupUnconfirmed = request.run?.cleanupUnconfirmed ?? (request.stopError ? { message: errorMessage(request.stopError) } : undefined);
    return { receipt: { ...request.accepted }, startedAt: request.startedAt, updatedAt: request.updatedAt!, stopping: (request.stopping === true || !!cleanupUnconfirmed) && !request.result,
      ...(request.projectionError ? { projectionError: { message: errorMessage(request.projectionError) } } : {}),
      ...(cleanupUnconfirmed ? { cleanupUnconfirmed } : {}),
      ...(request.result ? { result: structuredClone(request.result), stoppedAt: request.stoppedAt } : {}) };
  }

  async waitRun(childId: string, runId: string): Promise<AgentChildRunSnapshot> {
    const record = this.require(childId);
    const request = [...record.requests.values()].find(entry => entry.accepted?.runId === runId);
    if (!request) throw new Error(`RUN_RESULT_NOT_RETAINED: ${runId}`);
    await request.resultPromise;
    return this.readRun(childId, runId);
  }

  private async awaitResult(childId: string): Promise<AgentChildResult> {
    return structuredClone(await this.require(childId).result);
  }

  private finishRun(record: ChildRecord, request: ChildRequest, result: AgentChildResult, stoppedAt: number): AgentChildResult {
    if (request.result) return request.result;
    request.result = Object.freeze(result);
    request.settled = true;
    request.updatedAt = request.stoppedAt = stoppedAt;
    request.stopError = undefined;
    this.releaseStoppedPermit(request);
    if (record.currentRun === request.run) {
      this.clearRunDeadline(record);
      record.abortController = undefined;
      record.currentRun = undefined;
      if (!isChildUnavailable(record)) record.state = "idle";
      this.scheduleSuspend(record);
    }
    request.completeResult?.(request.result);
    return request.result;
  }

  private prepareResultWaiter(request: ChildRequest): void {
    if (request.resultPromise) return;
    request.resultPromise = new Promise(resolve => { request.completeResult = resolve; });
  }

  private releaseStoppedPermit(request: ChildRequest): void {
    if (request.result && !request.identityPreparationPending) request.permit?.release();
  }

  private requestStop(record: ChildRecord, request: ChildRequest, kind: "timeout" | "user_cancelled" | "parent_interrupted", reason: string): void {
    if (request.result) return;
    if (request.stopPromise) {
      // Keep the original waiter. A repeated explicit stop may only confirm a
      // cleanup that has actually failed; Framework coalesces that one retry.
      if (request.run?.cleanupUnconfirmed) void request.run.interrupt(reason).catch(error => { request.stopError = error; });
      return;
    }
    request.stopping = true;
    request.updatedAt = Date.now();
    if (record.currentRun === request.run) record.abortController?.abort(new ChildRunTerminationError(kind, reason));
    request.stopPromise = request.run!.interrupt(reason);
    void request.stopPromise.catch(error => { request.stopError = error; });
  }

  private refreshProjection(request: ChildRequest): void {
    if (request.projectionError instanceof AgentEventDeliveryError && request.projectionError.recovered) request.projectionError = undefined;
  }

  private trimRequestHistory(record: ChildRecord, limit = MAX_CHILD_REQUEST_HISTORY): void {
    if (record.requests.size <= limit) return;
    for (const [id, request] of record.requests) {
      const canonical = request.canonical ?? request;
      this.refreshProjection(canonical);
      if (!canonical.result || canonical.projectionPending || canonical.projectionError || record.currentRequest === request) continue;
      record.requests.delete(id);
      if (record.requests.size <= limit) return;
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
        if (!record.cleanupPromise) {
          try {
            await agent.close();
            if (record.agent === agent) record.agent = undefined;
          } catch (cleanupError) {
            record.agent = agent;
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

  requestSuspend(childId: string, expectedRunId: string): Promise<boolean> {
    const record = this.require(childId);
    const request = record.currentRequest;
    const agent = record.agent;
    if (!request?.result || request.accepted?.runId !== expectedRunId || !agent || record.suspending) return Promise.resolve(false);
    return this.suspendRecord(record, request, agent);
  }

  private suspendRecord(record: ChildRecord, request: ChildRequest, agent: VykorAgent): Promise<boolean> {
    this.clearIdleTimer(record);
    // Serialize the captured request/instance with send and resume. Close marks
    // the record unavailable synchronously and waits this same operation.
    let suspended = false;
    const work = record.startChain.then(async () => {
      // Publish only after preceding admissions have finished; otherwise their
      // ensureAgent would wait a suspension queued behind themselves.
      record.suspending = suspending;
      if (request.projectionPending) await request.run?.result.catch(() => {});
      this.refreshProjection(request);
      const current = () => record.currentRequest === request && record.agent === agent && record.state === "idle" && !record.currentRun && !record.creating && !record.cleanupPromise && !!request.result && !request.projectionPending && !request.projectionError;
      if (!current() || !agent.canSuspend || !(await agent.canSuspend()) || !current()) return;
      record.suspendedHistory = agent.getHistory();
      await agent.close();
      if (record.agent === agent) record.agent = undefined;
      if (isChildUnavailable(record)) return;
      record.state = "suspended";
      suspended = true;
      await this.emitChild(record, { type: "child.suspended", data: { childId: record.id, sessionId: record.sessionId } });
    });
    record.startChain = work.then(() => {}, () => {});
    const suspending = work.finally(() => { if (record.suspending === suspending) record.suspending = undefined; });
    void suspending.catch(error => {
      if (isChildUnavailable(record) || !this.records.has(record.id)) return;
      record.state = "closing";
      const closing = (async () => {
        try { await this.closeRecord(record, failedResult(error), true); }
        catch (cleanupError) { throw combineFailures(error, cleanupError, `Child agent suspension and cleanup failed: ${record.id}`); }
        throw error;
      })();
      record.closePromise = closing;
      this.backgroundClosures.add(closing);
      void closing.catch(() => {});
    });
    return suspending.then(() => suspended);
  }

  private scheduleSuspend(record: ChildRecord): void {
    const idleTtlMs = this.options.idleTtlMs ?? 5 * 60_000;
    if (idleTtlMs <= 0 || isChildUnavailable(record)) return;
    this.clearIdleTimer(record);
    const request = record.currentRequest;
    const agent = record.agent;
    if (!request || !agent) return;
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      if (record.currentRequest !== request || record.agent !== agent || record.suspending) return;
      void this.suspendRecord(record, request, agent).catch(() => {});
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
    void cleanup.catch(() => { if (record.cleanupPromise === cleanup && record.state !== "closed") record.cleanupPromise = undefined; });
    return cleanup;
  }

  private async closeRecordWork(
    record: ChildRecord,
    result: AgentChildResult,
    emit: boolean,
  ): Promise<void> {
    if (record.state === "closed" && !this.records.has(record.id)) return;
    if (!record.currentRequest?.run && record.currentRequest?.preparationError) result = failedResult(record.currentRequest.preparationError);
    const failures: unknown[] = [];
    record.state = "closing";
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
      record.agent = undefined;
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throwFailures(failures, `Child agent cleanup unconfirmed: ${record.id}`);
    try {
      if (!record.leaseReleased) {
        await record.lease.release(structuredClone(result));
        record.leaseReleased = true;
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throwFailures(failures, `Child agent cleanup unconfirmed: ${record.id}`);
    for (const request of record.requests.values()) {
      request.permit?.release();
      if (!request.run && !request.result) {
        request.result = Object.freeze(request.preparationError ? failedResult(request.preparationError) : { ...result });
        request.settled = true;
        request.completeResult?.(request.result);
      }
    }
    record.state = "closed";
    try {
      if (emit) {
        try {
          await this.emitChild(record, {
            type: "child.closed",
            data: { childId: record.id, sessionId: record.sessionId, result: structuredClone(result) },
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
  get runId(): string | undefined { return this.record().currentRequest?.accepted?.runId; }
  readRun(runId: string): AgentChildRunSnapshot { return this.manager.readRun(this.id, runId); }
  waitRun(runId: string): Promise<AgentChildRunSnapshot> { return this.manager.waitRun(this.id, runId); }
  get result(): Promise<AgentChildResult> {
    return this.record().result.then(result => structuredClone(result));
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
  requestSuspend(expectedRunId: string): Promise<boolean> { return this.manager.requestSuspend(this.id, expectedRunId); }
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
    ...(scope.toolSafety ? { toolSafety: scope.toolSafety } : {}),
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
