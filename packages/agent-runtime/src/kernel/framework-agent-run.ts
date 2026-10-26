import { readonlyMap } from "@vykor/agent-contracts";
import { bindPreparedToolResults } from "./tool-results.js";
import { createStructuredDelivery, type StructuredDeliveryController } from "./delivery/structured-delivery.js";
import type {
  AgentEffects,
  AgentEventContext,
  AgentEventInput,
  AgentExecutionContext,
  AgentInputReceipt,
  AgentRunHandle,
  AgentRunResult,
  AgentRunScope,
  AgentSteerInput,
  StreamEvent,
} from "@vykor/agent-contracts";
import {
  AgentRunNotAcceptingInputError,
  ChildRunTerminationError,
} from "@vykor/agent-contracts";
const randomUUID = () => globalThis.crypto.randomUUID();

import type {
  ChildFailureKind,
  ChildPartialResult,
} from "@vykor/agent-contracts";
import type { ContentBlock } from "@vykor/agent-contracts";
import { MaxTurnsExceeded } from "@vykor/core/engine";

import type { AgentChildManager } from "./children/child-agent.js";
import { abortError, serializeError } from "./agent-errors.js";
import { AgentEventDeliveryError, type AgentEventBus } from "./event-source.js";

export interface FrameworkAgentRunOptions {
  outputContract?: import("@vykor/agent-contracts").AgentOutputContract;
  toolSafety?: import("@vykor/agent-contracts").AgentToolSafety;
  agentId: string;
  session: {
    id: string;
    getHistory(): import("@vykor/agent-contracts").Message[];
    submitMessage: import("@vykor/core/engine").IQueryEngine["submitMessage"];
  };
  engine: import("@vykor/core/engine").IQueryEngine;
  preparation: import("@vykor/agent-contracts").AgentRunPreparation;
  limits?: AgentExecutionContext["limits"];
  profile?: AgentExecutionContext["profile"];
  contribution?: import("@vykor/agent-contracts").AgentRunContribution;
  tools?: ReadonlyMap<string, import("@vykor/agent-contracts").RunToolBinding>;
  eventBus: AgentEventBus;
  effects: AgentEffects;
  children: AgentChildManager;
  identity?: {
    childId?: string;
    parentSessionId?: string;
    parentRunId?: string;
  };
  content: string | ContentBlock[];
  inputItems?: readonly unknown[];
  ids: { inputId: string; runId: string; traceId: string };
  externalSignal?: AbortSignal;
  hardMaxTurns?: number;
  delivery: "queue" | "steer";
  metadata?: Record<string, unknown>;
  onSettled(
    result: AgentRunResult | undefined,
    toolActivity: FrameworkAgentRunToolActivity | undefined,
  ): void;
}

export interface FrameworkAgentRunToolActivity {
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  toolResults: Array<{ toolUseId: string; isError: boolean | undefined }>;
}

interface PendingSteer {
  input: AgentSteerInput;
  receipt: ReturnType<typeof deferred<AgentInputReceipt>>;
}

/** 把 StreamEvent 里与文本/思考相关的事件映射成 AgentEvent；其余事件交给调用方。 */
export function streamEventToAgentEvent(
  event: StreamEvent,
): AgentEventInput | undefined {
  if (event.type === "tool_generation_progress") {
    const { type: _, ...payload } = event;
    return {
      type: "domain.event",
      data: { name: "tool.generation.progress", payload },
    };
  }
  if (event.type === "text_delta") {
    return {
      type: "output.text.delta",
      data: {
        delta: event.delta,
        ...(event.phase ? { phase: event.phase } : {}),
      },
    };
  }
  if (event.type === "reasoning_delta") {
    return {
      type: "output.reasoning.delta",
      data: { delta: event.delta, source: event.source },
    };
  }
  if (event.type === "generation_started") {
    return {
      type: "output.generation.started",
      data: { generationId: event.generationId, attempt: event.attempt },
    };
  }
  if (event.type === "model_retry") {
    return {
      type: "model.retry.scheduled",
      data: {
        generationId: event.generationId,
        attempt: event.attempt,
        retryNumber: event.retryNumber,
        maxRetries: event.maxRetries,
        reason: event.reason,
        nextRetryAt: event.nextRetryAt,
        recoveryDeadlineAt: event.recoveryDeadlineAt,
      },
    };
  }
  if (event.type === "model_attempt_finished") {
    return {
      type: "model.attempt.finished",
      data: {
        generationId: event.generationId,
        attempt: event.attempt,
        status: event.status,
        usageStatus: event.usageStatus,
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.notDispatched ? { notDispatched: event.notDispatched } : {}),
      },
    };
  }
  return undefined;
}

export class FrameworkAgentRun implements AgentRunHandle {
  private readonly delivery?: StructuredDeliveryController;
  readonly id: string;
  readonly inputId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly started: Promise<AgentInputReceipt>;
  readonly result: Promise<AgentRunResult>;
  active = true;

  private readonly controller = new AbortController();
  private readonly steered: PendingSteer[] = [];
  private readonly pendingSteers = new Set<PendingSteer>();
  private readonly toolActivity: FrameworkAgentRunToolActivity = {
    toolUses: [],
    toolResults: [],
  };
  private readonly start = deferred<AgentInputReceipt>();
  private acceptingInput = true;
  private externalAbort?: () => void;

  constructor(private readonly options: FrameworkAgentRunOptions) {
    this.delivery = options.outputContract ? createStructuredDelivery(options.outputContract) : undefined;
    this.id = options.ids.runId;
    this.inputId = options.ids.inputId;
    this.sessionId = options.session.id;
    this.traceId = options.ids.traceId;
    this.started = this.start.promise;
    if (options.externalSignal) {
      this.externalAbort = () =>
        this.controller.abort(
          options.externalSignal!.reason ?? "Run interrupted",
        );
      if (options.externalSignal.aborted) this.externalAbort();
      else
        options.externalSignal.addEventListener("abort", this.externalAbort, {
          once: true,
        });
    }
    let completedResult: AgentRunResult | undefined;
    this.result = Promise.resolve()
      .then(() => this.execute())
      .then((result) => {
        completedResult = result;
        return result;
      })
      .finally(() => {
        this.active = false;
        this.acceptingInput = false;
        if (this.externalAbort && options.externalSignal) {
          options.externalSignal.removeEventListener(
            "abort",
            this.externalAbort,
          );
        }
        options.onSettled(
          completedResult,
          completedResult ? this.snapshotToolActivity() : undefined,
        );
      });
    void this.started.catch(() => {});
    void this.result.catch(() => {});
  }

  async steer(input: AgentSteerInput): Promise<AgentInputReceipt> {
    if (!this.active || !this.acceptingInput)
      throw new AgentRunNotAcceptingInputError(this.id);
    const accepted = {
      ...input,
      id: input.id ?? `input_${randomUUID()}`,
      traceId: input.traceId ?? randomUUID(),
      delivery: "steer" as const,
    };
    const receipt = deferred<AgentInputReceipt>();
    void receipt.promise.catch(() => {});
    const pending = { input: accepted, receipt };
    this.steered.push(pending);
    this.pendingSteers.add(pending);
    return await receipt.promise;
  }

  async interrupt(reason?: string): Promise<void> {
    if (!this.controller.signal.aborted)
      this.controller.abort(reason ?? "Run interrupted");
    await this.result.catch(() => {});
  }

  private async execute(): Promise<AgentRunResult> {
    let releaseCapabilities: (() => void | Promise<void>) | undefined;
    let output = "";
    // Only text that survived a successful `complete` may be reported as an
    // unfinished result; retries and in-flight fragments never reach it.
    let committedOutput = "";
    let stopReason: string | undefined;
    let currentGenerationId: string | undefined;
    let generationOutputStart = 0;
    const scope: AgentRunScope = {
      agentId: this.options.agentId,
      sessionId: this.sessionId,
      inputId: this.inputId,
      runId: this.id,
      cwd: this.options.children.cwd,
      traceId: this.traceId,
      signal: this.controller.signal,
    };
    const createExecution = async (
      run: import("@vykor/agent-contracts").PreparedAgentRun,
    ): Promise<AgentExecutionContext> => {
      const tools = this.options.tools
        ? readonlyMap(
            [...run.tools].filter(
              ([name, binding]) =>
                this.options.tools!.get(name)?.definitionIdentity ===
                  binding.definitionIdentity &&
                this.options.tools!.get(name)?.definition.execute ===
                  binding.definition.execute,
            ),
          )
        : readonlyMap(run.tools);
      if (this.delivery && (tools.has("SubmitResult") || [run.contribution, this.options.contribution].some(item => item?.tools?.some(tool => tool.definition.name === "SubmitResult"))))
        throw new Error("SubmitResult is reserved for this Run's structured delivery contract");
      const toolResults = await bindPreparedToolResults(run, tools);
      this.controller.signal.throwIfAborted();
      // The factory is host authority to bind a scope; tools receive only the bound store.
      const { bindToolResults: _provider, toolResults: _prebound, ...capabilities } = run;
      return {
        scope,
        ...capabilities,
        toolResults,
        toolSafety: this.options.toolSafety ?? run.toolSafety,
        limits: this.options.limits ?? run.limits,
        profile:
          this.options.profile || run.profile
            ? {
                ...run.profile,
                ...this.options.profile,
                toolResultReferences:
                  run.profile?.toolResultReferences ??
                  this.options.profile?.toolResultReferences,
              }
            : undefined,
        contribution: mergeContribution(mergeContribution(run.contribution, this.options.contribution), this.delivery?.contribution),
        tools,
        ...(this.options.hardMaxTurns !== undefined
          ? { hardMaxTurns: this.options.hardMaxTurns }
          : {}),
        effects: this.options.effects,
        children: this.options.children.createController(
          { ...scope, limits: this.options.limits ?? run.limits, toolSafety: this.options.toolSafety ?? run.toolSafety },
          tools,
        ),
        emit: (event) => this.emit(event),
        takeSteeredInputs: (options) => this.takeSteeredInputs(options),
        closeSteering: () => {
          this.acceptingInput = false;
        },
      };
    };

    try {
      await this.emit({
        type: "input.accepted",
        data: {
          content: this.options.content,
          ...(this.options.inputItems
            ? { inputItems: this.options.inputItems }
            : {}),
          delivery: this.options.delivery,
          ...(this.options.metadata ? { metadata: this.options.metadata } : {}),
        },
      });
      await this.options.limits?.check("run");
      const prepared = await this.options.preparation.prepare(scope);
      releaseCapabilities = prepared.release;
      this.controller.signal.throwIfAborted();
      const execution = await createExecution(prepared.run);
      await this.emit({ type: "run.started", data: {} });
      this.controller.signal.throwIfAborted();
      this.start.resolve({
        sessionId: this.sessionId,
        inputId: this.inputId,
        runId: this.id,
      });
      for await (const event of this.options.session.submitMessage(
        this.options.content,
        {
          signal: this.controller.signal,
          execution,
        },
      )) {
        // Cancellation still owes full results for calls committed before the abort.
        const committedSettlement =
          event.type === "tool_use_end" &&
          this.toolActivity.toolUses.some(
            (call) => call.id === event.toolUseId,
          ) &&
          !this.toolActivity.toolResults.some(
            (result) => result.toolUseId === event.toolUseId,
          );
        if (
          this.controller.signal.aborted &&
          event.type !== "model_attempt_finished" &&
          !committedSettlement
        ) {
          throw abortError(this.controller.signal);
        }
        if (event.type === "generation_started") {
          if (event.generationId !== currentGenerationId) {
            currentGenerationId = event.generationId;
            generationOutputStart = output.length;
          } else {
            // 同一生成的新尝试：丢弃上一次尝试已追加的残缺文字。
            output = output.slice(0, generationOutputStart);
          }
        } else if (event.type === "text_delta") {
          output += event.delta;
        } else if (event.type === "complete") {
          stopReason = event.stopReason;
          committedOutput = output;
        }
        await this.projectStreamEvent(event);
      }
      if (this.controller.signal.aborted)
        throw abortError(this.controller.signal);
      this.acceptingInput = false;
      this.rejectPendingSteers();
      const delivery = this.delivery?.requireReceipt();
      if (delivery && !output) output = delivery.summary;
      await this.emit({
        type: "run.completed",
        data: { output, ...(stopReason ? { stopReason } : {}), ...(delivery ? { delivery: structuredClone(delivery) } : {}) },
      });
      return {
        status: "completed",
        output,
        history: this.options.session.getHistory(),
        usage: this.options.engine.getTotalUsage(),
        ...(delivery ? { delivery } : {}),
      };
    } catch (error) {
      this.acceptingInput = false;
      this.rejectPendingSteers();
      this.start.reject(error);
      if (!(error instanceof AgentEventDeliveryError)) {
        const interrupted = this.controller.signal.aborted;
        await this.emit({
          type: interrupted ? "run.interrupted" : "run.failed",
          data: {
            error: serializeError(error),
            ...(committedOutput ? { output: committedOutput } : {}),
            ...childFailureData(
              this.options.identity,
              this.options.externalSignal,
              error,
              this.sessionId,
              this.id,
              committedOutput,
            ),
          },
        }).catch(() => {});
      }
      throw error;
    } finally {
      // A host cleanup failure rejects the handle after the terminal event; it
      // must not fabricate a second failed terminal for an already durable Run.
      await releaseCapabilities?.();
    }
  }

  private async takeSteeredInputs(
    options: { closeIfEmpty?: boolean } = {},
  ): Promise<AgentSteerInput[]> {
    const pending = this.steered.splice(0, 1);
    if (pending.length === 0 && options.closeIfEmpty)
      this.acceptingInput = false;
    const inputs: AgentSteerInput[] = [];
    try {
      for (const { input } of pending) {
        await this.emit(
          {
            type: "input.accepted",
            data: {
              content: input.content,
              ...(input.inputItems ? { inputItems: input.inputItems } : {}),
              delivery: "steer",
              ...(input.metadata ? { metadata: input.metadata } : {}),
            },
          },
          { inputId: input.id, traceId: input.traceId },
        );
        inputs.push(input);
      }
    } catch (error) {
      const rejected = new AgentRunNotAcceptingInputError(this.id);
      for (const item of pending) item.receipt.reject(rejected);
      throw error;
    } finally {
      for (const item of pending) this.pendingSteers.delete(item);
    }
    for (const { input, receipt } of pending) {
      receipt.resolve({
        sessionId: this.sessionId,
        inputId: input.id!,
        runId: this.id,
      });
    }
    return inputs;
  }

  private rejectPendingSteers(): void {
    const error = new AgentRunNotAcceptingInputError(this.id);
    for (const pending of this.pendingSteers) pending.receipt.reject(error);
    this.pendingSteers.clear();
    this.steered.splice(0);
  }

  private async projectStreamEvent(event: StreamEvent): Promise<void> {
    const mapped = streamEventToAgentEvent(event);
    if (mapped) {
      await this.emit(mapped);
      // Runtime derives a single usage.updated from the settlement event so the
      // server never double-counts the same attempt's cost.
      if (event.type === "model_attempt_finished" && event.usage) {
        await this.emit({
          type: "usage.updated",
          data: { usage: event.usage },
        });
      }
      return;
    }
    if (event.type === "complete") {
      await this.emit({
        type: "output.turn.completed",
        data: { stopReason: event.stopReason },
      });
    } else if (event.type === "tool_use_start") {
      this.toolActivity.toolUses.push({
        id: event.toolUse.id,
        name: event.toolUse.name,
        input: event.toolUse.input,
      });
      await this.emit({
        type: "tool.started",
        data: { toolUse: event.toolUse },
      });
    } else if (event.type === "tool_use_end") {
      this.toolActivity.toolResults.push({
        toolUseId: event.toolUseId,
        isError: event.result.isError,
      });
      await this.emit({
        type: "tool.completed",
        data: { toolUseId: event.toolUseId, result: event.result },
      });
    } else if (event.type === "error") {
      throw event.error;
    }
  }

  private snapshotToolActivity(): FrameworkAgentRunToolActivity {
    return {
      toolUses: this.toolActivity.toolUses.map((toolUse) => ({ ...toolUse })),
      toolResults: this.toolActivity.toolResults.map((toolResult) => ({
        ...toolResult,
      })),
    };
  }

  private async emit(
    event: AgentEventInput,
    override: Partial<AgentEventContext> = {},
  ): Promise<void> {
    await this.options.eventBus.emit(event, {
      agentId: this.options.agentId,
      sessionId: this.sessionId,
      inputId: this.inputId,
      runId: this.id,
      traceId: this.traceId,
      ...this.options.identity,
      ...override,
    });
  }
}

const MAX_CHILD_PARTIAL_TEXT = 12_000;

/**
 * Terminal detail for a child Run only. Root runs never carry it, and the
 * source is always a trusted error type or a typed abort marker.
 */
function childFailureData(
  identity: FrameworkAgentRunOptions["identity"],
  externalSignal: AbortSignal | undefined,
  error: unknown,
  sessionId: string,
  runId: string,
  committedOutput: string,
): { failureKind?: ChildFailureKind; partialResult?: ChildPartialResult } {
  if (!identity?.childId) return {};
  const termination = externalSignal?.reason;
  const failureKind: ChildFailureKind =
    error instanceof MaxTurnsExceeded
      ? "max_turns"
      : termination instanceof ChildRunTerminationError
        ? termination.failureKind
        : "unknown";
  const finalizationText =
    error instanceof MaxTurnsExceeded ? error.finalizationText : undefined;
  const text =
    finalizationText && finalizationText.length > 0
      ? finalizationText
      : committedOutput;
  if (!text) return { failureKind };
  const truncated = text.length > MAX_CHILD_PARTIAL_TEXT;
  return {
    failureKind,
    partialResult: {
      version: 1,
      childSessionId: sessionId,
      runId,
      source:
        finalizationText && finalizationText.length > 0
          ? "limit_finalization"
          : "committed_assistant_text",
      text: truncated ? text.slice(0, MAX_CHILD_PARTIAL_TEXT) : text,
      truncated,
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function mergeContribution(
  a?: import("@vykor/agent-contracts").AgentRunContribution,
  b?: import("@vykor/agent-contracts").AgentRunContribution,
): import("@vykor/agent-contracts").AgentRunContribution | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    ...a,
    ...b,
    systemGuidance: [a.systemGuidance, b.systemGuidance]
      .filter(Boolean)
      .join("\n\n"),
    tools: [...(a.tools ?? []), ...(b.tools ?? [])],
  };
}
