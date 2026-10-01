import type { AdmitPromptInput, PermissionRequestRecord, SessionEventRecord, SessionExecutionRecord, SessionInputRecord, SessionMessagePartRecord, SessionMessageRecord, SessionRecord, SessionRunAttemptRecord, SessionRunRecord } from "@vykor/protocol";

/**
 * 单个 session 在客户端的聚合视图。
 * 由事件 reducer 从 event log 归并得出，不是服务端直接返回的结构。
 */
export interface SessionBucket {
  session?: SessionRecord;
  inputs: SessionInputRecord[];
  messages: SessionMessageRecord[];
  partsByMessageId: Record<string, SessionMessagePartRecord[]>;
  runs: Record<string, SessionRunRecord>;
  attempts: Record<string, SessionRunAttemptRecord>;
  tasks: Record<string, SessionExecutionRecord>;
  permissions: Record<string, PermissionRequestRecord>;
}

/**
 * 客户端权威状态：由 snapshot/live（或全局 replay/live）经 reducer 收敛。
 * 多端 attach 同一 daemon 时，应得到一致的状态形状。
 */
export interface VykorClientState {
  sessions: Record<string, SessionRecord>;
  /** 按 `updatedAt` 降序的 session id 列表。 */
  sessionOrder: string[];
  buckets: Record<string, SessionBucket>;
  /** Durable replay events indexed by seq; live text deltas are not retained. */
  eventsBySeq: Record<number, SessionEventRecord>;
  /** Latest atomic snapshot cursor for each session; older delayed SSE events are ignored. */
  snapshotCursorBySession: Record<string, number>;
  /** Highest ordered transient event seq already applied; prevents SSE reconnect replay. */
  transientCursor: number;
  /** 当前已应用到的最大事件序号，用作 SSE cursor。 */
  lastSeq: number;
}

/** `syncEvents` / `streamEvents` 的过滤与取消选项。 */
export interface EventSyncOptions {
  sessionId?: string;
  cursor?: number;
  signal?: AbortSignal;
  /**
   * Delay before a live-stream reconnect attempt (attempt is 0-based).
   * Defaults to exponential backoff capped at 30s. Tests may pass `() => 0`.
   */
  reconnectDelayMs?: (attempt: number) => number;
  /** 会话事件流空闲超时（毫秒）；默认由 sync 层填 60s。 */
  idleTimeoutMs?: number;
}

/** `syncEvents` 产出的单次状态更新。 */
export interface SyncEventUpdate {
  event?: SessionEventRecord;
  state: VykorClientState;
  /** Session attach starts from an atomic snapshot, then consumes SSE deltas. */
  source: "snapshot" | "replay" | "live" | "reconnecting";
}

/** 去掉 sessionId 后的 admit prompt 输入（sessionId 由路径提供）。 */
export type PromptInputForClient = Omit<AdmitPromptInput, "sessionId">;
