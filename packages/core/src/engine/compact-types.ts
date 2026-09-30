import type { IHookExecutor, StreamEvent } from "../index";

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

