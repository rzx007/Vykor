import { randomUUID } from "node:crypto";

import type { Message, StreamEvent, ToolUseBlock, UsageSnapshot, ContentBlock, ModelAttemptFinishedEvent, ToolGenerationProgressEvent } from "../index";
import type {
  AgentExecutionContext,
  StreamingMessageClient,
  IPermissionChecker,
  IHookExecutor,
  QueryEngine as IQueryEngine,
  QueryEngineOptions,
  MemoryRetriever,
  AgentBackgroundShellHost,
  AgentScheduleEffects,
  McpAuthHost,
  QueryRequestConfiguration,
} from "../index";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolRegistry as IToolRegistry,
} from "../types/tools";
import type { AgentTerminalHost } from "@vykor/terminal";
import type { AgentJobHost } from "@vykor/jobs";
import { CompactService, type CompactClient, type CompactContextProvider } from "./compact-service";
import { CostTracker } from "./cost-tracker";
import {
  ModelRequestFailure,
  nextModelRetryDelay,
  normalizeModelRetryPolicy,
  waitForModelRetry,
  type ModelRetryPolicy,
  type RetryCounters,
} from "./model-retry";
import { streamBufferedModelWithRetry } from "./buffered-model-retry";
import { sanitizeMessageHistory } from "../utils/message-history";
import { executeCheckedTools } from "./checked-tool-execution";
import { withToolInputReuseHint } from "./tool-input-reuse";
import { attemptFinishedEvent, createAttemptSignal, describeModelFailure } from "./query-model-attempt";
import { applyToolOutputBudget } from "./query-tool-limits";
import { ToolFailureMemory } from "./tool-failure-memory";
import { formatToolResultForModel, toolFeedbackFields } from "./tool-result-feedback";
import { toolDefinitionIdentity } from "./tool-definition-identity";
import { runToolRegistry as runToolRegistryForRun, toolRegistryView, visibleToolRegistry } from "./tool-registry";
import {
  applyTrajectoryTracker,
  createTrajectoryLoopControl,
  DefaultTrajectoryTracker,
} from "./trajectory/tracker";

const MAX_COMPACT_OUTPUT_TOKENS = 20_000;
const COMPACT_SUMMARIZER_SYSTEM_PROMPT = "You are a conversation summarizer.";
const RECOVERY_TOOL_TURNS = 2;
const TOOL_CORRECTION_LIMITS = { invalid_input: 3, precondition: 5 } as const;
const RECOVERY_FINALIZATION_PROMPT =
  "Stop using tools for this response. Explain the blocker, summarize what was attempted, and state what input or external change is needed to continue.";
const CHILD_FINALIZATION_PROMPT =
  "Stop using tools for this response. This delegated run reached its turn limit. State what was completed, what remains unfinished, and the evidence you have. Do not claim the task is verified.";

function userContentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      return "[image]";
    })
    .join("\n");
}

/**
 * Adapt a {@link StreamingMessageClient} into the {@link CompactClient} shape
 * that {@link CompactService} expects for LLM summarization.
 *
 * The summarizer is driven with a single user-role message carrying the
 * compaction prompt, no tools, and a bounded output budget — mirroring the
 * Python `_collect_summary` call (`stream_message(... system_prompt, tools=[],
 * max_tokens=MAX_OUTPUT_TOKENS_FOR_SUMMARY)`). The underlying stream is passed
 * straight through so `CompactService` can aggregate `text_delta` events and
 * surface `error` events as PTL-detectable failures.
 */
function toCompactClient(
  apiClient: StreamingMessageClient,
  model: string,
  options: {
    policy?: Partial<ModelRetryPolicy>;
    onAttemptFinished?: (event: ModelAttemptFinishedEvent) => void | Promise<void>;
  } = {},
): CompactClient {
  return {
    submitMessage(content: string, submitOptions?: { signal?: AbortSignal }): AsyncIterable<StreamEvent> {
      return streamBufferedModelWithRetry(
        apiClient,
        {
          model,
          messages: [{ type: "user", content }],
          system: COMPACT_SUMMARIZER_SYSTEM_PROMPT,
          maxTokens: MAX_COMPACT_OUTPUT_TOKENS,
          tools: undefined,
          abortSignal: submitOptions?.signal,
        },
        {
          ...(options.policy ? { policy: options.policy } : {}),
          ...(options.onAttemptFinished ? { onAttemptFinished: options.onAttemptFinished } : {}),
        },
      );
    },
  };
}

function isTruncatedStopReason(stopReason: string): boolean {
  return stopReason === "max_tokens" || stopReason === "length";
}

export class MaxTurnsExceeded extends Error {
  constructor(
    public readonly maxTurns: number,
    /** The reserved tool-free finalization reply, when one was produced. */
    public readonly finalizationText?: string,
  ) {
    super(`Exceeded maximum agentic turns (${maxTurns})`);
    this.name = "MaxTurnsExceeded";
  }
}

class ToolCorrectionsExceeded extends Error {
  constructor(kind: keyof typeof TOOL_CORRECTION_LIMITS | "recovery_guard", turns: number, lastFailure?: ToolExecutionResult) {
    const toolName = lastFailure?.toolName ?? "未知工具";
    const displayName = toolName.length > 80 ? toolName.slice(0, 80) + "…" : toolName;
    const hint = lastFailure ? toolFeedbackFields(lastFailure).recoveryHint : undefined;
    const reason = kind === "recovery_guard" ? "重复失败调用的恢复额度（" + turns + "轮）已耗尽"
      : (kind === "invalid_input" ? "工具参数" : "文件条件") + "在未完全成功的工具批次中累计 " + turns + " 轮失败";
    super(reason + "，本轮已停止自动纠错。最后失败工具：" + displayName
      + "。" + (hint ?? "请根据工具反馈检查参数和目标状态。") + " 此次停止不代表任务已完成。");
    this.name = kind === "recovery_guard" ? "ToolRecoveryExceeded"
      : kind === "invalid_input" ? "ToolInputCorrectionsExceeded" : "ToolPreconditionsExceeded";
  }
}

export interface SubmitMessageOptions {
  signal?: AbortSignal;
  execution?: AgentExecutionContext;
}

export class QueryEngine implements IQueryEngine {
  private messages: Message[] = [];
  private compactService: CompactService;
  private costTracker: CostTracker;
  private systemPrompt: string | undefined;
  private lastRunPrompt: { systemPrompt: string | undefined } | undefined;
  private lastMemoryReminderText: string | undefined;
  private model: string;
  private maxTurns: number;
  private skillRegistry?: unknown;
  private memoryRetriever?: MemoryRetriever;
  private allowedTools: string[] | null = null;
  private mcpManager: unknown = undefined;
  private mcpAuth: McpAuthHost | undefined;
  private terminal: AgentTerminalHost | undefined;
  private jobs: AgentJobHost | undefined;
  private backgroundShell: AgentBackgroundShellHost | undefined;
  private schedules: AgentScheduleEffects | undefined;
  private cwd: string;
  private sessionId: string | undefined;
  private reasoningEffort: string | undefined;
  private appliedRequestConfiguration: QueryRequestConfiguration | undefined;
  private readonly trustedOverrides: ReadonlyMap<string, { identity: symbol; execute: ToolDefinition["execute"] }>;

  constructor(
    private apiClient: StreamingMessageClient,
    private toolRegistry: IToolRegistry,
    private permissionChecker: IPermissionChecker,
    private hookExecutor: IHookExecutor,
    private options: QueryEngineOptions = {},
  ) {
    this.trustedOverrides = new Map([...options.trustedToolOverrides ?? []].map(([name, definition]) => [
      name, { identity: toolDefinitionIdentity(definition), execute: definition.execute },
    ]));
    this.model = options.model ?? "deepchat-chat";
    this.costTracker = new CostTracker();
    this.compactService = new CompactService(
      options.maxTokens ?? 100_000,
      options.compactKeepRecent ?? 10,
      {
        hookExecutor: this.hookExecutor,
        client: this.createCompactClient(this.apiClient, this.model),
      },
    );
    this.compactService.setProgressCallback(options.compactProgressCallback);
    this.systemPrompt = options.systemPrompt;
    this.maxTurns = options.maxTurns ?? 50;
    this.skillRegistry = options.skillRegistry;
    this.memoryRetriever = options.memoryRetriever;
    this.cwd = options.cwd ?? process.cwd();
    this.sessionId = options.sessionId;
    this.reasoningEffort = options.reasoningEffort;
  }

  /**
   * 设置/替换 per-turn 记忆检索回调。传入 undefined 可清除（恢复无记忆注入行为）。
   * 详见 {@link MemoryRetriever}。
   */
  setMemoryRetriever(retriever: MemoryRetriever | undefined): void {
    this.memoryRetriever = retriever;
  }

  /** 注册 compact 上下文提供者：compact 时注入附件目录、Session Memory 等结构化上下文。 */
  setCompactContextProvider(fn: CompactContextProvider | undefined): void {
    this.compactService.setCompactContextProvider(fn);
  }

  setAllowedTools(tools: string[] | null): void {
    this.allowedTools = tools;
  }

  setSessionId(sessionId: string | undefined): void {
    this.sessionId = sessionId;
  }

  setMcpManager(mgr: unknown): void {
    this.mcpManager = mgr;
  }

  setMcpAuth(auth: McpAuthHost | undefined): void {
    this.mcpAuth = auth;
  }

  setTerminal(terminal: AgentTerminalHost | undefined): void {
    this.terminal = terminal;
  }

  setJobs(jobs: AgentJobHost | undefined): void {
    this.jobs = jobs;
  }

  setBackgroundShell(backgroundShell: AgentBackgroundShellHost | undefined): void {
    this.backgroundShell = backgroundShell;
  }

  setSchedules(schedules: AgentScheduleEffects | undefined): void {
    this.schedules = schedules;
  }

  /**
   * 组合本轮发往 API 的 system 提示。
   *
   * 把常驻 systemPrompt 与本轮检索到的相关记忆（瞬态）拼接，仅用于这一次
   * streamMessage 调用，不写入 this.systemPrompt，也不进入 this.messages。
   * 注入风格参考 Python 的「# Relevant Memories」段（追加在 system 末尾）。
   */
  private composeTurnSystemPrompt(memoryContext: string | null, systemPrompt = this.systemPrompt): string | undefined {
    if (!memoryContext || !memoryContext.trim()) {
      this.lastMemoryReminderText = undefined;
      return systemPrompt;
    }
    const reminder = `<system-reminder>\n${memoryContext.trim()}\n</system-reminder>`;
    this.lastMemoryReminderText = reminder;
    if (systemPrompt && systemPrompt.trim()) {
      return `${systemPrompt}\n\n${reminder}`;
    }
    return reminder;
  }

  /**
   * 提交用户消息并处理与 AI 助手的交互流程，支持流式响应和工具调用。
   * 该方法会将用户消息加入历史记录，执行会话开始钩子，并在最大轮次限制内循环处理 AI 响应。
   * 如果 AI 返回工具调用请求，会自动执行工具并将结果反馈给 AI，直到不再需要工具调用或达到最大轮次。
   *
   * @param content - 用户发送的消息内容
   * @returns 一个异步迭代器，yield 出流式事件（StreamEvent），包括文本增量、工具使用开始/结束、用量信息等
   */
  async *submitMessage(
    content: string | ContentBlock[],
    options: SubmitMessageOptions = {},
  ): AsyncIterable<StreamEvent> {
    const initialRequestConfiguration = await this.resolveRequestConfiguration(options);
    const preparedContent = await this.prepareUserContent(
      content,
      options.signal,
      initialRequestConfiguration.client,
    );
    this.messages = sanitizeMessageHistory(this.messages).map((message) => message.type === "tool_result"
      ? { ...message, content: applyToolOutputBudget(message.content) }
      : message);
    this.messages.push({ type: "user", content: preparedContent });

    // per-turn 相关记忆检索：按本轮用户输入选相关记忆，作为瞬态上下文。
    // 仅在本轮（这次 submitMessage）拼进发往 API 的 system，不污染持久历史，
    // 也不改写常驻 systemPrompt。缺省未设 retriever 时该值为 undefined，
    // turnSystemPrompt 退化为 this.systemPrompt，行为与之前完全一致。
    let memoryContext: string | null = null;
    if (this.memoryRetriever) {
      try {
        memoryContext = await this.memoryRetriever(userContentToText(preparedContent));
      } catch {
        // retriever failure is non-fatal; continue without memory context
      }
    }
    const contribution = options.execution?.contribution;
    const runToolRegistry = runToolRegistryForRun(
      this.toolRegistry, this.allowedTools, contribution, options.execution?.capabilityView,
    );
    const internalTools = new Set(
      contribution?.tools
        ?.filter((item) => item.permission === "host-internal")
        .map((item) => item.definition.name) ?? [],
    );

    let turnCount = 0;
    const failedToolCalls = new ToolFailureMemory();
    const trajectoryTracker =
      this.options.trajectoryTrackerFactory === false
        ? undefined
        : (this.options.trajectoryTrackerFactory?.() ?? new DefaultTrajectoryTracker());
    const trajectoryControl = createTrajectoryLoopControl();
    let recoveryToolTurnsRemaining: number | null = null;
    const correctionTurns = { invalid_input: 0, precondition: 0 };
    let forceFinalResponse = false;
    let childFinalizing = false;
    let preparedNextRequestConfiguration: QueryRequestConfiguration | undefined;

    // The host may freeze a Run-scoped ceiling. It is applied locally to every
    // comparison so request configuration, setMaxTurns and accepted follow-ups
    // can only move the reusable engine's baseline, never this Run's ceiling.
    const hardMaxTurns = options.execution?.hardMaxTurns;
    const maxTurnsLimit = (): number =>
      hardMaxTurns === undefined ? this.maxTurns : Math.min(this.maxTurns, hardMaxTurns);

    // 执行会话开始时的钩子函数
    await this.hookExecutor.execute("session_start", {});

    while (turnCount < maxTurnsLimit() || forceFinalResponse) {
      // The first request must use the same client that prepared its attachments.
      const requestConfiguration = turnCount === 0
        ? initialRequestConfiguration
        : preparedNextRequestConfiguration ?? await this.resolveRequestConfiguration(options);
      preparedNextRequestConfiguration = undefined;
      this.applyRequestMaxTurns(requestConfiguration.maxTurns);
      if (turnCount >= maxTurnsLimit() && !forceFinalResponse) {
        throw new MaxTurnsExceeded(maxTurnsLimit());
      }
      const runSystemPrompt = requestConfiguration.systemPrompt
        ?? (options.execution?.capabilityView && this.options.systemPromptForRun
          ? await this.options.systemPromptForRun(options.execution.capabilityView)
          : this.systemPrompt);
      this.lastRunPrompt = { systemPrompt: runSystemPrompt };
      const baseSystemPrompt = this.composeTurnSystemPrompt(memoryContext, runSystemPrompt);
      const turnSystemPrompt = contribution?.systemGuidance
        ? appendSystemGuidance(baseSystemPrompt, contribution.systemGuidance)
        : baseSystemPrompt;
      this.compactService.setClient(
        this.createCompactClient(requestConfiguration.client, requestConfiguration.model, options.execution),
      );
      if (requestConfiguration.contextWindow !== undefined) {
        this.compactService.setContextWindow(requestConfiguration.contextWindow);
      }
      if (requestConfiguration.maxOutputTokens !== undefined) {
        this.compactService.setOutputReserve(requestConfiguration.maxOutputTokens);
      }
      // 自动压缩消息历史以控制上下文长度
      try {
        this.compactService.setProgressCallback((event) =>
          options.execution?.emit({
            type: "domain.event",
            data: {
              name: "context_compaction",
              payload: event as unknown as Record<string, unknown>,
            },
          }),
        );
        this.messages = await this.compactService.autoCompact(
          this.messages,
          "auto",
          options.signal,
        );
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        // compact failure is non-fatal; continue with current messages
      } finally {
        // Manual compaction after this turn must keep the resolved client/model
        // without retaining an emitter bound to this run.
        this.compactService.setClient(
          this.createCompactClient(requestConfiguration.client, requestConfiguration.model),
        );
      }
      this.messages = sanitizeMessageHistory(this.messages);

      // Reserve the last request under a frozen child cap for a tool-free
      // partial summary. Do not make an extra request after reaching the cap.
      if (hardMaxTurns !== undefined && turnCount + 1 >= maxTurnsLimit()) {
        childFinalizing = true;
      }
      const forcedFinalTurn = forceFinalResponse || childFinalizing;
      const visibleTools = runToolRegistry.getAll();
      const tools = forcedFinalTurn
        ? []
        : visibleTools.filter((tool) => !trajectoryControl.hiddenTools.includes(tool.name));
      const recoverySystem = forcedFinalTurn
        ? appendSystemGuidance(
            turnSystemPrompt,
            childFinalizing ? CHILD_FINALIZATION_PROMPT : RECOVERY_FINALIZATION_PROMPT,
          )
        : turnSystemPrompt;
      const system = trajectoryControl.guidance
        ? appendSystemGuidance(recoverySystem, trajectoryControl.guidance)
        : recoverySystem;
      this.appliedRequestConfiguration = requestConfiguration;
      if (this.options.resolveRequestConfiguration) {
        await options.execution?.emit({
          type: "domain.event",
          data: {
            name: "request.configuration",
            payload: {
              revision: requestConfiguration.revision,
              model: requestConfiguration.model,
              ...(requestConfiguration.provider ? { provider: requestConfiguration.provider } : {}),
              ...(requestConfiguration.effort !== undefined ? { effort: requestConfiguration.effort } : {}),
            },
          },
        });
      }
      const policy = normalizeModelRetryPolicy(this.options.modelRetry);
      const generationId = randomUUID();
      const retryCounters: RetryCounters = { request: 0, stream: 0, total: 0 };
      let recoveryDeadlineAt: number | undefined;
      let attempt = 1;

      let assistantText = "";
      let assistantReasoning = "";
      let assistantReasoningReplay = "";
      let assistantReasoningSegments: Array<{ source: "reasoning_content" | "think"; text: string }> = [];
      let assistantPhase: import("../types/messages").AssistantMessagePhase | undefined;
      let toolUses: ToolUseBlock[] = [];
      let stopReason = "end_turn";

      // 只把「当前模型调用」包进重试。工具执行、权限请求、压缩和整个 Run
      // 都在循环之外；每次重试冻结同一份请求参数与已确认输入。
      while (true) {
        yield { type: "generation_started", generationId, attempt };

        assistantText = "";
        assistantReasoning = "";
        assistantReasoningReplay = "";
        assistantReasoningSegments = [];
        assistantPhase = undefined;
        toolUses = [];
        stopReason = "end_turn";

        const attemptSignal = createAttemptSignal(options.signal, recoveryDeadlineAt);
        const attemptToolUses: ToolUseBlock[] = [];
        let attemptUsage: UsageSnapshot | undefined;
        let completionSeen = false;
        let attemptFailed: ModelRequestFailure | undefined;
        const pendingProgress = new Map<string, ToolGenerationProgressEvent>();
        const progressSentAt = new Map<string, number>();

        try {
          const stream = requestConfiguration.client.streamMessage({
            model: requestConfiguration.model,
            messages: this.messages,
            system,
            tools: tools.length > 0 ? tools : undefined,
            ...(requestConfiguration.maxOutputTokens !== undefined
              ? { maxTokens: requestConfiguration.maxOutputTokens }
              : {}),
            ...(requestConfiguration.reasoningEffort
              ? { reasoningEffort: requestConfiguration.reasoningEffort }
              : {}),
            abortSignal: attemptSignal.signal,
            requestTimeoutMs: policy.requestTimeoutMs,
            streamIdleTimeoutMs: policy.streamIdleTimeoutMs,
          });

          for await (const event of stream) {
            if (event.type === "text_delta") {
              assistantText += event.delta;
              assistantPhase = event.phase ?? assistantPhase;
              yield event;
            } else if (event.type === "reasoning_delta") {
              assistantReasoning += event.delta;
              const lastSegment = assistantReasoningSegments.at(-1);
              if (lastSegment?.source === event.source) lastSegment.text += event.delta;
              else assistantReasoningSegments.push({ source: event.source, text: event.delta });
              if (event.source === "reasoning_content") {
                assistantReasoningReplay += event.delta;
              }
              yield event;
            } else if (event.type === "tool_generation_progress") {
              const progress = { ...event, generationId, attempt };
              const now = Date.now();
              const lastSent = progressSentAt.get(event.toolKey);
              if (event.discarded === true || event.filePath === null) {
                pendingProgress.delete(event.toolKey);
                progressSentAt.delete(event.toolKey);
                yield progress;
              } else if (lastSent === undefined || now - lastSent >= 250) {
                progressSentAt.set(event.toolKey, now);
                pendingProgress.delete(event.toolKey);
                yield progress;
              } else {
                pendingProgress.set(event.toolKey, progress);
              }
            } else if (event.type === "tool_use_start") {
              attemptToolUses.push(event.toolUse);
            } else if (event.type === "usage") {
              attemptUsage = event.usage;
            } else if (event.type === "complete") {
              stopReason = event.stopReason;
              completionSeen = true;
            } else if (event.type === "error") {
              throw event.error;
            } else {
              yield event;
            }
          }

          if (!completionSeen) {
            throw new ModelRequestFailure(
              "模型流在完成前结束（缺少完成标记）",
              { kind: "stream_incomplete", phase: "stream", retryable: true },
            );
          }
        } catch (error) {
          attemptFailed = describeModelFailure(error, options.signal, attemptSignal);
        } finally {
          attemptSignal.dispose();
        }

        if (attemptFailed) {
          this.settleModelAttempt(attemptUsage, true);
          yield attemptFinishedEvent(
            generationId, attempt, options.signal?.aborted ? "interrupted" : "failed", attemptUsage,
          );

          if (options.signal?.aborted) throw options.signal.reason;
          if (!attemptFailed.info.retryable) throw attemptFailed;

          if (recoveryDeadlineAt === undefined) {
            recoveryDeadlineAt = Date.now() + policy.recoveryBudgetMs;
          }
          const now = Date.now();
          const delay = nextModelRetryDelay({
            failure: attemptFailed.info,
            counters: retryCounters,
            policy,
            now,
            deadlineAt: recoveryDeadlineAt,
            random: Math.random(),
          });
          if (delay === undefined) throw attemptFailed;

          if (attemptFailed.info.phase === "request") retryCounters.request++;
          else retryCounters.stream++;
          retryCounters.total++;

          yield {
            type: "model_retry",
            generationId,
            attempt,
            retryNumber: retryCounters.total,
            maxRetries: policy.maxTotalRetries,
            reason: attemptFailed.info.kind,
            nextRetryAt: now + delay,
            recoveryDeadlineAt,
          };
          await waitForModelRetry(delay, options.signal);
          attempt++;
          continue;
        }

        // 成功：补一次截断提示，然后发布缓冲的工具事件、结算用量并发出 complete。
        for (const progress of pendingProgress.values()) yield progress;
        if (isTruncatedStopReason(stopReason) && attemptToolUses.length === 0) {
          const notice =
            "\n\n⚠️ *回复已被截断：本轮输出长度达到上限。可发送「继续」让模型接着写完。*";
          assistantText += notice;
          yield { type: "text_delta", delta: notice };
        }

        toolUses = attemptToolUses;
        this.settleModelAttempt(attemptUsage, false);
        if (forcedFinalTurn && toolUses.length > 0) {
          // A provider can still emit a tool call when tools were omitted.
          // Reject it before recording an unexecuted call as committed history.
          yield attemptFinishedEvent(generationId, attempt, "failed", attemptUsage);
          if (childFinalizing) throw new MaxTurnsExceeded(maxTurnsLimit());
          throw new ModelRequestFailure(
            "模型在停止工具调用后仍返回了工具请求，本次请求未执行",
            { kind: "protocol", phase: "stream", retryable: false },
          );
        }
        for (const toolUse of toolUses) {
          yield { type: "tool_use_start", toolUse };
        }
        yield attemptFinishedEvent(generationId, attempt, "completed", attemptUsage);

        // 如果助手有文本、思考内容或工具调用，则将其添加到消息历史中
        if (assistantText || toolUses.length > 0 || assistantReasoning) {
          this.messages.push({
            type: "assistant",
            content: assistantText,
            phase: assistantPhase ?? (toolUses.length > 0 ? "commentary" : "final_answer"),
            toolUses: toolUses.length > 0 ? toolUses : undefined,
            ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
            ...(assistantReasoningReplay ? { reasoningReplay: assistantReasoningReplay } : {}),
            ...(assistantReasoningSegments.length > 0 ? { reasoningSegments: assistantReasoningSegments } : {}),
          });
        }

        yield { type: "complete", stopReason };
        forceFinalResponse = false;
        break;
      }

      if (toolUses.length > 0) {
        // 执行所有请求的工具调用，并将结果作为工具结果消息加入历史记录
        const recoveringAtTurnStart = recoveryToolTurnsRemaining !== null;
        const { results, failure } = await this.executeTools(
          toolUses,
          options.signal,
          options.execution,
          {
            model: requestConfiguration.model,
            ...(requestConfiguration.provider ? { provider: requestConfiguration.provider } : {}),
            ...(requestConfiguration.apiFormat ? { apiFormat: requestConfiguration.apiFormat } : {}),
          },
          failedToolCalls,
          runToolRegistry,
          internalTools,
        );
        const deliveredResults: ToolExecutionResult[] = [];
        for (let i = 0; i < results.length; i++) {
          const toolUse = toolUses[i]!;
          const tool = runToolRegistry.get(toolUse.name);
          const rawResult = withToolInputReuseHint(tool, toolUse, results[i]!, this.messages);
          const result = { ...rawResult, content: formatToolResultForModel(rawResult) };
          const recoveryGuard = result.metadata?.recoveryGuard;
          // A rejected retry never ran, and its failure is already recorded. Re-recording it
          // would refresh the record to the current evidence revision, which silently voids
          // the "new evidence unlocks a retry" contract whenever the evidence arrives earlier
          // in the same batch — leaving the recovered call blocked and burning the recovery
          // budget until the engine forces a blocker report.
          if (result.isError && !toolUse.inputError && !recoveryGuard && (!tool || tool.safeToRetry !== true)) {
            failedToolCalls.recordFailure(toolUse.name, toolUse.input);
          }
          if (recoveryGuard) {
            recoveryToolTurnsRemaining ??= RECOVERY_TOOL_TURNS;
          } else if (!result.isError) {
            failedToolCalls.noteEvidence();
          }
          this.messages.push({
            type: "tool_result",
            toolUseId: result.toolUseId,
            content: applyToolOutputBudget(result.content),
            isError: result.isError,
            ...toolFeedbackFields(result),
          });
          deliveredResults.push(result);
        }
        // Save the complete batch before a consumer can close this generator on delivery failure.
        for (const result of deliveredResults) yield { type: "tool_use_end", toolUseId: result.toolUseId, result };
        if (failure) throw failure.error;
        // Cancellation still owes every committed call its full result, in model order.
        options.signal?.throwIfAborted();
        // Evaluate the whole batch so a successful alternative cancels recovery
        // regardless of whether it appears before or after a rejected retry.
        if (results.some((result) => !result.isError)) recoveryToolTurnsRemaining = null;
        // Only a fully successful batch resets allowances; switching tools or failure kinds does not.
        if (results.every(result => !result.isError)) {
          correctionTurns.invalid_input = correctionTurns.precondition = 0;
        }
        for (const kind of ["invalid_input", "precondition"] as const) {
          const failed = results.filter(result => result.isError && result.failureKind === kind);
          if (failed.length) correctionTurns[kind]++;
          // The entire batch is settled before stopping; no extra model finalization request.
          if (correctionTurns[kind] >= TOOL_CORRECTION_LIMITS[kind]) {
            throw new ToolCorrectionsExceeded(kind, correctionTurns[kind], failed.at(-1));
          }
        }
        // Single removable integration point: commenting out this statement disables trajectory decisions.
        applyTrajectoryTracker(
          trajectoryTracker,
          {
            calls: toolUses.map((toolUse, index) => ({
              toolUse,
              result: results[index]!,
            })),
          },
          trajectoryControl,
        );
        if (trajectoryControl.forceFinal) forceFinalResponse = true;
        if (recoveringAtTurnStart && recoveryToolTurnsRemaining !== null) {
          recoveryToolTurnsRemaining--;
          if (recoveryToolTurnsRemaining <= 0) {
            throw new ToolCorrectionsExceeded("recovery_guard", RECOVERY_TOOL_TURNS, results.filter(result => result.isError).at(-1));
          }
        }
        turnCount++;
        if (this.options.resolveRequestConfiguration) {
          preparedNextRequestConfiguration = await this.resolveRequestConfiguration(options);
          this.applyRequestMaxTurns(preparedNextRequestConfiguration.maxTurns);
        }
        if (turnCount >= maxTurnsLimit()) {
          options.execution?.closeSteering();
          throw new MaxTurnsExceeded(
            maxTurnsLimit(),
            childFinalizing && assistantText ? assistantText : undefined,
          );
        }
        preparedNextRequestConfiguration = this.preserveAcceptedFollowUp(
          (await this.consumeFollowUps(options)).requestConfiguration,
          turnCount,
        );
        continue;
      }

      // 无工具调用：若 turn 边界有 follow-up，则继续同一 submitMessage
      if (this.options.resolveRequestConfiguration) {
        preparedNextRequestConfiguration = await this.resolveRequestConfiguration(options);
        this.applyRequestMaxTurns(preparedNextRequestConfiguration.maxTurns);
      }
      if (turnCount + 1 >= maxTurnsLimit()) {
        options.execution?.closeSteering();
        // The reserved child finalization is never a success signal: it only
        // leaves committed text for the caller to treat as an incomplete result.
        if (childFinalizing) {
          throw new MaxTurnsExceeded(maxTurnsLimit(), assistantText ? assistantText : undefined);
        }
        return;
      }
      const followUp = await this.consumeFollowUps(options, true);
      if (followUp.accepted) {
        turnCount++;
        preparedNextRequestConfiguration = this.preserveAcceptedFollowUp(
          followUp.requestConfiguration,
          turnCount,
        );
        continue;
      }
      return;
    }

    throw new MaxTurnsExceeded(maxTurnsLimit());
  }

  private async consumeFollowUps(
    options: SubmitMessageOptions,
    closeIfEmpty = false,
  ): Promise<{ accepted: boolean; requestConfiguration?: QueryRequestConfiguration }> {
    const followUps = await (options.execution?.takeSteeredInputs({
      closeIfEmpty,
    }) ?? []);
    if (followUps.length === 0) return { accepted: false };
    const requestConfiguration = await this.resolveRequestConfiguration(options);
    const preparedFollowUps = await Promise.all(
      followUps.map((input) => this.prepareUserContent(
        input.content, options.signal, requestConfiguration.client,
      )),
    );
    this.messages.push(
      ...preparedFollowUps.map((preparedContent) => ({
        type: "user" as const,
        content: preparedContent,
      })),
    );
    return { accepted: true, requestConfiguration };
  }

  private prepareUserContent(
    content: string | ContentBlock[],
    signal?: AbortSignal,
    client = this.apiClient,
  ): Promise<string | ContentBlock[]> {
    return client.prepareUserContent?.(content, { signal }) ?? Promise.resolve(content);
  }

  private async resolveRequestConfiguration(
    options: SubmitMessageOptions,
  ): Promise<QueryRequestConfiguration> {
    if (this.options.resolveRequestConfiguration) {
      return await this.options.resolveRequestConfiguration({
        signal: options.signal,
        capabilityView: options.execution?.capabilityView,
      });
    }
    return {
      revision: 0,
      model: this.model,
      client: this.apiClient,
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
    };
  }

  private applyRequestMaxTurns(maxTurns: number | undefined): void {
    if (maxTurns === undefined) return;
    if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) {
      throw new RangeError("maxTurns must be a positive safe integer");
    }
    this.maxTurns = maxTurns;
  }

  private preserveAcceptedFollowUp(
    configuration: QueryRequestConfiguration | undefined,
    nextTurnCount: number,
  ): QueryRequestConfiguration | undefined {
    if (!configuration) return undefined;
    const maxTurns = configuration.maxTurns ?? this.maxTurns;
    // Steering has already accepted this input; let its request finish if the limit just fell.
    return maxTurns <= nextTurnCount
      ? { ...configuration, maxTurns: nextTurnCount + 1 }
      : configuration;
  }

  /**
   * 每次实际请求恰好结算一次用量：已知快照累加一次，未知/不完整标记保留。
   * 不把适配器每次请求的累计快照重复相加。
   */
  private settleModelAttempt(usage: UsageSnapshot | undefined, incomplete: boolean): void {
    if (usage) this.costTracker.addUsage(usage);
    if (incomplete || !usage) this.costTracker.markUsageIncomplete();
  }

  getHistory(): Message[] {
    return [...this.messages];
  }

  getAppliedRequestConfiguration(): QueryRequestConfiguration | undefined {
    return this.appliedRequestConfiguration;
  }

  /**
   * Runtime-owned prompt source for context-usage accounting.
   * The reminder is the exact transient suffix used by the latest submitted turn.
   */
  getContextUsagePromptSource(): {
    systemPrompt?: string;
    memoryReminderText?: string;
  } {
    const systemPrompt = this.lastRunPrompt ? this.lastRunPrompt.systemPrompt : this.systemPrompt;
    return {
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(this.lastMemoryReminderText ? { memoryReminderText: this.lastMemoryReminderText } : {}),
    };
  }

  /**
   * 用于手动调用压缩消息历史，以控制上下文长度
   */
  async compact(): Promise<void> {
    const microResult = this.compactService.microCompact(this.messages);
    if (this.compactService.estimateTokens(microResult) < (this.options.maxTokens ?? 100_000)) {
      this.messages = microResult;
      return;
    }
    this.messages = await this.compactService.autoCompact(this.messages);
  }

  clear(): void {
    this.messages = [];
    this.costTracker.reset();
    this.lastRunPrompt = undefined;
    this.lastMemoryReminderText = undefined;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  setApiClient(client: StreamingMessageClient): void {
    this.apiClient = client;
    this.compactService.setClient(this.createCompactClient(this.apiClient, this.model));
  }

  setModel(model: string): void {
    this.model = model;
    // Keep the summarizer client pointed at the current model.
    this.compactService.setClient(this.createCompactClient(this.apiClient, this.model));
  }

  /**
   * 压缩摘要使用独立的辅助重试包装，按次结算用量到同一 CostTracker。
   * 不能把主生成包进这里，避免双层重试或重复计费。
   */
  private createCompactClient(
    client: StreamingMessageClient, model: string, execution?: AgentExecutionContext,
  ): CompactClient {
    return toCompactClient(client, model, {
      policy: this.options.modelRetry,
      onAttemptFinished: async (event) => {
        if (event.usage) this.costTracker.addUsage(event.usage);
        if (event.usageStatus !== "complete") this.costTracker.markUsageIncomplete();
        await execution?.emit({ type: "model.attempt.finished", data: {
          generationId: event.generationId, attempt: event.attempt,
          status: event.status, usageStatus: event.usageStatus,
          ...(event.usage ? { usage: event.usage } : {}),
        } });
        if (event.usage) await execution?.emit({ type: "usage.updated", data: { usage: event.usage } });
      },
    });
  }

  setMaxTurns(max: number): void {
    this.maxTurns = max;
  }

  loadMessages(messages: Message[]): void {
    this.messages = [...messages];
  }

  getTotalUsage(): UsageSnapshot {
    return this.costTracker.getTotal();
  }

  /**
   * 执行一组工具调用请求，并在执行前进行权限检查、钩子拦截及用户确认。
   *
   * 每项调用按组顺序检查权限；致命错误停止未启动调用，等待已启动调用结算。
   * 对于允许执行的工具，会在执行前后触发相应的生命周期钩子（pre_tool_use 和 post_tool_use）。
   * 最终返回与输入顺序对应的完整结果和首个致命错误。
   *
   * @param toolUses - 需要执行的工具调用块数组，包含工具名称、输入参数等信息。
   * @returns 完整结果与首个致命错误（若有）；调用者先保存结果再传播错误。
   */
  private async executeTools(
    toolUses: ToolUseBlock[],
    signal?: AbortSignal,
    execution?: AgentExecutionContext,
    requestConfiguration?: ToolContext["requestConfiguration"],
    failedToolCalls?: ToolFailureMemory,
    toolRegistry: IToolRegistry = visibleToolRegistry(this.toolRegistry, this.allowedTools),
    internalTools: ReadonlySet<string> = new Set(),
  ): Promise<{ results: ToolExecutionResult[]; failure?: { error: unknown } }> {
    return executeCheckedTools({
      toolUses, toolRegistry, messages: this.messages, permissionChecker: this.permissionChecker,
      hookExecutor: this.hookExecutor, signal, execution, timeoutMs: this.options.toolTimeoutMs,
      internalTools, failedToolCalls,
      createToolContext: (toolUse, toolAttemptId) => this.createToolContext(
        toolUse, toolAttemptId, toolRegistry, signal, execution, requestConfiguration,
      ),
      isTrustedSummary: (toolUse, definition) => this.isTrustedSummary(toolUse, definition, toolRegistry, execution),
    });
  }

  /** Executes one captured tool without requesting a model or changing conversation history. */
  async executeTool(
    toolUse: ToolUseBlock,
    options: { signal?: AbortSignal; execution: AgentExecutionContext },
  ): Promise<ToolExecutionResult> {
    const { execution } = options;
    // Empty allowlist fails closed when no captured view was supplied. Contributions do not widen this entry.
    const toolRegistry = runToolRegistryForRun(this.toolRegistry, [], undefined, execution.capabilityView);
    const signal = AbortSignal.any([execution.scope.signal, ...(options.signal ? [options.signal] : [])]);
    const { results, failure } = await executeCheckedTools({
      toolUses: [{ ...toolUse }], toolRegistry, messages: [], permissionChecker: this.permissionChecker,
      hookExecutor: this.hookExecutor, signal, execution, timeoutMs: this.options.toolTimeoutMs,
      createToolContext: (call, attemptId) => this.createToolContext(call, attemptId, toolRegistry, signal, execution),
      isTrustedSummary: (call, definition) => this.isTrustedSummary(call, definition, toolRegistry, execution),
    });
    if (failure) throw failure.error;
    return results[0]!;
  }

  private createToolContext(
    toolUse: ToolUseBlock,
    toolAttemptId: string,
    toolRegistry: IToolRegistry,
    signal?: AbortSignal,
    execution?: AgentExecutionContext,
    requestConfiguration?: ToolContext["requestConfiguration"],
  ): ToolContext {
    return {
      cwd: this.cwd,
      ...(this.options.executionEnvironment ? { environment: this.options.executionEnvironment } : {}),
      sessionId: this.sessionId,
      shellOutputLogs: this.options.shellOutputLogs,
      toolCallId: toolUse.id,
      toolAttemptId,
      runAbortSignal: signal,
      settings: this.options.settings,
      ...(requestConfiguration ? { requestConfiguration } : {}),
      toolRegistry: toolRegistryView(toolRegistry),
      capabilityView: execution?.capabilityView,
      skillRegistry: this.skillRegistry,
      // Global MCP meta APIs bypass captured tools; Runs with a View fail closed.
      mcpManager: execution?.capabilityView ? undefined : this.mcpManager,
      mcpAuth: execution?.capabilityView ? undefined : this.mcpAuth,
      terminal: this.terminal,
      jobs: this.jobs,
      backgroundShell: this.backgroundShell,
      schedules: this.schedules,
      ...(execution?.effects?.askUserPrompt
        ? { askUserPrompt: (question: string) => execution.effects.askUserPrompt!(question, execution.scope) }
        : {}),
      ...(execution?.effects?.requestPermission ? {
        requestPermission: (request) => execution.effects.requestPermission!(request, execution.scope),
      } : {}),
      agent: execution,
    };
  }

  private isTrustedSummary(
    toolUse: ToolUseBlock,
    definition: ToolDefinition,
    toolRegistry: IToolRegistry,
    execution?: AgentExecutionContext,
  ): boolean {
    const source = toolRegistry.inspect(toolUse.name)?.source.kind;
    return source === "builtin" || (source === "agent"
      && this.isTrustedOverride(toolUse.name, definition, execution?.capabilityView));
  }

  private isTrustedOverride(name: string, tool: ToolDefinition, view?: AgentExecutionContext["capabilityView"]): boolean {
    const approved = this.trustedOverrides.get(name);
    if (!approved) return false;
    if (view) {
      const binding = view.tools.get(name);
      return binding?.definitionIdentity === approved.identity
        && binding.definition.execute === approved.execute
        && tool.execute === binding.invoke;
    }
    return toolDefinitionIdentity(tool) === approved.identity && tool.execute === approved.execute;
  }
}

function appendSystemGuidance(systemPrompt: string | undefined, guidance: string): string {
  return systemPrompt?.trim() ? `${systemPrompt}\n\n${guidance}` : guidance;
}
