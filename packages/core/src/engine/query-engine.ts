import { randomUUID } from "node:crypto";

import type { Message, StreamEvent, ToolUseBlock, UsageSnapshot, ContentBlock } from "../index";
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
  ToolRegistrationSource,
  ToolRegistry as IToolRegistry,
  ToolRegistryView,
  ToolDescriptor,
} from "../types/tools";
import type { AgentTerminalHost } from "@vykor/terminal";
import type { AgentJobHost } from "@vykor/jobs";
import { CompactService, type CompactClient, type CompactContextProvider } from "./compact-service";
import { CostTracker } from "./cost-tracker";
import { sanitizeMessageHistory } from "../utils/message-history";
import { normalizeToolInput, validateToolInput } from "./tool-input-schema";
import { ToolFailureMemory } from "./tool-failure-memory";
import { defaultRecoveryHint, externalToolMetadata, formatToolResultForModel, toolFeedbackFields } from "./tool-result-feedback";
import { toolDefinitionIdentity } from "./tool-definition-identity";
import {
  applyTrajectoryTracker,
  createTrajectoryLoopControl,
  DefaultTrajectoryTracker,
} from "./trajectory/tracker";

const MAX_COMPACT_OUTPUT_TOKENS = 20_000;
const COMPACT_SUMMARIZER_SYSTEM_PROMPT = "You are a conversation summarizer.";
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
const RECOVERY_TOOL_TURNS = 2;
const RECOVERY_FINALIZATION_PROMPT =
  "Stop using tools for this response. Explain the blocker, summarize what was attempted, and state what input or external change is needed to continue.";

// ---------------------------------------------------------------------------
// Tool output budget — mirrors packages/services/src/tool-outputs.ts
// ---------------------------------------------------------------------------

function readPositiveIntEnv(name: string, defaultValue: number, minimum: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return defaultValue;
  return Math.max(minimum, parsed);
}

function toolOutputInlineChars(): number {
  return readPositiveIntEnv("VYKOR_TOOL_OUTPUT_INLINE_CHARS", 16_000, 256);
}

function toolOutputPreviewChars(): number {
  return readPositiveIntEnv("VYKOR_TOOL_OUTPUT_PREVIEW_CHARS", 3_000, 128);
}

function toolExecutionTimeoutMs(override: number | undefined): number {
  if (typeof override === "number" && Number.isInteger(override) && override > 0) return override;
  return readPositiveIntEnv("VYKOR_TOOL_TIMEOUT_MS", DEFAULT_TOOL_TIMEOUT_MS, 1);
}

class ToolTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Tool execution timed out after ${timeoutMs} ms`);
    this.name = "ToolTimeoutError";
  }
}

/**
 * 若工具输出总文本超过 inline 阈值，截断至 preview 阈值并附提示。
 * 图像块原样保留（由 token estimator 独立计算）。
 */
function applyToolOutputBudget(content: ContentBlock[]): ContentBlock[] {
  const inlineChars = toolOutputInlineChars();
  const previewChars = toolOutputPreviewChars();

  const totalText = content.reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0);
  if (totalText <= inlineChars) return content;

  const notice = `\n[输出已截断：原始长度 ${totalText} 字符，仅保留前 ${previewChars} 字符]`;
  let remaining = previewChars;
  const out: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "image") {
      out.push(block);
      continue;
    }
    if (remaining <= 0) continue;
    if (block.text.length <= remaining) {
      out.push(block);
      remaining -= block.text.length;
    } else {
      out.push({ type: "text", text: block.text.slice(0, remaining) + notice });
      remaining = 0;
    }
  }
  return out;
}

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
function toCompactClient(apiClient: StreamingMessageClient, model: string): CompactClient {
  return {
    submitMessage(content: string, options?: { signal?: AbortSignal }): AsyncIterable<StreamEvent> {
      return apiClient.streamMessage({
        model,
        messages: [{ type: "user", content }],
        system: COMPACT_SUMMARIZER_SYSTEM_PROMPT,
        maxTokens: MAX_COMPACT_OUTPUT_TOKENS,
        tools: undefined,
        abortSignal: options?.signal,
      });
    },
  };
}

function isTruncatedStopReason(stopReason: string): boolean {
  return stopReason === "max_tokens" || stopReason === "length";
}

export class MaxTurnsExceeded extends Error {
  constructor(public readonly maxTurns: number) {
    super(`Exceeded maximum agentic turns (${maxTurns})`);
    this.name = "MaxTurnsExceeded";
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
    this.compactService = new CompactService(
      options.maxTokens ?? 100_000,
      options.compactKeepRecent ?? 10,
      {
        hookExecutor: this.hookExecutor,
        client: toCompactClient(this.apiClient, this.model),
      },
    );
    this.compactService.setProgressCallback(options.compactProgressCallback);
    this.costTracker = new CostTracker();
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
    const runToolRegistry = this.runToolRegistry(contribution, options.execution?.capabilityView);
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
    let forceFinalResponse = false;
    let preparedNextRequestConfiguration: QueryRequestConfiguration | undefined;

    // 执行会话开始时的钩子函数
    await this.hookExecutor.execute("session_start", {});

    while (turnCount < this.maxTurns || forceFinalResponse) {
      // The first request must use the same client that prepared its attachments.
      const requestConfiguration = turnCount === 0
        ? initialRequestConfiguration
        : preparedNextRequestConfiguration ?? await this.resolveRequestConfiguration(options);
      preparedNextRequestConfiguration = undefined;
      this.applyRequestMaxTurns(requestConfiguration.maxTurns);
      if (turnCount >= this.maxTurns && !forceFinalResponse) {
        throw new MaxTurnsExceeded(this.maxTurns);
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
        toCompactClient(requestConfiguration.client, requestConfiguration.model),
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
      }
      this.messages = sanitizeMessageHistory(this.messages);

      const forcedFinalTurn = forceFinalResponse;
      const visibleTools = runToolRegistry.getAll();
      const tools = forcedFinalTurn
        ? []
        : visibleTools.filter((tool) => !trajectoryControl.hiddenTools.includes(tool.name));
      const recoverySystem = forcedFinalTurn
        ? appendSystemGuidance(turnSystemPrompt, RECOVERY_FINALIZATION_PROMPT)
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
        abortSignal: options.signal,
      });
      forceFinalResponse = false;

      let assistantText = "";
      let assistantReasoning = "";
      let assistantReasoningReplay = "";
      const assistantReasoningSegments: Array<{ source: "reasoning_content" | "think"; text: string }> = [];
      let assistantPhase: import("../types/messages").AssistantMessagePhase | undefined;
      const toolUses: ToolUseBlock[] = [];
      let stopReason = "end_turn";

      // 处理流式响应事件，累积文本和工具调用信息
      for await (const event of stream) {
        yield event;

        if (event.type === "text_delta") {
          assistantText += event.delta;
          assistantPhase = event.phase ?? assistantPhase;
        } else if (event.type === "reasoning_delta") {
          assistantReasoning += event.delta;
          const lastSegment = assistantReasoningSegments.at(-1);
          if (lastSegment?.source === event.source) lastSegment.text += event.delta;
          else assistantReasoningSegments.push({ source: event.source, text: event.delta });
          if (event.source === "reasoning_content") {
            assistantReasoningReplay += event.delta;
          }
        } else if (event.type === "tool_use_start") {
          toolUses.push(event.toolUse);
        } else if (event.type === "usage") {
          this.costTracker.addUsage(event.usage);
        } else if (event.type === "complete") {
          stopReason = event.stopReason;
        }
      }

      if (isTruncatedStopReason(stopReason) && toolUses.length === 0) {
        const notice =
          "\n\n⚠️ *回复已被截断：本轮输出长度达到上限。可发送「继续」让模型接着写完。*";
        assistantText += notice;
        yield { type: "text_delta", delta: notice };
      }

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

      if (toolUses.length > 0) {
        // 执行所有请求的工具调用，并将结果作为工具结果消息加入历史记录
        const recoveringAtTurnStart = recoveryToolTurnsRemaining !== null;
        const results = await this.executeTools(
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
        for (let i = 0; i < results.length; i++) {
          const rawResult = results[i]!;
          const result = { ...rawResult, content: formatToolResultForModel(rawResult) };
          const toolUse = toolUses[i]!;
          const tool = runToolRegistry.get(toolUse.name);
          const recoveryGuard = result.metadata?.recoveryGuard;
          // A rejected retry never ran, and its failure is already recorded. Re-recording it
          // would refresh the record to the current evidence revision, which silently voids
          // the "new evidence unlocks a retry" contract whenever the evidence arrives earlier
          // in the same batch — leaving the recovered call blocked and burning the recovery
          // budget until the engine forces a blocker report.
          if (result.isError && !recoveryGuard && (!tool || tool.safeToRetry !== true)) {
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
          yield { type: "tool_use_end", toolUseId: result.toolUseId, result };
        }
        // Evaluate the whole batch so a successful alternative cancels recovery
        // regardless of whether it appears before or after a rejected retry.
        if (results.some((result) => !result.isError)) recoveryToolTurnsRemaining = null;
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
            forceFinalResponse = true;
          }
        }
        turnCount++;
        if (this.options.resolveRequestConfiguration) {
          preparedNextRequestConfiguration = await this.resolveRequestConfiguration(options);
          this.applyRequestMaxTurns(preparedNextRequestConfiguration.maxTurns);
        }
        if (turnCount >= this.maxTurns) {
          if (!forcedFinalTurn && recoveryToolTurnsRemaining !== null) {
            options.execution?.closeSteering();
            forceFinalResponse = true;
            continue;
          }
          options.execution?.closeSteering();
          throw new MaxTurnsExceeded(this.maxTurns);
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
      if (turnCount + 1 >= this.maxTurns) {
        options.execution?.closeSteering();
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

    throw new MaxTurnsExceeded(this.maxTurns);
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
    this.compactService.setClient(toCompactClient(this.apiClient, this.model));
  }

  setModel(model: string): void {
    this.model = model;
    // Keep the summarizer client pointed at the current model.
    this.compactService.setClient(toCompactClient(this.apiClient, this.model));
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
   * 该函数会并行检查所有工具的权限，并根据检查结果决定是直接拒绝、询问用户还是继续执行。
   * 对于允许执行的工具，会在执行前后触发相应的生命周期钩子（pre_tool_use 和 post_tool_use）。
   * 最终返回与输入顺序对应的执行结果数组。
   *
   * @param toolUses - 需要执行的工具调用块数组，包含工具名称、输入参数等信息。
   * @returns 一个 Promise，解析为工具执行结果数组。每个结果对应输入数组中的一个工具调用，
   *          包含工具ID、名称、执行内容（或错误信息）以及是否出错的标志。
   */
  private async executeTools(
    toolUses: ToolUseBlock[],
    signal?: AbortSignal,
    execution?: AgentExecutionContext,
    requestConfiguration?: ToolContext["requestConfiguration"],
    failedToolCalls?: ToolFailureMemory,
    toolRegistry: IToolRegistry = this.visibleToolRegistry(),
    internalTools: ReadonlySet<string> = new Set(),
  ): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = new Array(toolUses.length);
    const readyForPermission: {
      idx: number;
      toolUse: ToolUseBlock;
      tool: NonNullable<ReturnType<IToolRegistry["get"]>>;
    }[] = [];

    for (let i = 0; i < toolUses.length; i++) {
      const toolUse = toolUses[i]!;

      if (failedToolCalls?.shouldReplayFailure(toolUse.name, toolUse.input)) {
        results[i] = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [
            {
              type: "text" as const,
              text: "Tool call already failed with the same input. Do not repeat it unless the input or underlying condition changes; choose another approach or explain the blocker.",
            },
          ],
          isError: true,
          failureKind: "policy",
          executionState: "not_started",
          metadata: { recoveryGuard: "repeated_failed_call" },
        };
        continue;
      }

      const tool = toolRegistry.get(toolUse.name);
      if (!tool) {
        results[i] = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [{ type: "text" as const, text: `Unknown tool: ${toolUse.name}` }],
          isError: true,
          failureKind: "invalid_input",
          executionState: "not_started",
        };
        continue;
      }

      toolUse.input = normalizeToolInput(tool.inputSchema, toolUse.input) as Record<
        string,
        unknown
      >;

      const validationError = validateToolInput(tool.inputSchema, toolUse.input);
      if (validationError) {
        results[i] = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [
            {
              type: "text" as const,
              text: `Tool input validation failed: ${validationError}`,
            },
          ],
          isError: true,
          failureKind: "invalid_input",
          executionState: "not_started",
        };
        continue;
      }

      readyForPermission.push({ idx: i, toolUse, tool });
    }

    // 并行检查所有工具的权限状态（单个 checkTool 抛错不应波及其他工具）
    const checks = await Promise.all(
      readyForPermission.map(async ({ toolUse }) => {
        if (internalTools.has(toolUse.name)) {
          return {
            action: "allow" as const,
            reason: "Trusted host-internal run tool",
          };
        }
        try {
          return await this.permissionChecker.checkTool(toolUse.name, toolUse.input);
        } catch {
          return { action: "deny" as const, reason: "permission check failed" };
        }
      }),
    );

    const executable: {
      idx: number;
      toolUse: ToolUseBlock;
      tool: NonNullable<ReturnType<IToolRegistry["get"]>>;
    }[] = [];

    for (let readyIndex = 0; readyIndex < readyForPermission.length; readyIndex++) {
      const { idx, toolUse, tool } = readyForPermission[readyIndex]!;
      const decision = checks[readyIndex]!;

      // 处理权限被直接拒绝的情况
      if (decision.action === "deny") {
        results[idx] = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [
            {
              type: "text" as const,
              text: `Permission denied: ${decision.reason ?? "not allowed"}`,
            },
          ],
          isError: true,
          failureKind: "permission",
          executionState: "not_started",
        };
        continue;
      }

      // 处理需要用户确认权限的情况
      if (decision.action === "ask") {
        let allowed = false;
        if (execution) {
          const requestId = `permission_${randomUUID()}`;
          const request = {
            toolName: toolUse.name,
            reason: decision.reason,
            input: toolUse.input,
          };
          await execution.emit({
            type: "permission.requested",
            data: { requestId, request },
          });
          const approval = await execution.effects.requestPermission(request, execution.scope);
          await execution.emit({
            type: "permission.resolved",
            data: { requestId, decision: approval },
          });
          allowed = approval.status === "approved";
        }
        if (!allowed) {
          results[idx] = {
            toolUseId: toolUse.id,
            toolName: toolUse.name,
            content: [
              {
                type: "text" as const,
                text: `Permission denied by user: ${decision.reason ?? "not confirmed"}`,
              },
            ],
            isError: true,
            failureKind: "permission",
            executionState: "not_started",
          };
          continue;
        }
      }

      // 执行工具使用前的钩子，若被钩子拦截则终止执行（hook 本身抛错时放行，不阻断执行）
      let hookResult: { blocked: boolean; reason?: string };
      try {
        hookResult = await this.hookExecutor.execute("pre_tool_use", {
          tool: toolUse.name,
          input: toolUse.input,
        });
      } catch {
        hookResult = { blocked: false };
      }

      if (hookResult.blocked) {
        results[idx] = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [
            {
              type: "text" as const,
              text: `Blocked by hook: ${hookResult.reason ?? "pre-tool hook blocked execution"}`,
            },
          ],
          isError: true,
          failureKind: "policy",
          executionState: "not_started",
        };
        continue;
      }

      executable.push({ idx, toolUse, tool });
    }

    // 并行执行所有通过校验的工具，并捕获执行过程中的异常
    const timeoutMs = toolExecutionTimeoutMs(this.options.toolTimeoutMs);
    const execResults = await Promise.all(
      executable.map(async ({ idx, toolUse, tool }) => {
        const toolAttemptId = `tool_attempt_${toolUse.id}_1`;
        try {
          const context: ToolContext = {
            cwd: this.cwd,
            ...(this.options.executionEnvironment
              ? { environment: this.options.executionEnvironment }
              : {}),
            sessionId: this.sessionId,
            toolCallId: toolUse.id,
            toolAttemptId,
            runAbortSignal: signal,
            settings: this.options.settings,
            ...(requestConfiguration ? { requestConfiguration } : {}),
            toolRegistry: this.toolRegistryView(toolRegistry),
            capabilityView: execution?.capabilityView,
            skillRegistry: this.skillRegistry,
            // Global MCP meta APIs can bypass captured tools by serverName. Until a
            // scoped resource/auth interface exists, Runs with a View fail closed.
            mcpManager: execution?.capabilityView ? undefined : this.mcpManager,
            mcpAuth: execution?.capabilityView ? undefined : this.mcpAuth,
            terminal: this.terminal,
            jobs: this.jobs,
            backgroundShell: this.backgroundShell,
            schedules: this.schedules,
            ...(execution?.effects?.askUserPrompt
              ? { askUserPrompt: (question: string) => execution.effects.askUserPrompt!(question, execution.scope) }
              : {}),
            ...(execution?.effects?.requestPermission
              ? {
                  requestPermission: (request) =>
                    execution.effects.requestPermission!(request, execution.scope),
                }
              : {}),
            agent: execution,
          };
          const result = await this.executeToolWithTimeout(
            tool,
            toolUse.input,
            context,
            timeoutMs,
            signal,
          );
          return {
            idx,
            result: {
              content: result.content,
              isError: result.isError,
              ...toolFeedbackFields(result),
              toolUseId: toolUse.id,
              toolName: toolUse.name,
              toolAttemptId,
              metadata: externalToolMetadata(result.metadata),
              compactSummary: (toolRegistry.inspect(toolUse.name)?.source.kind === "builtin"
                || (toolRegistry.inspect(toolUse.name)?.source.kind === "agent"
                  && this.isTrustedOverride(toolUse.name, tool, execution?.capabilityView)))
                ? toolFeedbackFields(result).compactSummary : undefined,
            } as ToolExecutionResult,
          };
        } catch (error) {
          if (signal?.aborted) {
            throw signal.reason;
          }
          const failureKind =
            error instanceof ToolTimeoutError ? ("timeout" as const) : ("unknown_outcome" as const);
          return {
            idx,
            result: {
              toolUseId: toolUse.id,
              toolName: toolUse.name,
              toolAttemptId,
              content: [{ type: "text" as const, text: String(error) }],
              isError: true,
              failureKind,
              executionState: "unknown",
            } as ToolExecutionResult,
          };
        }
      }),
    );

    // 将执行结果回填至结果数组，并执行工具使用后的钩子
    for (const { idx, result } of execResults) {
      results[idx] = result;
      await this.hookExecutor.execute("post_tool_use", {
        tool: result.toolName,
        result,
      });
    }

    // 防御性兜底：正常情况下每个槽位都已被 deny/ask/hook/unknown-tool/exec 之一填充；
    // 若未来逻辑变动导致某个槽位漏填，在此补一个错误结果，避免调用方遇到 undefined NPE。
    for (let i = 0; i < toolUses.length; i++) {
      if (!results[i]) {
        results[i] = {
          toolUseId: toolUses[i]!.id,
          toolName: toolUses[i]!.name,
          content: [
            {
              type: "text" as const,
              text: "Internal error: tool result was not computed",
            },
          ],
          isError: true,
        };
      }
    }

    return results.map((result) => {
      result.executionState ??= result.isError ? "unknown" : "completed";
      if (result.isError) {
        result.failureKind ??= "unknown_outcome";
        result.recoveryHint ??= defaultRecoveryHint(result);
        // Error summaries use host-normalized enums only, never external instructions.
        result.compactSummary = `Tool feedback data: kind=${result.failureKind}; execution=${result.executionState}`;
      }
      return result;
    });
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

  private async executeToolWithTimeout(
    tool: NonNullable<ReturnType<IToolRegistry["get"]>>,
    input: Record<string, unknown>,
    context: ToolContext,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<Awaited<ReturnType<NonNullable<ReturnType<IToolRegistry["get"]>>["execute"]>>> {
    const controller = new AbortController();
    const timeoutError = new ToolTimeoutError(timeoutMs);
    const deadlineAt = Date.now() + timeoutMs;
    let abortListener: (() => void) | undefined;
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) {
      abortFromExternal();
    } else {
      externalSignal?.addEventListener("abort", abortFromExternal, {
        once: true,
      });
    }
    const timeout = setTimeout(() => {
      controller.abort(timeoutError);
    }, timeoutMs);
    timeout.unref?.();

    const timeoutPromise = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason ?? timeoutError);
      if (controller.signal.aborted) {
        abortListener();
      } else {
        controller.signal.addEventListener("abort", abortListener, {
          once: true,
        });
      }
    });

    try {
      return await Promise.race([
        tool.execute(input, { ...context, abortSignal: controller.signal, deadlineAt }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeout);
      if (abortListener) {
        controller.signal.removeEventListener("abort", abortListener);
      }
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  }

  private visibleToolRegistry(alwaysAllowed: readonly string[] = []): IToolRegistry {
    const allowedTools = this.allowedTools;
    if (!allowedTools || allowedTools.includes("*")) return this.toolRegistry;
    const allowed = new Set([...allowedTools, ...alwaysAllowed]);
    const inner = this.toolRegistry;
    return {
      register(tool: ToolDefinition, source): void {
        inner.register(tool, source);
      },
      override(tool: ToolDefinition, source): void {
        inner.override(tool, source);
      },
      replaceBySource(source: ToolRegistrationSource, tools: ToolDefinition[]): void {
        inner.replaceBySource(source, tools);
      },
      unregister(name: string): boolean {
        return inner.unregister?.(name) ?? false;
      },
      get(name: string): ToolDefinition | undefined {
        return allowed.has(name) ? inner.get(name) : undefined;
      },
      getAll(): ToolDefinition[] {
        return inner.getAll().filter((tool) => allowed.has(tool.name));
      },
      has(name: string): boolean {
        return allowed.has(name) && inner.has(name);
      },
      inspect(name: string) {
        return allowed.has(name) ? inner.inspect(name) : undefined;
      },
    };
  }

  private runToolRegistry(
    contribution: AgentExecutionContext["contribution"],
    view?: AgentExecutionContext["capabilityView"],
  ): IToolRegistry {
    const captured = view && new Map([...view.tools].map(([name, binding]) => [
      name, { ...binding.definition, execute: binding.invoke },
    ]));
    const base: IToolRegistry = captured ? {
      register: () => { throw new Error("Run capability view is immutable"); },
      override: () => { throw new Error("Run capability view is immutable"); },
      replaceBySource: () => { throw new Error("Run capability view is immutable"); },
      get: (name) => captured.get(name),
      getAll: () => [...captured.values()],
      has: (name) => captured.has(name),
      inspect: (name) => {
        const binding = view!.tools.get(name);
        return binding ? { name, source: binding.source ?? { kind: "runtime" } } : undefined;
      },
    } : this.visibleToolRegistry();
    const contributed = contribution?.tools ?? [];
    if (contributed.length === 0) return base;
    const additions = new Map<string, ToolDefinition>();
    for (const { definition } of contributed) {
      if (base.has(definition.name) || additions.has(definition.name))
        throw new Error(`Run tool conflicts with an existing tool: ${definition.name}`);
      additions.set(definition.name, definition);
    }
    return {
      register: () => {
        throw new Error("Run-scoped tool registry is immutable");
      },
      override: () => {
        throw new Error("Run-scoped tool registry is immutable");
      },
      replaceBySource: () => {
        throw new Error("Run-scoped tool registry is immutable");
      },
      unregister: () => false,
      get: (name) => additions.get(name) ?? base.get(name),
      getAll: () => [...base.getAll(), ...additions.values()],
      has: (name) => additions.has(name) || base.has(name),
      inspect: (name) =>
        additions.has(name)
          ? { name, source: { kind: "runtime", id: "run-contribution" } }
          : base.inspect(name),
    };
  }

  private toolRegistryView(registry: IToolRegistry): ToolRegistryView {
    return {
      get: (name) => {
        const tool = registry.get(name);
        return tool ? toolDescriptor(tool) : undefined;
      },
      getAll: () => registry.getAll().map(toolDescriptor),
      has: (name) => registry.has(name),
      inspect: (name) => registry.inspect(name),
    };
  }
}

function appendSystemGuidance(systemPrompt: string | undefined, guidance: string): string {
  return systemPrompt?.trim() ? `${systemPrompt}\n\n${guidance}` : guidance;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function toolDescriptor(tool: ToolDefinition): ToolDescriptor {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: deepFrozenCopy(tool.inputSchema),
    ...(tool.safeToRetry === undefined ? {} : { safeToRetry: tool.safeToRetry }),
  });
}

function deepFrozenCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFrozenCopy(item))) as T;
  }
  if (value && typeof value === "object") {
    const copied = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        deepFrozenCopy(item),
      ]),
    );
    return Object.freeze(copied) as T;
  }
  return value;
}
