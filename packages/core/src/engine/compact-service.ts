/**
 * CompactService —— 对话上下文压缩服务
 *
 * 长会话中工具输出、文件内容会迅速占满模型 context window。本服务在
 * QueryEngine 每轮调用模型前自动触发（也可由 `/compact` 手动触发），
 * 按「先便宜后昂贵」的分层策略缩小历史，同时尽量保留任务连续性信息。
 *
 * 压缩阶梯（autoCompact）：
 *   1. microCompact      —— 清空旧工具结果正文（零模型调用）
 *   2. tryContextCollapse —— 对超长文本做头尾截断（零模型调用）
 *   3. llmCompact         —— 用 LLM 把旧消息摘要成一条 summary
 *   4. simpleCompact      —— 无 client / LLM 失败时的占位兜底
 *
 * 对齐 Python vykor v0.1.9 services/compact。
 */
import type {
  Message,
  ToolUseBlock,
  IHookExecutor,
} from "../index";
import { DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE } from "../constants/vision-tokens";
import {
  createCompactBoundaryMarker,
  estimateMessageTokens,
  microCompactMessages,
  replaceImagesWithPlaceholders,
  simpleCompactMessages,
  splitMessagesPreservingToolPairs,
  truncateHeadForPtlRetry,
  tryContextCollapseMessages,
} from "./compact-messages";
import { buildCompactPrompt, deriveWorkLog, extractRecentFiles } from "./compact-prompt";
import { collectSummary, formatSummary, isPromptTooLongError } from "./compact-summary";
export { isPromptTooLongError } from "./compact-summary";
import type {
  CompactCheckpoint,
  CompactClient,
  CompactContext,
  CompactContextProvider,
  CompactProgressCallback,
  CompactProgressEvent,
  CompactServiceOptions,
  CompactTrigger,
} from "./compact-types";

export type {
  CompactCheckpoint,
  CompactClient,
  CompactContext,
  CompactContextProvider,
  CompactContextSection,
  CompactProgressCallback,
  CompactProgressEvent,
  CompactProgressPhase,
  CompactServiceOptions,
  CompactTrigger,
} from "./compact-types";

// ---------------------------------------------------------------------------
// 常量（与 Python vykor v0.1.9 services/compact 对齐）
// ---------------------------------------------------------------------------

/** 自动压缩阈值缓冲：在 maxTokens 之外再留出的安全余量，避免刚压完又立刻超限。 */
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
/** 为摘要模型输出预留的最大 token 数；阈值计算时从 maxTokens 中扣除。 */
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
/** LLM 压缩连续失败达到此次数后，降级为只做 microCompact，避免反复打爆 API。 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Prompt Too Long（PTL）时，对摘要输入做头部截断后的最大重试次数。 */
const MAX_PTL_RETRIES = 3;

class CompactContextProviderError extends Error {
  constructor(cause: unknown) {
    super("Compact context provider failed", { cause });
    this.name = "CompactContextProviderError";
  }
}

// ---------------------------------------------------------------------------
// CompactService
// ---------------------------------------------------------------------------

export class CompactService {
  /** 上下文 token 上限（默认 100_000）；自动压缩阈值由此推导。 */
  private maxTokens: number;
  /** 阈值计算时预留的模型输出 token 数；至少为 MAX_OUTPUT_TOKENS_FOR_SUMMARY。 */
  private outputReserve: number;
  /**
   * 压缩时保留的「最近」消息 / 可清理工具结果条数（默认 10）。
   * 用于 splitPreservingToolPairs 与 microCompact 的保留窗口。
   */
  private keepRecent: number;
  /** 摘要用 LLM 客户端；可运行时 setClient 替换。 */
  private client: CompactClient | undefined;
  /** 压缩前后 hook。 */
  private hookExecutor: IHookExecutor | undefined;
  /** 进度订阅回调。 */
  private progressCallback: CompactProgressCallback | undefined;
  /** 估算单图占用的 token 数。 */
  private imageTokenEstimate: number;
  /** LLM 压缩连续失败计数；达上限后 autoCompact 只做 microCompact。 */
  private consecutiveFailures = 0;
  /** 本次 / 近期压缩过程中写入的检查点列表。 */
  private checkpoints: CompactCheckpoint[] = [];
  /** 外部结构化上下文提供者。 */
  private contextProvider: CompactContextProvider | undefined;

  /**
   * @param maxTokens 上下文上限
   * @param keepRecent 保留的最近消息/工具结果窗口
   * @param options LLM 客户端、hook、进度和附件等配置
   */
  constructor(
    maxTokens = 100_000,
    keepRecent = 10,
    options: CompactServiceOptions = {},
  ) {
    this.maxTokens = maxTokens;
    this.outputReserve = MAX_OUTPUT_TOKENS_FOR_SUMMARY;
    this.keepRecent = keepRecent;

    this.client = options.client;
    this.hookExecutor = options.hookExecutor;
    this.progressCallback = options.progressCallback;
    this.imageTokenEstimate =
      options.imageTokenEstimate ?? DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE;
    this.contextProvider = options.contextProvider;
  }

  /** 替换摘要客户端（例如切换 API provider 时）。 */
  setClient(client: CompactClient | undefined): void {
    this.client = client;
  }

  setContextWindow(tokens: number): void {
    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      throw new RangeError("Context window must be a positive safe integer");
    }
    this.maxTokens = tokens;
  }

  /**
   * 设置阈值预留的输出 token 数。传入当前模型的实际输出上限，使
   * `input + output ≤ context`：答案上限越大，清理线越低。
   * 下限保持 MAX_OUTPUT_TOKENS_FOR_SUMMARY，保证摘要调用自身有空间。
   */
  setOutputReserve(tokens: number): void {
    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      throw new RangeError("Output reserve must be a positive safe integer");
    }
    this.outputReserve = Math.max(tokens, MAX_OUTPUT_TOKENS_FOR_SUMMARY);
  }

  /** 注册 / 替换上下文提供者（由 QueryEngine 或 Host 接线后注入运行时上下文）。 */
  setCompactContextProvider(fn: CompactContextProvider | undefined): void {
    this.contextProvider = fn;
  }

  /** 挂载 hook 执行器，使 PRE_COMPACT / POST_COMPACT 事件生效。 */
  setHookExecutor(executor: IHookExecutor | undefined): void {
    this.hookExecutor = executor;
  }

  /** 注册进度回调（压缩各阶段会 emitProgress）。 */
  setProgressCallback(cb: CompactProgressCallback | undefined): void {
    this.progressCallback = cb;
  }

  /** 返回已记录检查点的浅拷贝（只读快照）。 */
  getCheckpoints(): CompactCheckpoint[] {
    return [...this.checkpoints];
  }

  // -------------------------------------------------------------------------
  // 自动压缩入口（QueryEngine 每轮调用）
  // -------------------------------------------------------------------------

  /**
   * 主入口：估算 token，若超过阈值则按阶梯压缩。
   *
   * 阈值 = maxTokens - outputReserve - AUTOCOMPACT_BUFFER_TOKENS
   *
   * 流程：
   * 1. 未超阈值 → 原样返回
   * 2. 连续 LLM 失败过多 → 只做 microCompact（避免雪崩）
   * 3. microCompact → 仍超则 tryContextCollapse → 仍超则 llmCompact
   * 4. 无 client 或 llmCompact 抛错 → simpleCompact 兜底
   */
  async autoCompact(
    messages: Message[],
    trigger: CompactTrigger = "auto",
    signal?: AbortSignal,
  ): Promise<Message[]> {
    const estimated = this.estimateTokens(messages);
    const threshold =
      this.maxTokens - this.outputReserve - AUTOCOMPACT_BUFFER_TOKENS;

    // 空间还够，跳过压缩。
    if (estimated < threshold) return messages;

    // 连续失败过多：不再打摘要 API，只清旧工具结果。
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return this.microCompact(messages);
    }

    // 第一层：便宜清理。往往单独就足够回到阈值以下。
    let working = this.microCompact(messages);
    if (this.estimateTokens(working) < threshold) {
      return working;
    }

    // 第二层：确定性压短超大文本（仍不调模型）。
    const collapsed = this.tryContextCollapse(working);
    if (collapsed) {
      await this.emitProgress({
        phase: "context_collapse_start",
        trigger,
        message: "Collapsing oversized context before full compaction.",
        checkpoint: "context_collapse_start",
      });
      working = collapsed;
      await this.emitProgress({
        phase: "context_collapse_end",
        trigger,
        message: "Context collapse complete.",
        checkpoint: "context_collapse_end",
        metadata: this.recordCheckpoint("context_collapse_end", trigger, working),
      });
      if (this.estimateTokens(working) < threshold) {
        return working;
      }
    }

    // 第三层：有 summarizer client 则做完整 LLM 摘要。
    if (this.client) {
      try {
        const result = await this.llmCompact(working, trigger, signal);
        this.consecutiveFailures = 0;
        return result;
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (err instanceof CompactContextProviderError) throw err;
        this.consecutiveFailures++;
        await this.emitProgress({
          phase: "compact_failed",
          trigger,
          message: String(err instanceof Error ? err.message : err),
          checkpoint: "compact_failed",
          metadata: this.recordCheckpoint("compact_failed", trigger, working, {
            reason: String(err instanceof Error ? err.message : err),
            consecutiveFailures: this.consecutiveFailures,
          }),
        });
      }
    }

    // 第四层：占位摘要兜底（无 client 或 LLM 失败）。
    return this.simpleCompact(working);
  }

  // -------------------------------------------------------------------------
  // Simple compact —— 不调模型的确定性兜底摘要
  // -------------------------------------------------------------------------

  /**
   * 把 older 段换成一条占位 assistant 消息 + boundary marker，再拼上 recent。
   * 不调用模型，仅保留最近的有界工具事实，信息损失大，仅作最后手段。
   * system 消息始终前置保留。
   */
  simpleCompact(messages: Message[]): Message[] {
    return simpleCompactMessages(messages, this.keepRecent);
  }

  // -------------------------------------------------------------------------
  // Microcompact —— 低成本清空旧的、可压缩工具结果
  // -------------------------------------------------------------------------

  /**
   * 收集按出现顺序排列的「可压缩」tool_result id，
   * 保留最近 keepRecent 条，更早的结果正文替换为占位文案。
   *
   * 注意：不删除消息本身，保留受控事实并清理大正文，避免破坏工具配对。
   */
  microCompact(messages: Message[]): Message[] {
    return microCompactMessages(messages, this.keepRecent);
  }

  // -------------------------------------------------------------------------
  // Context collapse —— 确定性压短超大文本 / 工具结果
  // -------------------------------------------------------------------------

  /**
   * 对 older 段中的超长 user / assistant / tool_result 文本做头尾截断。
   * @returns 有实际缩短且 token 估算下降时返回新数组；否则返回 null（调用方跳过本层）。
   */
  tryContextCollapse(messages: Message[]): Message[] | null {
    return tryContextCollapseMessages(messages, this.keepRecent, this.imageTokenEstimate);
  }

  // -------------------------------------------------------------------------
  // LLM compact —— 调用摘要模型；遇 PTL 则头部截断重试
  // -------------------------------------------------------------------------

  /**
   * 完整 LLM 压缩：
   * 1. 分离 system / older / recent（保护工具成对）
   * 2. 执行 pre_compact hook（可拦截）
   * 3. 图片替换为占位符，拼 attachments 进 prompt
   * 4. collectSummary；若 PTL 则 truncateHead 后最多重试 MAX_PTL_RETRIES 次
   * 5. 组装 [system..., summary, boundary, ...recent]，再跑 post_compact
   */
  private async llmCompact(
    messages: Message[],
    trigger: CompactTrigger,
    signal?: AbortSignal,
  ): Promise<Message[]> {
    if (!this.client) throw new Error("No LLM client");

    const systemMessages = messages.filter((m) => m.type === "system");
    const nonSystem = messages.filter((m) => m.type !== "system");

    const { older, recent } = this.splitPreservingToolPairs(nonSystem);
    // 没有可摘要的 older 段 → 无需压缩。
    if (!older.length) return messages;

    const preTokens = this.estimateTokens(messages);

    // PRE_COMPACT hook：外部可选择 blocked 跳过本次压缩。
    if (this.hookExecutor) {
      const hookResult = await this.hookExecutor.execute("pre_compact", {
        trigger,
        messageCount: messages.length,
        tokenCount: preTokens,
        preserveRecent: this.keepRecent,
        discoveredTools: this.extractDiscoveredTools(older),
      });
      if (hookResult.blocked) {
        // 被拦截：不改动 messages，只记检查点。
        this.recordCheckpoint("compact_blocked", trigger, messages, {
          reason: hookResult.reason ?? "pre-compact hook blocked compaction",
        });
        return messages;
      }
    }

    await this.emitProgress({
      phase: "compact_start",
      trigger,
      message: "Compacting conversation memory.",
      checkpoint: "compact_start",
      metadata: this.recordCheckpoint("compact_start", trigger, messages),
    });

    // 摘要请求里不要带真实图片二进制，替换为占位文本即可。
    let summarizable = this.replaceImagesWithPlaceholders(older);

    // 汇总 context：先自动从历史抽取，再与外部 provider 合并（外部优先）。
    const autoFiles = extractRecentFiles(messages);
    const autoWorkLog = deriveWorkLog(messages);
    let context: CompactContext = {
      recentFiles: autoFiles.length > 0 ? autoFiles : undefined,
      workLog: autoWorkLog,
    };
    if (this.contextProvider) {
      let external: CompactContext;
      try {
        external = await this.contextProvider();
      } catch (cause) {
        throw new CompactContextProviderError(cause);
      }
      context = {
        sessionMemory: external.sessionMemory ?? context.sessionMemory,
        taskFocus: external.taskFocus ?? context.taskFocus,
        recentFiles: external.recentFiles ?? context.recentFiles,
        plan: external.plan ?? context.plan,
        workLog: external.workLog ?? context.workLog,
        supplementalSections:
          external.supplementalSections ?? context.supplementalSections,
      };
    }
    const compactPrompt = buildCompactPrompt(context);

    let summaryText = "";
    let ptlRetries = 0;

    // 摘要循环：成功则 break；PTL 且还能截断则 continue；其它错误抛出。
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        summaryText = await collectSummary(this.client, summarizable, compactPrompt, signal);
        break;
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (isPromptTooLongError(err) && ptlRetries < MAX_PTL_RETRIES) {
          const truncated = this.truncateHeadForPtlRetry(summarizable);
          if (truncated) {
            ptlRetries++;
            summarizable = truncated;
            await this.emitProgress({
              phase: "compact_retry",
              trigger,
              message:
                "Compaction prompt was too large; retrying with older context trimmed.",
              attempt: ptlRetries,
              checkpoint: "compact_retry_prompt_too_long",
              metadata: this.recordCheckpoint(
                "compact_retry_prompt_too_long",
                trigger,
                summarizable,
                { ptlRetries },
              ),
            });
            continue;
          }
        }
        throw err;
      }
    }

    const formatted = formatSummary(summaryText) ||
      "[Conversation compacted via LLM summary]";

    const summary: Message = {
      type: "assistant",
      content: formatted,
      compactRole: "summary",
    };

    // postCount = system + summary + boundary + recent
    const postCount = systemMessages.length + 1 + 1 + recent.length;
    const boundary = this.createBoundaryMarker({
      trigger,
      compactKind: "full",
      preMessageCount: messages.length,
      preTokenCount: preTokens,
      postMessageCount: postCount,
      usedHeadTruncationRetry: ptlRetries > 0,
    });

    // POST_COMPACT hook：通知外部压缩已完成及前后 footprint。
    if (this.hookExecutor) {
      await this.hookExecutor.execute("post_compact", {
        trigger,
        preCompactMessageCount: messages.length,
        postCompactMessageCount: postCount,
        preCompactTokens: preTokens,
        postCompactTokens: this.estimateTokens([summary, ...recent]),
        usedHeadTruncationRetry: ptlRetries > 0,
      });
    }

    const result = [...systemMessages, summary, boundary, ...recent];
    await this.emitProgress({
      phase: "compact_end",
      trigger,
      message: "Conversation compaction complete.",
      checkpoint: "compact_end",
      metadata: this.recordCheckpoint("compact_end", trigger, result, {
        preCompactTokens: preTokens,
        postCompactTokens: this.estimateTokens(result),
        ptlRetries,
      }),
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // PTL 头部截断 —— 丢掉最老的 prompt rounds，必要时插入重试标记
  // -------------------------------------------------------------------------

  /**
   * 摘要请求因 PTL 失败时：按「用户开启的一轮」分组，丢掉约 1/5 的最老组
   *（至少 1 组，且至少保留 1 组），再扁平化返回。
   *
   * 若截断后首条不是 user（而是 assistant / tool_result），
   * 前面插入 PTL_RETRY_MARKER，避免 API 对消息角色顺序校验失败。
   *
   * @returns 截断后的消息；无法再截（不足 2 组）时返回 null。
   */
  truncateHeadForPtlRetry(messages: Message[]): Message[] | null {
    return truncateHeadForPtlRetry(messages);
  }

  // -------------------------------------------------------------------------
  // 工具成对保护 —— 绝不把 tool_use 与其 tool_result 拆到不同段
  // -------------------------------------------------------------------------

  /**
   * 在 keepRecent 边界把消息切成 older / recent。
   * 若切点会把某条 assistant 的 tool_use 留在 older、而其 tool_result 在 recent，
   * 则把 splitIndex 向前挪，直到配对不再被拆开。
   *
   * 这对 OpenAI / Anthropic 等「tool call 必须有对应 result」的校验至关重要。
   */
  splitPreservingToolPairs(messages: Message[]): { older: Message[]; recent: Message[] } {
    return splitMessagesPreservingToolPairs(messages, this.keepRecent);
  }

  // -------------------------------------------------------------------------
  // 图片处理
  // -------------------------------------------------------------------------

  /**
   * 把 user / tool_result 中的 image block 换成占位文本。
   * 摘要模型不需要真实像素，且图片极大，直接送去会立刻 PTL。
   */
  replaceImagesWithPlaceholders(messages: Message[]): Message[] {
    return replaceImagesWithPlaceholders(messages);
  }

  // -------------------------------------------------------------------------
  // 压缩边界标记
  // -------------------------------------------------------------------------

  /**
   * 创建一条 user 消息作为「压缩边界」：
   * 告诉后续模型「上面是摘要、下面是未压缩的近期消息」，并记录触发源与 footprint。
   * 插在 summary 与 recent 之间。
   */
  createBoundaryMarker(metadata: {
    trigger: CompactTrigger;
    compactKind: string;
    preMessageCount?: number;
    preTokenCount?: number;
    postMessageCount?: number;
    usedHeadTruncationRetry?: boolean;
  }): Message {
    return createCompactBoundaryMarker(metadata);
  }

  // -------------------------------------------------------------------------
  // Token 估算（含图片：每张约 imageTokenEstimate）
  // -------------------------------------------------------------------------

  /**
   * 保守估算消息列表占用的 token 数。
   * - assistant：正文 + 可回传的 reasoning + 每个 tool_use 的 name / input
   * - 其它：字符串 content，或遍历 text / image block
   * 最后乘 TOKEN_ESTIMATION_PADDING 并向上取整。
   */
  estimateTokens(messages: Message[]): number {
    return estimateMessageTokens(messages, this.imageTokenEstimate);
  }

  // -------------------------------------------------------------------------
  // 内部：已发现工具列表 / 进度 / 检查点
  // -------------------------------------------------------------------------

  /** 从消息中按首次出现顺序收集工具名，供 pre_compact hook 使用。 */
  private extractDiscoveredTools(messages: Message[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const msg of messages) {
      if (msg.type === "assistant" && msg.toolUses) {
        for (const tu of msg.toolUses) {
          if (tu.name && !seen.has(tu.name)) {
            seen.add(tu.name);
            out.push(tu.name);
          }
        }
      }
    }
    return out;
  }

  /** 写入一条检查点并返回；同时塞进 this.checkpoints。 */
  private recordCheckpoint(
    checkpoint: string,
    trigger: CompactTrigger,
    messages: Message[],
    details?: Record<string, unknown>,
  ): CompactCheckpoint {
    const payload: CompactCheckpoint = {
      checkpoint,
      trigger,
      messageCount: messages.length,
      tokenCount: this.estimateTokens(messages),
      ...(details ?? {}),
    };
    this.checkpoints.push(payload);
    return payload;
  }

  /** 若已注册 progressCallback 则转发事件。 */
  private async emitProgress(event: CompactProgressEvent): Promise<void> {
    if (!this.progressCallback) return;
    await this.progressCallback(event);
  }
}

/** 类型再导出：消费者也可从本模块拿到 ToolUseBlock（主入口仍推荐 @vykor/core）。 */
export type { ToolUseBlock };
