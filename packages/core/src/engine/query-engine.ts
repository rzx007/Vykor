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
} from "../index";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolRegistry as IToolRegistry,
  ToolRegistryView,
  ToolDescriptor,
} from "../types/tools";
import type { AgentTerminalHost } from "@openharness/terminal";
import type { AgentJobHost } from "@openharness/jobs";
import { CompactService, type CompactClient, type CompactContextProvider } from "./compact-service";
import { CostTracker } from "./cost-tracker";
import { sanitizeMessageHistory } from "../utils/message-history";
import { normalizeToolInput, validateToolInput } from "./tool-input-schema";
import { ToolFailureMemory } from "./tool-failure-memory";
import {
  applyTrajectoryTracker,
  createTrajectoryLoopControl,
  DefaultTrajectoryTracker,
} from "./trajectory/tracker";

const MAX_COMPACT_OUTPUT_TOKENS = 20_000;
const COMPACT_SUMMARIZER_SYSTEM_PROMPT = "You are a conversation summarizer.";
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
const RECOVERY_TOOL_TURNS = 2;
const MAX_FAILED_CALLS_PER_TOOL = 3;
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
  return readPositiveIntEnv("OPENHARNESS_TOOL_OUTPUT_INLINE_CHARS", 16_000, 256);
}

function toolOutputPreviewChars(): number {
  return readPositiveIntEnv("OPENHARNESS_TOOL_OUTPUT_PREVIEW_CHARS", 3_000, 128);
}

function toolExecutionTimeoutMs(override: number | undefined): number {
  if (typeof override === "number" && Number.isInteger(override) && override > 0) return override;
  return readPositiveIntEnv("OPENHARNESS_TOOL_TIMEOUT_MS", DEFAULT_TOOL_TIMEOUT_MS, 1);
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

  constructor(
    private apiClient: StreamingMessageClient,
    private toolRegistry: IToolRegistry,
    private permissionChecker: IPermissionChecker,
    private hookExecutor: IHookExecutor,
    private options: QueryEngineOptions = {},
  ) {
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
  private composeTurnSystemPrompt(memoryContext: string | null): string | undefined {
    if (!memoryContext || !memoryContext.trim()) {
      this.lastMemoryReminderText = undefined;
      return this.systemPrompt;
    }
    const reminder = `<system-reminder>\n${memoryContext.trim()}\n</system-reminder>`;
    this.lastMemoryReminderText = reminder;
    if (this.systemPrompt && this.systemPrompt.trim()) {
      return `${this.systemPrompt}\n\n${reminder}`;
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
    const preparedContent = await this.prepareUserContent(content, options.signal);
    this.messages = sanitizeMessageHistory(this.messages);
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
    const baseSystemPrompt = this.composeTurnSystemPrompt(memoryContext);
    const contribution = options.execution?.contribution;
    const turnSystemPrompt = contribution?.systemGuidance
      ? appendSystemGuidance(baseSystemPrompt, contribution.systemGuidance)
      : baseSystemPrompt;
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
    const failedCallsByTool = new Map<string, number>();
    const blockedTools = new Set<string>();
    let recoveryToolTurnsRemaining: number | null = null;
    let forceFinalResponse = false;

    // 执行会话开始时的钩子函数
    await this.hookExecutor.execute("session_start", {});

    while (turnCount < this.maxTurns || forceFinalResponse) {
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
        : visibleTools.filter(
            (tool) =>
              !blockedTools.has(tool.name) && !trajectoryControl.hiddenTools.includes(tool.name),
          );
      const finalizing = forcedFinalTurn || (blockedTools.size > 0 && tools.length === 0);
      const recoverySystem = finalizing
        ? appendSystemGuidance(turnSystemPrompt, RECOVERY_FINALIZATION_PROMPT)
        : turnSystemPrompt;
      const system = trajectoryControl.guidance
        ? appendSystemGuidance(recoverySystem, trajectoryControl.guidance)
        : recoverySystem;
      const stream = this.apiClient.streamMessage({
        model: this.model,
        messages: this.messages,
        system,
        tools: tools.length > 0 ? tools : undefined,
        abortSignal: options.signal,
      });
      forceFinalResponse = false;

      let assistantText = "";
      let assistantPhase: import("../types/messages").AssistantMessagePhase | undefined;
      const toolUses: ToolUseBlock[] = [];
      let stopReason = "end_turn";

      // 处理流式响应事件，累积文本和工具调用信息
      for await (const event of stream) {
        yield event;

        if (event.type === "text_delta") {
          assistantText += event.delta;
          assistantPhase = event.phase ?? assistantPhase;
        } else if (event.type === "tool_use_start") {
          toolUses.push(event.toolUse);
        } else if (event.type === "usage") {
          this.costTracker.addUsage(event.usage);
        } else if (event.type === "complete") {
          stopReason = event.stopReason;
        }
      }

      // 输出 token 用尽时追加截断提示，避免静默截断
      if (stopReason === "max_tokens" && toolUses.length === 0) {
        const notice =
          "\n\n⚠️ *输出已被截断（达到 max_tokens 上限）。可用 /compact 压缩上下文后继续。*";
        assistantText += notice;
        yield { type: "text_delta", delta: notice };
      }

      // 如果助手有文本回复或工具调用，则将其添加到消息历史中
      if (assistantText || toolUses.length > 0) {
        this.messages.push({
          type: "assistant",
          content: assistantText,
          phase: assistantPhase ?? (toolUses.length > 0 ? "commentary" : "final_answer"),
          toolUses: toolUses.length > 0 ? toolUses : undefined,
        });
      }

      if (toolUses.length > 0) {
        // 执行所有请求的工具调用，并将结果作为工具结果消息加入历史记录
        const recoveringAtTurnStart = recoveryToolTurnsRemaining !== null;
        const results = await this.executeTools(
          toolUses,
          options.signal,
          options.execution,
          failedToolCalls,
          blockedTools,
          runToolRegistry,
          internalTools,
        );
        for (let i = 0; i < results.length; i++) {
          const result = results[i]!;
          const toolUse = toolUses[i]!;
          const tool = runToolRegistry.get(toolUse.name);
          if (result.isError && (!tool || tool.safeToRetry !== true)) {
            failedToolCalls.recordFailure(toolUse.name, toolUse.input);
          }
          const recoveryGuard = result.metadata?.recoveryGuard;
          if (recoveryGuard) {
            recoveryToolTurnsRemaining ??= RECOVERY_TOOL_TURNS;
          } else if (result.isError) {
            const failures = (failedCallsByTool.get(toolUse.name) ?? 0) + 1;
            failedCallsByTool.set(toolUse.name, failures);
            if (failures >= MAX_FAILED_CALLS_PER_TOOL) {
              blockedTools.add(toolUse.name);
              recoveryToolTurnsRemaining ??= RECOVERY_TOOL_TURNS;
            }
          } else {
            failedCallsByTool.delete(toolUse.name);
            failedToolCalls.noteEvidence();
          }
          this.messages.push({
            type: "tool_result",
            toolUseId: result.toolUseId,
            content: applyToolOutputBudget(result.content),
            isError: result.isError,
          });
          yield { type: "tool_use_end", toolUseId: result.toolUseId, result };
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
            forceFinalResponse = true;
          }
        }
        turnCount++;
        if (turnCount >= this.maxTurns) {
          if (!forcedFinalTurn && (recoveryToolTurnsRemaining !== null || blockedTools.size > 0)) {
            options.execution?.closeSteering();
            forceFinalResponse = true;
            continue;
          }
          options.execution?.closeSteering();
          throw new MaxTurnsExceeded(this.maxTurns);
        }
        await this.consumeFollowUps(options);
        continue;
      }

      // 无工具调用：若 turn 边界有 follow-up，则继续同一 submitMessage
      if (turnCount + 1 >= this.maxTurns) {
        options.execution?.closeSteering();
        return;
      }
      if (await this.consumeFollowUps(options, true)) {
        turnCount++;
        continue;
      }
      return;
    }

    throw new MaxTurnsExceeded(this.maxTurns);
  }

  private async consumeFollowUps(
    options: SubmitMessageOptions,
    closeIfEmpty = false,
  ): Promise<boolean> {
    const followUps = await (options.execution?.takeSteeredInputs({
      closeIfEmpty,
    }) ?? []);
    if (followUps.length === 0) return false;
    const preparedFollowUps = await Promise.all(
      followUps.map((input) => this.prepareUserContent(input.content, options.signal)),
    );
    this.messages.push(
      ...preparedFollowUps.map((preparedContent) => ({
        type: "user" as const,
        content: preparedContent,
      })),
    );
    return true;
  }

  private prepareUserContent(
    content: string | ContentBlock[],
    signal?: AbortSignal,
  ): Promise<string | ContentBlock[]> {
    return this.apiClient.prepareUserContent?.(content, { signal }) ?? Promise.resolve(content);
  }

  getHistory(): Message[] {
    return [...this.messages];
  }

  /**
   * Runtime-owned prompt source for context-usage accounting.
   * The reminder is the exact transient suffix used by the latest submitted turn.
   */
  getContextUsagePromptSource(): {
    systemPrompt?: string;
    memoryReminderText?: string;
  } {
    return {
      ...(this.systemPrompt ? { systemPrompt: this.systemPrompt } : {}),
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
    failedToolCalls?: ToolFailureMemory,
    blockedTools?: ReadonlySet<string>,
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

      if (blockedTools?.has(toolUse.name)) {
        results[i] = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [
            {
              type: "text" as const,
              text: "Tool is unavailable for the rest of this response after repeated failures. Choose another approach or explain the blocker.",
            },
          ],
          isError: true,
          failureKind: "policy",
          metadata: { recoveryGuard: "tool_failure_limit" },
        };
        continue;
      }

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
          failureKind: "policy",
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
          failureKind: "policy",
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
            toolRegistry: this.toolRegistryView(toolRegistry),
            capabilityView: execution?.capabilityView,
            skillRegistry: this.skillRegistry,
            mcpManager: this.mcpManager,
            mcpAuth: this.mcpAuth,
            terminal: this.terminal,
            jobs: this.jobs,
            backgroundShell: this.backgroundShell,
            schedules: this.schedules,
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
              toolUseId: toolUse.id,
              toolName: toolUse.name,
              toolAttemptId,
              ...(result.isError && !result.failureKind ? { failureKind: "command" as const } : {}),
              ...result,
            } as ToolExecutionResult,
          };
        } catch (error) {
          if (signal?.aborted) {
            throw signal.reason;
          }
          const failureKind =
            error instanceof ToolTimeoutError ? ("timeout" as const) : ("command" as const);
          return {
            idx,
            result: {
              toolUseId: toolUse.id,
              toolName: toolUse.name,
              toolAttemptId,
              content: [{ type: "text" as const, text: String(error) }],
              isError: true,
              failureKind,
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

    return results;
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
        tool.execute(input, { ...context, abortSignal: controller.signal }),
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
