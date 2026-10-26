/**
 * 无 UI 依赖的回调适配器。同步规则统一由 sync.ts 执行；这里保存当前状态，
 * 转发连接状态和代次，并隔离取消后迟到的更新。
 */
import { createInitialClientState } from "./reducer.js";
import { runEventSync, type SyncEventsClient } from "./sync.js";
import type { VykorClientState, SyncEventUpdate } from "../types/index.js";

export type SyncConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export interface SessionSyncControllerOptions {
  client: SyncEventsClient;
  sessionId?: string;
  initialState?: VykorClientState;
  cursor?: number;
  generation?: number;
  signal?: AbortSignal;
  reconnectDelayMs?: (attempt: number) => number;
  onUpdate?: (update: SyncEventUpdate, generation: number) => void;
  onStatusChange?: (status: SyncConnectionStatus, generation: number) => void;
  onError?: (error: unknown, generation: number) => void;
}

export class SessionSyncController {
  private readonly options: SessionSyncControllerOptions;
  private readonly initialCursor: number;
  private readonly generation: number;
  private readonly abortController = new AbortController();
  private state: VykorClientState;
  private status: SyncConnectionStatus = "idle";
  private running = false;

  constructor(options: SessionSyncControllerOptions) {
    this.options = { ...options };
    this.state = options.initialState ?? createInitialClientState();
    if ((options.cursor ?? 0) > 0 && !options.initialState) {
      throw new Error("A non-zero cursor requires initialState so durable state is not skipped");
    }
    this.initialCursor = Math.max(0, options.cursor ?? 0, this.state.lastSeq);
    this.generation = options.generation ?? 0;
    if (options.signal?.aborted) {
      this.abortController.abort(options.signal.reason);
    } else {
      options.signal?.addEventListener("abort", () => this.abort(options.signal?.reason), { once: true });
    }
  }

  get currentStatus(): SyncConnectionStatus { return this.status; }
  get currentState(): VykorClientState { return this.state; }
  get currentGeneration(): number { return this.generation; }
  get signal(): AbortSignal { return this.abortController.signal; }

  abort(reason?: unknown): void { this.abortController.abort(reason); }

  private setStatus(status: SyncConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status, this.generation);
  }

  /** 不可恢复错误通过 onError 上报；取消和正常结束都 resolve。 */
  async start(): Promise<void> {
    if (this.running) return;
    const signal = this.signal;
    if (signal.aborted) { this.setStatus("idle"); return; }
    this.running = true;
    try {
      this.setStatus("connecting");
      // 回调接口保持传输层原有的空闲超时默认值，不套用迭代接口的 60s。
      for await (const update of runEventSync(this.options.client, {
        sessionId: this.options.sessionId,
        cursor: this.initialCursor,
        signal,
        reconnectDelayMs: this.options.reconnectDelayMs,
      }, this.state, () => this.setStatus("connected"))) {
        if (signal.aborted) return;
        this.state = update.state;
        if (update.source === "reconnecting") this.setStatus("reconnecting");
        else if (update.source !== "replay") this.setStatus("connected");
        if (signal.aborted) return;
        // 全局 snapshot 在共用流程中标记 replay 结束，回调接口不新增这条更新。
        if (update.source === "snapshot" && !this.options.sessionId) continue;
        this.options.onUpdate?.(update, this.generation);
      }
    } catch (error) {
      if (!signal.aborted && !(error instanceof Error && error.name === "AbortError")) {
        this.setStatus("error");
        this.options.onError?.(error, this.generation);
      }
    } finally {
      this.running = false;
      if (signal.aborted && this.status !== "error") this.setStatus("idle");
    }
  }
}
