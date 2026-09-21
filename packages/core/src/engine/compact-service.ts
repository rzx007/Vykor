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
 * 对齐 Python openharness v0.1.9 services/compact。
 */
import type {
  Message,
  StreamEvent,
  ContentBlock,
  ToolUseBlock,
  IHookExecutor,
} from "../index";
import { DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE } from "../constants/vision-tokens";
import { estimateTokens } from "../utils/token-counter";
import {
  boundaryFallsInsideToolGroup as historyBoundaryFallsInsideToolGroup,
} from "../utils/message-history";

// ---------------------------------------------------------------------------
// 常量（与 Python openharness v0.1.9 services/compact 对齐）
// ---------------------------------------------------------------------------

/** 自动压缩阈值缓冲：在 maxTokens 之外再留出的安全余量，避免刚压完又立刻超限。 */
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
/** 为摘要模型输出预留的最大 token 数；阈值计算时从 maxTokens 中扣除。 */
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
/** LLM 压缩连续失败达到此次数后，降级为只做 microCompact，避免反复打爆 API。 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Prompt Too Long（PTL）时，对摘要输入做头部截断后的最大重试次数。 */
const MAX_PTL_RETRIES = 3;

/** microCompact 清空工具结果后写入的占位文案。 */
const TIME_BASED_MC_CLEARED_MESSAGE = "[Old tool result content cleared]";
/** PTL 重试砍掉最老轮次后，若剩余段不以 user 开头，则插入此标记保证对话结构合法。 */
const PTL_RETRY_MARKER = "[earlier conversation truncated for compaction retry]";

// ---------------------------------------------------------------------------
// microCompact 可清理工具白名单
// ---------------------------------------------------------------------------

/**
 * 这些内置工具的结果通常很长、且旧结果对续聊价值较低，允许被 microCompact 清空。
 * 未列入的工具结果一律保留（避免误删关键状态）。
 */
const MICROCOMPACTABLE_TOOLS = new Set([
  "Shell", "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch",
]);

/**
 * 判断某工具的结果是否允许被 microCompact 清理。
 * 规则：白名单内置工具 + 所有 MCP 工具（mcp__ 前缀）；其余保留。
 */
function isMicrocompactable(toolName: string): boolean {
  return MICROCOMPACTABLE_TOOLS.has(toolName) || toolName.startsWith("mcp__");
}

// ---------------------------------------------------------------------------
// Context collapse：对超大文本做确定性头尾截断（不调用模型）
// ---------------------------------------------------------------------------

/** 超过此字符数才触发 collapse；短于阈值的文本原样保留。 */
const CONTEXT_COLLAPSE_TEXT_CHAR_LIMIT = 2_400;
/** 截断后保留的头部字符数。 */
const CONTEXT_COLLAPSE_HEAD_CHARS = 900;
/** 截断后保留的尾部字符数。 */
const CONTEXT_COLLAPSE_TAIL_CHARS = 500;

/**
 * Token 估算的保守膨胀系数（与 Python 一致，约 4/3）。
 * estimateTokens 是启发式估算，乘 padding 降低「估少了导致真正超窗」的风险。
 */
const TOKEN_ESTIMATION_PADDING = 4 / 3;
/**
 * LLM 摘要提示词。
 * 要求模型先写 <analysis>（草稿/推理），再写 <summary>（正式续聊用摘要）；
 * formatSummary 会丢掉 analysis，只保留 summary 内容。
 */
const COMPACT_PROMPT = `Summarize the following conversation between the user and an AI assistant.

Produce your summary in two sections:

<analysis>
- Briefly describe what the user was trying to accomplish
- What approach was taken
- Key findings and decisions made
- Any errors encountered and how they were resolved
</analysis>

<summary>
- Concise narrative of the conversation progress
- Key state: files modified, tools used, results obtained
- Any pending items or follow-up actions needed
</summary>

Keep the summary concise and focused on information needed for continuing the task.`;

// ---------------------------------------------------------------------------
// 公开类型：触发源 / 进度事件 / 检查点
// ---------------------------------------------------------------------------

/** 压缩触发来源：自动（每轮）、手动（/compact）、被动（如 API 报超窗后）。 */
export type CompactTrigger = "auto" | "manual" | "reactive";

/** 压缩流水线各阶段，供 UI / 日志订阅。 */
export type CompactProgressPhase =
  | "context_collapse_start"
  | "context_collapse_end"
  | "compact_start"
  | "compact_retry"
  | "compact_end"
  | "compact_failed";

/** 进度回调入参：阶段 + 触发源 + 可选说明 / 重试次数 / 检查点快照。 */
export interface CompactProgressEvent {
  phase: CompactProgressPhase;
  trigger: CompactTrigger;
  message?: string;
  attempt?: number;
  checkpoint?: string;
  metadata?: Record<string, unknown>;
}

export type CompactProgressCallback = (
  event: CompactProgressEvent,
) => void | Promise<void>;

/**
 * 压缩过程中记录的检查点快照（消息数、token 数等），
 * 便于调试「压到哪一步、前后 footprint 变化」。
 */
export interface CompactCheckpoint {
  checkpoint: string;
  trigger: CompactTrigger;
  messageCount: number;
  tokenCount: number;
  attempt?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Compact context（B.2）—— 注入摘要 prompt 的结构化上下文
// ---------------------------------------------------------------------------

/**
 * 压缩摘要时附加的结构化上下文。
 * 目的：摘要后模型仍能知道「当前任务 / 最近文件 / 计划」，降低断档感。
 */
export interface CompactContext {
  /** session_memory checkpoint 内容（帮助压缩后恢复任务状态，由 CLI 读入注入）。 */
  sessionMemory?: string;
  /** 当前正在进行的执行描述（来自具体运行时）。 */
  taskFocus?: string;
  /** 本会话访问过的文件路径（自动从历史抽取，或由外部注入覆盖）。 */
  recentFiles?: string[];
  /** 当前计划 / TODO 内容。 */
  plan?: string;
  /** 工具调用摘要（从历史自动统计，如 `Read×12, Shell×5`）。 */
  workLog?: string;
  /** 业务层提供的有界补充章节；core 只负责统一清洗和限额。 */
  supplementalSections?: CompactContextSection[];
}

export interface CompactContextSection {
  heading: string;
  content: string;
}

/** 由调用方（QueryEngine / CLI）提供外部上下文的工厂函数。 */
export type CompactContextProvider = () =>
  | CompactContext
  | Promise<CompactContext>;

class CompactContextProviderError extends Error {
  constructor(cause: unknown) {
    super("Compact context provider failed", { cause });
    this.name = "CompactContextProviderError";
  }
}

/** 构造 CompactService 的可选配置。 */
export interface CompactServiceOptions {
  /** 用于生成摘要的 LLM 客户端；未提供时只能走 micro/collapse/simple。 */
  client?: CompactClient;
  /** 压缩前后 hook 执行器（pre_compact / post_compact）。 */
  hookExecutor?: IHookExecutor;
  /** 进度回调，供 TUI / 前端展示压缩阶段。 */
  progressCallback?: CompactProgressCallback;
  /** 单图 token 估算覆盖值；默认 DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE。 */
  imageTokenEstimate?: number;
  /** 外部上下文提供者（附件目录、任务、计划、session memory 等）。 */
  contextProvider?: CompactContextProvider;
}

/** 摘要客户端最小接口：提交一段 prompt，消费流式事件。 */
export interface CompactClient {
  submitMessage(
    content: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent>;
}

// ---------------------------------------------------------------------------
// 错误分类：识别 llama.cpp / OpenAI 兼容接口的「上下文溢出」类错误
// ---------------------------------------------------------------------------

/** 错误消息中常见的「prompt 过长 / context 超限」关键词（小写匹配）。 */
const PTL_NEEDLES = [
  "prompt too long",
  "context_length_exceeded",
  "context length",
  "maximum context",
  "context window",
  "input tokens exceed",
  "messages resulted in",
  "reduce the length of the messages",
  "configured limit",
  "too many tokens",
  "too large for the model",
  "maximum context length",
  "exceed_context",
  "exceeds the available context size",
  "available context size",
];

/**
 * 判断错误是否属于 Prompt Too Long（上下文溢出）。
 * 命中后 llmCompact 会对摘要输入做头部截断并重试，而不是直接失败。
 */
export function isPromptTooLongError(err: unknown): boolean {
  const text = String(
    err instanceof Error ? err.message : err,
  ).toLowerCase();
  return PTL_NEEDLES.some((needle) => text.includes(needle));
}

// ---------------------------------------------------------------------------
// Message 辅助函数（TS Message 为判别联合类型）
// ---------------------------------------------------------------------------

/** 类型守卫：content block 是否为纯文本。 */
function isTextBlock(block: ContentBlock): block is { type: "text"; text: string } {
  return block.type === "text";
}

/** 类型守卫：content block 是否为图片。 */
function isImageBlock(block: ContentBlock): boolean {
  return block.type === "image";
}

/**
 * 把消息 content 拍平成纯文本（仅拼接 text block；图片等忽略）。
 * 用于判断「是否以有意义的 user 文本开启新一轮」等场景。
 */
function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

/** 取出 assistant 消息里发出的全部 tool_use id。 */
function toolUseIds(msg: Message): string[] {
  if (msg.type !== "assistant" || !msg.toolUses) return [];
  return msg.toolUses.map((tu) => tu.id);
}

/** 取出 tool_result 消息所对应的 tool_use id；非 tool_result 返回 undefined。 */
function toolResultId(msg: Message): string | undefined {
  return msg.type === "tool_result" ? msg.toolUseId : undefined;
}

// ---------------------------------------------------------------------------
// CompactService
// ---------------------------------------------------------------------------

export class CompactService {
  /** 上下文 token 上限（默认 100_000）；自动压缩阈值由此推导。 */
  private maxTokens: number;
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

  /** 注册 / 替换上下文提供者（由 QueryEngine 或 Host 接线后注入运行时上下文）。 */
  setCompactContextProvider(fn: CompactContextProvider | undefined): void {
    this.contextProvider = fn;
  }

  // -------------------------------------------------------------------------
  // Compact context 辅助（B.2）
  // -------------------------------------------------------------------------

  /**
   * 从消息历史自动提取最近访问的文件路径。
   * 扫描 assistant 的 Read / Write / Edit / MultiEdit 工具输入中的 file_path，
   * 去重后只保留最近 20 个，供摘要 prompt 的「Recently Accessed Files」段使用。
   */
  private extractRecentFiles(messages: Message[]): string[] {
    const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);
    const seen = new Set<string>();
    const files: string[] = [];
    for (const msg of messages) {
      if (msg.type === "assistant" && msg.toolUses) {
        for (const tu of msg.toolUses) {
          if (FILE_TOOLS.has(tu.name)) {
            const fp = (tu.input as Record<string, unknown>)?.file_path;
            if (typeof fp === "string" && !seen.has(fp)) {
              seen.add(fp);
              files.push(fp);
            }
          }
        }
      }
    }
    return files.slice(-20);
  }

  /**
   * 从消息历史统计工具调用次数，生成 `ToolName×count` 形式的 work log。
   * 按调用次数降序，帮助摘要模型理解「本会话主要在做什么」。
   */
  private deriveWorkLog(messages: Message[]): string | undefined {
    const counts = new Map<string, number>();
    for (const msg of messages) {
      if (msg.type === "assistant" && msg.toolUses) {
        for (const tu of msg.toolUses) {
          counts.set(tu.name, (counts.get(tu.name) ?? 0) + 1);
        }
      }
    }
    if (counts.size === 0) return undefined;
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}×${count}`)
      .join(", ");
  }

  /**
   * 把 context 拼进 COMPACT_PROMPT。
   * 无任何附加上下文时直接返回基础 prompt；有上下文则包在 <context> 中，
   * 并提示模型把这些信息写进摘要以便续聊。
   */
  private buildCompactPrompt(context: CompactContext): string {
    const sections: string[] = [];
    if (context.sessionMemory) {
      sections.push(`## Session Memory Checkpoint\n${context.sessionMemory}`);
    }
    if (context.taskFocus) {
      sections.push(`## Current Task\n${context.taskFocus}`);
    }
    if (context.recentFiles?.length) {
      sections.push(`## Recently Accessed Files\n${context.recentFiles.join("\n")}`);
    }
    if (context.plan) {
      sections.push(`## Current Plan\n${context.plan}`);
    }
    if (context.workLog) {
      sections.push(`## Work Log\n${context.workLog}`);
    }
    sections.push(...this.formatSupplementalSections(context.supplementalSections));
    if (sections.length === 0) return COMPACT_PROMPT;
    return (
      COMPACT_PROMPT +
      "\n\n<context>\n" +
      sections.join("\n\n") +
      "\n</context>\n\nIncorporate the above context into your summary to help resume work effectively."
    );
  }

  private formatSupplementalSections(
    supplementalSections: CompactContextSection[] | undefined,
  ): string[] {
    const sections: string[] = [];
    let remainingContentChars = 32_000;
    for (const section of supplementalSections ?? []) {
      if (sections.length >= 8 || remainingContentChars <= 0) break;
      const heading = section.heading
        .replace(/[\r\n]+/g, " ")
        .trim()
        .slice(0, 120);
      const content = section.content.trim();
      if (!heading || !content) continue;
      const boundedContent = content.slice(
        0,
        Math.min(16_000, remainingContentChars),
      );
      if (!boundedContent) continue;
      sections.push(`## ${heading}\n${boundedContent}`);
      remainingContentChars -= boundedContent.length;
    }
    return sections;
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
   * 阈值 = maxTokens - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS
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
      this.maxTokens - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS;

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
   * 不调用模型，信息损失大，仅作最后手段。
   * system 消息始终前置保留。
   */
  simpleCompact(messages: Message[]): Message[] {
    const systemMessages = messages.filter((m) => m.type === "system");
    const nonSystem = messages.filter((m) => m.type !== "system");

    const { older, recent } = this.splitPreservingToolPairs(nonSystem);
    if (older.length === 0) return messages;

    const compactedCount = older.length;
    const toolResultCount = older.filter((m) => m.type === "tool_result").length;

    const summary: Message = {
      type: "assistant",
      content: `[Conversation compacted: ${compactedCount} messages summarized (${toolResultCount} tool results removed). ${recent.length} recent messages preserved.]`,
      compactRole: "summary",
    };

    const boundary = this.createBoundaryMarker({
      trigger: "auto",
      compactKind: "simple",
      preMessageCount: messages.length,
      postMessageCount: systemMessages.length + 1 + recent.length,
    });

    return [...systemMessages, summary, boundary, ...recent];
  }

  // -------------------------------------------------------------------------
  // Microcompact —— 低成本清空旧的、可压缩工具结果
  // -------------------------------------------------------------------------

  /**
   * 收集按出现顺序排列的「可压缩」tool_result id，
   * 保留最近 keepRecent 条，更早的结果正文替换为占位文案。
   *
   * 注意：不删除消息本身，只清空 content，避免破坏 tool_use / tool_result 配对。
   */
  microCompact(messages: Message[]): Message[] {
    // 先建立 toolUseId → 工具名 映射，再判断每条 tool_result 是否可清理。
    const toolNameById = new Map<string, string>();
    for (const msg of messages) {
      if (msg.type === "assistant" && msg.toolUses) {
        for (const tu of msg.toolUses) toolNameById.set(tu.id, tu.name);
      }
    }

    const compactableIds: string[] = [];
    for (const msg of messages) {
      if (msg.type === "tool_result") {
        const name = toolNameById.get(msg.toolUseId) ?? "";
        if (isMicrocompactable(name)) {
          compactableIds.push(msg.toolUseId);
        }
      }
    }

    const keepCount = Math.max(1, this.keepRecent);
    if (compactableIds.length <= keepCount) {
      return messages;
    }
    // 需要清空的是「除最近 keepCount 条之外」的更早 id。
    const clearSet = new Set(
      compactableIds.slice(0, compactableIds.length - keepCount),
    );

    return messages.map((msg) => {
      if (msg.type !== "tool_result" || !clearSet.has(msg.toolUseId)) {
        return msg;
      }
      // 已清空过则跳过，避免重复 map 产生无意义新对象。
      const alreadyCleared =
        msg.content.length === 1 &&
        isTextBlock(msg.content[0]!) &&
        (msg.content[0] as { text: string }).text === TIME_BASED_MC_CLEARED_MESSAGE;
      if (alreadyCleared) return msg;
      return {
        ...msg,
        content: [{ type: "text" as const, text: TIME_BASED_MC_CLEARED_MESSAGE }],
      };
    });
  }

  // -------------------------------------------------------------------------
  // Context collapse —— 确定性压短超大文本 / 工具结果
  // -------------------------------------------------------------------------

  /**
   * 对 older 段中的超长 user / assistant / tool_result 文本做头尾截断。
   * @returns 有实际缩短且 token 估算下降时返回新数组；否则返回 null（调用方跳过本层）。
   */
  tryContextCollapse(messages: Message[]): Message[] | null {
    // 消息太少时没有「较旧」可压，直接跳过。
    if (messages.length <= this.keepRecent + 2) return null;

    const { older, recent } = this.splitPreservingToolPairs(messages);
    let changed = false;

    const collapsedOlder = older.map((msg) => {
      // user：content 可能是 ContentBlock[]（含 text / image）
      if (msg.type === "user" && Array.isArray(msg.content)) {
        const blocks = msg.content.map((b) => {
          if (isTextBlock(b)) {
            const collapsed = this.collapseText(b.text);
            if (collapsed !== b.text) changed = true;
            return { type: "text" as const, text: collapsed };
          }
          return b;
        });
        return { ...msg, content: blocks } as Message;
      }
      // user：纯字符串 content
      if (msg.type === "user" && typeof msg.content === "string") {
        const collapsed = this.collapseText(msg.content);
        if (collapsed !== msg.content) changed = true;
        return { ...msg, content: collapsed } as Message;
      }
      // assistant：content 为字符串
      if (msg.type === "assistant") {
        const collapsed = this.collapseText(msg.content);
        if (collapsed !== msg.content) changed = true;
        return { ...msg, content: collapsed } as Message;
      }
      // tool_result：content 为 block 数组
      if (msg.type === "tool_result") {
        const blocks = msg.content.map((b) => {
          if (isTextBlock(b)) {
            const collapsed = this.collapseText(b.text);
            if (collapsed !== b.text) changed = true;
            return { type: "text" as const, text: collapsed };
          }
          return b;
        });
        return { ...msg, content: blocks } as Message;
      }
      return msg;
    });

    if (!changed) return null;

    const result = [...collapsedOlder, ...recent];
    // 若估算未下降（例如 padding / 图片主导），视为无效，返回 null。
    if (this.estimateTokens(result) >= this.estimateTokens(messages)) {
      return null;
    }
    return result;
  }

  /**
   * 单段文本的头尾截断：保留头 CONTEXT_COLLAPSE_HEAD_CHARS + 尾 TAIL_CHARS，
   * 中间用 `...[collapsed N chars]...` 标明省略量。
   */
  private collapseText(text: string): string {
    if (text.length <= CONTEXT_COLLAPSE_TEXT_CHAR_LIMIT) return text;
    const omitted =
      text.length - CONTEXT_COLLAPSE_HEAD_CHARS - CONTEXT_COLLAPSE_TAIL_CHARS;
    const head = text.slice(0, CONTEXT_COLLAPSE_HEAD_CHARS).trimEnd();
    const tail = text.slice(-CONTEXT_COLLAPSE_TAIL_CHARS).trimStart();
    return `${head}\n...[collapsed ${omitted} chars]...\n${tail}`;
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
    const autoFiles = this.extractRecentFiles(messages);
    const autoWorkLog = this.deriveWorkLog(messages);
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
    const compactPrompt = this.buildCompactPrompt(context);

    let summaryText = "";
    let ptlRetries = 0;

    // 摘要循环：成功则 break；PTL 且还能截断则 continue；其它错误抛出。
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        summaryText = await this.collectSummary(summarizable, compactPrompt, signal);
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

    const formatted = this.formatSummary(summaryText) ||
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

  /**
   * 把待摘要消息序列化成对话文本，拼进 prompt，流式收集摘要模型输出。
   * 每条消息 content 最多截取 4000 字符，避免单条巨文再次撑爆摘要请求。
   */
  private async collectSummary(
    messages: Message[],
    customPrompt?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.client) throw new Error("No LLM client");

    const conversationText = messages
      .map((m) => {
        const role =
          m.type === "user"
            ? "User"
            : m.type === "assistant"
              ? "Assistant"
              : m.type === "tool_result"
                ? "ToolResult"
                : "System";
        const content =
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content);
        return `${role}: ${content.slice(0, 4000)}`;
      })
      .join("\n\n");

    const basePrompt = customPrompt ?? COMPACT_PROMPT;
    const prompt = `${basePrompt}\n\n<conversation>\n${conversationText}\n</conversation>`;

    let summaryText = "";
    for await (const event of this.client.submitMessage(prompt, { signal })) {
      if (event.type === "text_delta") {
        summaryText += event.delta;
      } else if (event.type === "error") {
        throw event.error;
      }
    }
    if (!summaryText.trim()) {
      throw new Error("Compaction interrupted before a complete summary was returned.");
    }
    return summaryText;
  }

  /**
   * 后处理原始摘要：去掉 <analysis> 草稿区；
   * 若有 <summary> 则改写成 `Summary:\n...` 形式；压缩多余空行。
   */
  private formatSummary(raw: string): string {
    let text = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
    const m = text.match(/<summary>([\s\S]*?)<\/summary>/);
    if (m) {
      text = text.replace(m[0], `Summary:\n${m[1]!.trim()}`);
    }
    return text.replace(/\n\n+/g, "\n\n").trim();
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
    const groups = this.groupByPromptRound(messages);
    if (groups.length < 2) return null;

    let dropCount = Math.max(1, Math.floor(groups.length / 5));
    dropCount = Math.min(dropCount, groups.length - 1);

    const retained = groups.slice(dropCount).flat();
    if (!retained.length) return null;

    if (retained[0]!.type === "assistant" || retained[0]!.type === "tool_result") {
      const marker: Message = { type: "user", content: PTL_RETRY_MARKER };
      return [marker, ...retained];
    }
    return retained;
  }

  /**
   * 按「有文本内容的 user 消息」开启新一轮，把消息序列切成若干 prompt round。
   * 用于 PTL 重试时按轮丢弃，而不是按单条消息乱切。
   */
  private groupByPromptRound(messages: Message[]): Message[][] {
    const groups: Message[][] = [];
    let current: Message[] = [];
    for (const msg of messages) {
      const startsNewRound =
        msg.type === "user" && contentToText(msg.content).trim().length > 0;
      if (startsNewRound && current.length) {
        groups.push(current);
        current = [];
      }
      current.push(msg);
    }
    if (current.length) groups.push(current);
    return groups;
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
  splitPreservingToolPairs(messages: Message[]): {
    older: Message[];
    recent: Message[];
  } {
    if (messages.length <= this.keepRecent) {
      return { older: [], recent: [...messages] };
    }
    let splitIndex = Math.max(0, messages.length - this.keepRecent);
    while (
      splitIndex > 0 &&
      historyBoundaryFallsInsideToolGroup(messages, splitIndex)
    ) {
      splitIndex--;
    }
    return {
      older: messages.slice(0, splitIndex),
      recent: messages.slice(splitIndex),
    };
  }

  // -------------------------------------------------------------------------
  // 图片处理
  // -------------------------------------------------------------------------

  /**
   * 把 user / tool_result 中的 image block 换成占位文本。
   * 摘要模型不需要真实像素，且图片极大，直接送去会立刻 PTL。
   */
  replaceImagesWithPlaceholders(messages: Message[]): Message[] {
    return messages.map((msg) => {
      if (msg.type === "user" && Array.isArray(msg.content)) {
        if (!msg.content.some(isImageBlock)) return msg;
        return {
          ...msg,
          content: msg.content.map((b) =>
            isImageBlock(b)
              ? { type: "text" as const, text: "[Image omitted from compaction summarization.]" }
              : b,
          ),
        } as Message;
      }
      if (msg.type === "tool_result") {
        if (!msg.content.some(isImageBlock)) return msg;
        return {
          ...msg,
          content: msg.content.map((b) =>
            isImageBlock(b)
              ? { type: "text" as const, text: "[Image omitted from compaction summarization.]" }
              : b,
          ),
        } as Message;
      }
      return msg;
    });
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
    const lines = [
      "[Compact boundary marker]",
      "Earlier conversation was compacted. Use the summary above and the messages below as the continuity boundary.",
      `Trigger: ${metadata.trigger}`,
      `Compaction kind: ${metadata.compactKind}`,
    ];
    if (metadata.preMessageCount !== undefined) {
      lines.push(
        `Pre-compact footprint: messages=${metadata.preMessageCount}` +
          (metadata.preTokenCount !== undefined
            ? `, tokens=${metadata.preTokenCount}`
            : ""),
      );
    }
    if (metadata.postMessageCount !== undefined) {
      lines.push(`Post-compact footprint: messages=${metadata.postMessageCount}`);
    }
    if (metadata.usedHeadTruncationRetry) {
      lines.push("Note: older context was head-truncated during a PTL retry.");
    }
    return { type: "user", content: lines.join("\n"), compactRole: "boundary" };
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
    let total = 0;
    for (const msg of messages) {
      if (msg.type === "assistant") {
        total += estimateTokens(msg.content);
        if (msg.reasoningReplay) total += estimateTokens(msg.reasoningReplay);
        if (msg.toolUses) {
          for (const tu of msg.toolUses) {
            total += estimateTokens(tu.name);
            total += estimateTokens(JSON.stringify(tu.input));
          }
        }
        continue;
      }
      if (typeof msg.content === "string") {
        total += estimateTokens(msg.content);
        continue;
      }
      for (const block of msg.content) {
        if (block.type === "text") {
          total += estimateTokens(block.text);
        } else if (block.type === "image") {
          const prepared = block.source.prepared;
          total += prepared
            ? Math.ceil(prepared.width / 28) * Math.ceil(prepared.height / 28)
            : this.imageTokenEstimate;
        }
      }
    }
    return Math.ceil(total * TOKEN_ESTIMATION_PADDING);
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

/** 类型再导出：消费者也可从本模块拿到 ToolUseBlock（主入口仍推荐 @openharness/core）。 */
export type { ToolUseBlock };
