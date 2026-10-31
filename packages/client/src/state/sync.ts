/**
 * 唯一同步流程：单会话先取快照，全局先补历史；断流后退避重连。
 * 会话必须刷新快照成功后才重新开流，恢复未持久化的临时正文。
 */
import {
  applyEvent,
  applyEvents,
  applySessionSnapshot,
  createInitialClientState,
  UnsupportedSessionEventSchemaVersionError,
} from "./reducer.js";
import { applySessionStreamEvent, applySessionStreamSnapshot } from "./session-stream-state.js";
import { VykorApiError } from "../transport/http-transport.js";
import type {
  EventSyncOptions, ListEventsOptions, VykorClientState, SessionEventRecord,
  SessionStateSnapshot, SyncEventUpdate,
} from "../types/index.js";

export interface SyncEventsClient {
  sessions: {
    getState(sessionId: string, options?: { signal?: AbortSignal; partView?: "summary" }): Promise<SessionStateSnapshot>;
  };
  events: {
    list(options?: ListEventsOptions & { signal?: AbortSignal }): Promise<SessionEventRecord[]>;
    stream(options?: EventSyncOptions & { transportReconnect?: boolean }): AsyncIterable<SessionEventRecord>;
  };
}

type GlobalEventReducer = (state: VykorClientState, event: SessionEventRecord) => VykorClientState;
const DEFAULT_RECONNECT_DELAY_MS = (attempt: number): number =>
  Math.min(30_000, 250 * 2 ** Math.max(0, attempt));
/** 服务端 keepalive 每 15s 一次，迭代接口保留 4 倍余量。 */
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 60_000;
const EVENT_REPLAY_PAGE_SIZE = 128;

export function hydrateState(events: Iterable<SessionEventRecord>): VykorClientState {
  return applyEvents(createInitialClientState(), events);
}

/** 公开迭代接口保留原有默认空闲超时和全局 replay 结束标记。 */
export async function* syncEvents(
  client: SyncEventsClient,
  options: EventSyncOptions & { globalReducer?: GlobalEventReducer } = {},
): AsyncIterable<SyncEventUpdate> {
  yield* runEventSync(client, {
    ...options,
    // 会话迭代接口从完整快照开始；只有全局 replay 使用调用方游标。
    cursor: options.sessionId ? undefined : options.cursor,
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  });
}

/** @internal 共用算法。控制器只提供初始状态，消费更新并适配连接状态。 */
export async function* runEventSync(
  client: SyncEventsClient,
  options: EventSyncOptions & { globalReducer?: GlobalEventReducer },
  initialState: VykorClientState = createInitialClientState(),
  onLiveEvent?: () => void,
): AsyncIterable<SyncEventUpdate> {
  let state = initialState;
  let cursor = Math.max(0, options.cursor ?? 0, state.lastSeq);
  let attempt = 0;
  const signal = options.signal;
  const delayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const reduce = options.sessionId ? applySessionStreamEvent : options.globalReducer ?? applyEvent;
  if (signal?.aborted) return;

  const refreshSession = async (initial: boolean): Promise<void> => {
    const snapshot = await client.sessions.getState(options.sessionId!, {
      signal, partView: options.partView,
    });
    if (signal?.aborted) return;
    // 初次 attach 按会话判断缓存新旧，不能被其他会话的较大游标挡住。
    const next = initial ? applySessionSnapshot(state, snapshot) : applySessionStreamSnapshot(state, snapshot);
    state = Object.keys(next.eventsBySeq).length ? { ...next, eventsBySeq: {} } : next;
    cursor = Math.max(cursor, snapshot.cursor, state.lastSeq);
  };

  const replayHistory = async function* (initial: boolean): AsyncIterable<SyncEventUpdate> {
    let pageCursor = cursor;
    while (!signal?.aborted) {
      const page = await client.events.list({
        cursor: pageCursor, limit: EVENT_REPLAY_PAGE_SIZE, partView: options.partView, signal,
      });
      if (signal?.aborted) return;
      for (const event of page) {
        if (signal?.aborted) return;
        const before = state;
        state = reduce(state, event);
        // 每条成功应用后立即推进；后续应用失败不能回到整页起点。
        cursor = Math.max(cursor, event.seq, state.lastSeq);
        if (initial || state !== before) yield { event, state, source: "replay" };
      }
      const through = page.at(-1)?.seq ?? pageCursor;
      if (page.length < EVENT_REPLAY_PAGE_SIZE || through <= pageCursor) return;
      pageCursor = through;
    }
  };

  try {
    if (options.sessionId) {
      await refreshSession(true);
    } else {
      yield* replayHistory(true);
    }
    if (signal?.aborted) return;
    yield { state, source: "snapshot" };

    let needsSnapshot = false;
    while (!signal?.aborted) {
      try {
        if (needsSnapshot) {
          await refreshSession(false);
          if (signal?.aborted) return;
          needsSnapshot = false;
          yield { state, source: "snapshot" };
        }
        if (signal?.aborted) return;
        for await (const event of client.events.stream({
          cursor, sessionId: options.sessionId, signal, partView: options.partView,
          transportReconnect: false, idleTimeoutMs: options.idleTimeoutMs,
        })) {
          if (signal?.aborted) return;
          onLiveEvent?.();
          if (signal?.aborted) return;
          attempt = 0;
          if (event.seq > cursor + 1 && !options.sessionId) {
            yield* replayHistory(false);
          }
          if (signal?.aborted) return;
          const before = state;
          state = reduce(state, event);
          cursor = Math.max(cursor, event.seq, state.lastSeq);
          if (state !== before) yield { event, state, source: "live" };
        }
      } catch (error) {
        if (error instanceof UnsupportedSessionEventSchemaVersionError) throw error;
        if (isAbortError(error) || signal?.aborted) return;
        // 请求无效、失去权限或会话已删除时，重连无法恢复；超时、过早请求和限流仍可重试。
        if (error instanceof VykorApiError && error.status >= 400 && error.status < 500
          && ![408, 425, 429].includes(error.status)) throw error;
      }
      if (signal?.aborted) return;
      // 刷新失败也走同一退避入口；needsSnapshot 保持为真，绝不跳过快照恢复。
      needsSnapshot = Boolean(options.sessionId);
      yield { state, source: "reconnecting" };
      if (!(await waitForReconnect(delayMs(attempt), signal))) return;
      attempt += 1;
    }
  } catch (error) {
    if (!isAbortError(error) && !signal?.aborted) throw error;
  }
}

async function waitForReconnect(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (ms <= 0) return true;
  return new Promise<boolean>(resolve => {
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(!signal?.aborted);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}
