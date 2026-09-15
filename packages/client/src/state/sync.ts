/**
 * 客户端事件同步：session 使用原子 HTTP snapshot + SSE live；
 * 无 sessionId 的全局视图使用 HTTP replay + SSE live。
 *
 * UI（如 `useServerSync`）通常消费 `syncEvents`，而不是分别调 listEvents / streamEvents。
 * live SSE 非 abort 断流后按 `state.lastSeq` 指数退避重连；session 路径遇 seq 空洞会 re-snapshot。
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
  OpenHarnessClientState,
  SessionEventRecord,
  SessionStateSnapshot,
  SyncEventUpdate,
} from "../types/index.js";

export interface SyncEventsClient {
  getSessionState(
    sessionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SessionStateSnapshot>;
  listEvents(
    options?: ListEventsOptions & { signal?: AbortSignal },
  ): Promise<SessionEventRecord[]>;
  streamEvents(
    options?: EventSyncOptions,
  ): AsyncIterable<SessionEventRecord>;
}

const DEFAULT_RECONNECT_DELAY_MS = (attempt: number): number =>
  Math.min(30_000, 250 * 2 ** Math.max(0, attempt));

/** 用已有事件列表一次性 hydrate 出客户端状态（离线/测试常用）。 */
export function hydrateState(events: Iterable<SessionEventRecord>): OpenHarnessClientState {
  return applyEvents(createInitialClientState(), events);
}

/**
 * session attach 主路径：`getSessionState` snapshot → `streamEvents` live。
 * 每应用一条（或 live 下状态确有变化的）事件就 yield `{ event, state, source }`。
 * live 阶段若 `applyEvent` 因重复 seq 返回同一引用，则跳过 yield。
 */
export async function* syncEvents(
  client: SyncEventsClient,
  options: EventSyncOptions = {},
): AsyncIterable<SyncEventUpdate> {
  let state = createInitialClientState();
  if (options.sessionId) {
    const snapshot = await client.getSessionState(options.sessionId, { signal: options.signal });
    state = applySessionSnapshot(state, snapshot);
    yield { state, source: "snapshot" };

    yield* liveWithReconnect(client, state, options, snapshot.cursor);
    return;
  }
  const replay = await client.listEvents({
    cursor: options.cursor,
    sessionId: options.sessionId,
    signal: options.signal,
  });

  for (const event of replay) {
    state = applyEvent(state, event);
    yield { event, state, source: "replay" };
  }

  yield* liveWithReconnect(client, state, options, state.lastSeq);
}

async function* liveWithReconnect(
  client: SyncEventsClient,
  initialState: OpenHarnessClientState,
  options: EventSyncOptions,
  initialCursor: number,
): AsyncIterable<SyncEventUpdate> {
  let state = initialState;
  let cursor = initialCursor;
  let attempt = 0;
  const delayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  while (!options.signal?.aborted) {
    try {
      for await (const event of client.streamEvents({
        cursor,
        sessionId: options.sessionId,
        signal: options.signal,
      })) {
        attempt = 0;
        if (event.seq > state.lastSeq + 1 && !options.sessionId) {
          const gap = await client.listEvents({
            cursor: state.lastSeq,
            signal: options.signal,
          });
          for (const missed of gap) {
            const beforeGap = state;
            state = applyEvent(state, missed);
            if (state !== beforeGap) yield { event: missed, state, source: "replay" };
          }
          cursor = state.lastSeq;
        }

        const before = state;
        state = applyEvent(state, event);
        cursor = state.lastSeq;
        if (state !== before) yield { event, state, source: "live" };
      }

      // Clean stream end is treated as a disconnect that should resume.
      if (options.signal?.aborted) return;
      yield { state, source: "reconnecting" };
      if (!(await waitForReconnect(delayMs(attempt), options.signal))) return;
      attempt += 1;
      cursor = state.lastSeq;
    } catch (error) {
      if (error instanceof UnsupportedSessionEventSchemaVersionError) throw error;
      if (isAbortError(error) || options.signal?.aborted) return;
      yield { state, source: "reconnecting" };
      if (!(await waitForReconnect(delayMs(attempt), options.signal))) return;
      attempt += 1;
      cursor = state.lastSeq;
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
