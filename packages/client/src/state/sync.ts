/**
 * 客户端事件同步：session 使用原子 HTTP snapshot + SSE live；
 * 无 sessionId 的全局视图使用 HTTP replay + SSE live。
 *
 * UI（如 `useServerSync`）通常消费 `syncEvents`，而不是分别调 listEvents / streamEvents。
 * live SSE 非 abort 断流后指数退避重连；session 路径重连时重新取快照（`source: "snapshot"`），
 * 全局路径按 `state.lastSeq` 续传并补 replay 空洞。
 */

import {
  applyEvent,
  applyEvents,
  applySessionSnapshot,
  createInitialClientState,
  UnsupportedSessionEventSchemaVersionError,
} from "./reducer.js";
import type {
  EventSyncOptions,
  ListEventsOptions,
  VykorClientState,
  SessionEventRecord,
  SessionStateSnapshot,
  SyncEventUpdate,
} from "../types/index.js";

export interface SyncEventsClient {
  sessions: {
    getState(sessionId: string, options?: { signal?: AbortSignal }): Promise<SessionStateSnapshot>;
  };
  events: {
    list(options?: ListEventsOptions & { signal?: AbortSignal }): Promise<SessionEventRecord[]>;
    stream(options?: EventSyncOptions & { transportReconnect?: boolean }): AsyncIterable<SessionEventRecord>;
  };
}

type GlobalEventReducer = (
  state: VykorClientState,
  event: SessionEventRecord,
) => VykorClientState;

const DEFAULT_RECONNECT_DELAY_MS = (attempt: number): number =>
  Math.min(30_000, 250 * 2 ** Math.max(0, attempt));

/** 会话事件流空闲超时：服务端 keepalive 每 15s 一次，取 4 倍余量。 */
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 60_000;

/** 用已有事件列表一次性 hydrate 出客户端状态（离线/测试常用）。 */
export function hydrateState(events: Iterable<SessionEventRecord>): VykorClientState {
  return applyEvents(createInitialClientState(), events);
}

/**
 * session attach 主路径：`getSessionState` snapshot → `streamEvents` live。
 * 每应用一条（或 live 下状态确有变化的）事件就 yield `{ event, state, source }`。
 * live 阶段若 `applyEvent` 因重复 seq 返回同一引用，则跳过 yield。
 */
export async function* syncEvents(
  client: SyncEventsClient,
  options: EventSyncOptions & { globalReducer?: GlobalEventReducer } = {},
): AsyncIterable<SyncEventUpdate> {
  let state = createInitialClientState();
  if (options.sessionId) {
    const sessionId = options.sessionId;
    const snapshot = await client.sessions.getState(sessionId, { signal: options.signal });
    state = applySessionSnapshot(state, snapshot);
    yield { state, source: "snapshot" };

    yield* liveWithReconnect(client, state, options, snapshot.cursor, async (current) => {
      const refreshed = await client.sessions.getState(sessionId, { signal: options.signal });
      const next = applySessionSnapshot(current, refreshed);
      return { state: next, cursor: refreshed.cursor };
    });
    return;
  }
  const replay = await client.events.list({
    cursor: options.cursor,
    sessionId: options.sessionId,
    signal: options.signal,
  });
  const reduce = options.globalReducer ?? applyEvent;

  for (const event of replay) {
    state = reduce(state, event);
    yield { event, state, source: "replay" };
  }

  // Global consumers need an explicit boundary between initial history and live updates.
  yield { state, source: "snapshot" };

  yield* liveWithReconnect(client, state, options, state.lastSeq, undefined, reduce);
}

async function* liveWithReconnect(
  client: SyncEventsClient,
  initialState: VykorClientState,
  options: EventSyncOptions,
  initialCursor: number,
  resync?: (
    current: VykorClientState,
  ) => Promise<{ state: VykorClientState; cursor: number }>,
  reduce: GlobalEventReducer = applyEvent,
): AsyncIterable<SyncEventUpdate> {
  let state = initialState;
  let cursor = initialCursor;
  let attempt = 0;
  const delayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  const applyResync = async (): Promise<"resynced" | "resumed" | "aborted"> => {
    if (!resync) {
      cursor = state.lastSeq;
      return "resumed";
    }
    try {
      const refreshed = await resync(state);
      state = refreshed.state;
      cursor = Math.max(refreshed.cursor, state.lastSeq);
      return "resynced";
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) return "aborted";
      cursor = state.lastSeq;
      return "resumed";
    }
  };

  while (!options.signal?.aborted) {
    try {
      for await (const event of client.events.stream({
        cursor,
        sessionId: options.sessionId,
        signal: options.signal,
        transportReconnect: false,
        idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS,
      })) {
        attempt = 0;
        if (event.seq > state.lastSeq + 1 && !options.sessionId) {
          const gap = await client.events.list({
            cursor: state.lastSeq,
            signal: options.signal,
          });
          for (const missed of gap) {
            const beforeGap = state;
            state = reduce(state, missed);
            if (state !== beforeGap) yield { event: missed, state, source: "replay" };
          }
          cursor = state.lastSeq;
        }

        const before = state;
        state = reduce(state, event);
        cursor = state.lastSeq;
        if (state !== before) yield { event, state, source: "live" };
      }

      // Clean stream end is treated as a disconnect that should resume.
      if (options.signal?.aborted) return;
      yield { state, source: "reconnecting" };
      if (!(await waitForReconnect(delayMs(attempt), options.signal))) return;
      attempt += 1;
      const outcome = await applyResync();
      if (outcome === "aborted") return;
      if (outcome === "resynced") yield { state, source: "snapshot" };
    } catch (error) {
      if (error instanceof UnsupportedSessionEventSchemaVersionError) throw error;
      if (isAbortError(error) || options.signal?.aborted) return;
      yield { state, source: "reconnecting" };
      if (!(await waitForReconnect(delayMs(attempt), options.signal))) return;
      attempt += 1;
      const outcome = await applyResync();
      if (outcome === "aborted") return;
      if (outcome === "resynced") yield { state, source: "snapshot" };
    }
  }
}

async function waitForReconnect(ms: number, signal?: AbortSignal): Promise<boolean> {
  try {
    await sleep(ms, signal);
    return !signal?.aborted;
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) return false;
    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("name" in error && (error as { name?: string }).name === "AbortError") return true;
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("Aborted", "AbortError");
}
