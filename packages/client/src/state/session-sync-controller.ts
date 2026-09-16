/**
 * 无 UI 框架依赖的 Session 同步控制器。
 *
 * 封装 snapshot-first attach、cursor 维护、gap catch-up、SSE 重连、abort 与 generation fencing。
 * 平台层（Frontend Hook、Desktop Main Subscription Service）直接使用此控制器，
 * 避免重复编写 stream pump、重连定时器、generation 丢弃等逻辑。
 */

import {
  applyEvent,
  applySessionSnapshot,
  createInitialClientState,
  UnsupportedSessionEventSchemaVersionError,
} from "./reducer.js";
import type { SyncEventsClient } from "./sync.js";
import type {
  OpenHarnessClientState,
  SyncEventUpdate,
} from "../types/index.js";

export type SyncConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export interface SessionSyncControllerOptions {
  client: SyncEventsClient;
  sessionId?: string;
  cursor?: number;
  generation?: number;
  signal?: AbortSignal;
  reconnectDelayMs?: (attempt: number) => number;
  onUpdate?: (update: SyncEventUpdate, generation: number) => void;
  onStatusChange?: (status: SyncConnectionStatus, generation: number) => void;
  onError?: (error: unknown, generation: number) => void;
}

const DEFAULT_RECONNECT_DELAY_MS = (attempt: number): number =>
  Math.min(30_000, 250 * 2 ** Math.max(0, attempt));

export class SessionSyncController {
  private readonly client: SyncEventsClient;
  private readonly sessionId?: string;
  private readonly generation: number;
  private readonly externalSignal?: AbortSignal;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private readonly onUpdate?: (update: SyncEventUpdate, generation: number) => void;
  private readonly onStatusChange?: (status: SyncConnectionStatus, generation: number) => void;
  private readonly onError?: (error: unknown, generation: number) => void;

  private readonly abortController = new AbortController();
  private state: OpenHarnessClientState = createInitialClientState();
  private status: SyncConnectionStatus = "idle";
  private running = false;

  constructor(options: SessionSyncControllerOptions) {
    this.client = options.client;
    this.sessionId = options.sessionId;
    this.generation = options.generation ?? 0;
    this.externalSignal = options.signal;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.onUpdate = options.onUpdate;
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;

    if (this.externalSignal) {
      if (this.externalSignal.aborted) {
        this.abortController.abort(this.externalSignal.reason);
      } else {
        this.externalSignal.addEventListener(
          "abort",
          () => this.abortController.abort(this.externalSignal?.reason),
          { once: true },
        );
      }
    }
  }

  get currentStatus(): SyncConnectionStatus {
    return this.status;
  }

  get currentState(): OpenHarnessClientState {
    return this.state;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  abort(reason?: unknown): void {
    this.abortController.abort(reason);
  }

  private setStatus(status: SyncConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatusChange?.(status, this.generation);
  }

  private emitUpdate(update: SyncEventUpdate): void {
    if (this.abortController.signal.aborted) return;
    this.state = update.state;
    this.onUpdate?.(update, this.generation);
  }

  /**
   * 启动同步循环。
   * 返回一个当同步正常结束（如 abort）或抛出不可恢复错误时 resolve/reject 的 Promise。
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const signal = this.abortController.signal;
    if (signal.aborted) {
      this.setStatus("idle");
      return;
    }

    let cursor = 0;
    let attempt = 0;

    try {
      this.setStatus("connecting");

      if (this.sessionId) {
        const snapshot = await this.client.sessions.getState(this.sessionId, { signal });
        if (signal.aborted) return;
        this.state = applySessionSnapshot(this.state, snapshot);
        cursor = snapshot.cursor;
        this.setStatus("connected");
        this.emitUpdate({ state: this.state, source: "snapshot" });
      } else {
        const replay = await this.client.events.list({
          sessionId: this.sessionId,
          signal,
        });
        if (signal.aborted) return;
        for (const event of replay) {
          this.state = applyEvent(this.state, event);
          this.emitUpdate({ event, state: this.state, source: "replay" });
        }
        cursor = this.state.lastSeq;
        this.setStatus("connected");
      }

      while (!signal.aborted) {
        try {
          for await (const event of this.client.events.stream({
            cursor,
            sessionId: this.sessionId,
            signal,
            transportReconnect: false,
          })) {
            if (signal.aborted) return;
            attempt = 0;
            this.setStatus("connected");

            if (event.seq > this.state.lastSeq + 1) {
              const gap = await this.client.events.list({
                cursor: this.state.lastSeq,
                sessionId: this.sessionId,
                signal,
              });
              if (signal.aborted) return;
              for (const missed of gap) {
                const beforeGap = this.state;
                this.state = applyEvent(this.state, missed);
                if (this.state !== beforeGap) {
                  this.emitUpdate({ event: missed, state: this.state, source: "replay" });
                }
              }
              cursor = this.state.lastSeq;
            }

            const before = this.state;
            this.state = applyEvent(this.state, event);
            cursor = this.state.lastSeq;
            if (this.state !== before) {
              this.emitUpdate({ event, state: this.state, source: "live" });
            }
          }

          if (signal.aborted) return;
          this.setStatus("reconnecting");
          this.emitUpdate({ state: this.state, source: "reconnecting" });
          const delay = this.reconnectDelayMs(attempt);
          attempt += 1;
          cursor = this.state.lastSeq;
          if (!(await this.waitForDelay(delay, signal))) return;
        } catch (error) {
          if (error instanceof UnsupportedSessionEventSchemaVersionError) {
            this.setStatus("error");
            this.onError?.(error, this.generation);
            throw error;
          }
          if (this.isAbortError(error) || signal.aborted) return;
          this.setStatus("reconnecting");
          this.emitUpdate({ state: this.state, source: "reconnecting" });
          const delay = this.reconnectDelayMs(attempt);
          attempt += 1;
          cursor = this.state.lastSeq;
          if (!(await this.waitForDelay(delay, signal))) return;
        }
      }
    } catch (error) {
      if (!this.isAbortError(error) && !signal.aborted) {
        this.setStatus("error");
        this.onError?.(error, this.generation);
      }
    } finally {
      this.running = false;
      if (signal.aborted && this.status !== "error") {
        this.setStatus("idle");
      }
    }
  }

  private isAbortError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    if ("name" in error && (error as { name?: string }).name === "AbortError") return true;
    return false;
  }

  private waitForDelay(ms: number, signal: AbortSignal): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(!signal.aborted);
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(!signal.aborted);
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
