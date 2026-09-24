import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ToolResult } from "@vykor/core";
import type { LoadedNativePlugin } from "@vykor/plugins";
import type {
  NativeToolCallContext,
  NativeToolHostLog,
  NativeToolHostResponse,
  NativeToolRegistration,
  RegisterToolsPayload,
} from "./protocol.js";

export type NativeToolHostState = "inactive" | "starting" | "active" | "degraded" | "error";

export class NativeToolHostError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeToolHostError";
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  cancellationTimer?: NodeJS.Timeout;
  callerSettled?: boolean;
  removeAbortListener?: () => void;
}

export interface NativeToolHostOptions {
  registrationTimeoutMs?: number;
  callTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  cancellationGraceMs?: number;
  outputMaxBytes?: number;
  logMessageMaxChars?: number;
  onLog?: (event: NativeToolHostLog) => void;
  onCrash?: (error: NativeToolHostError) => void;
}

export class NativeToolHost {
  private child: ChildProcess | undefined;
  private pending = new Map<string, PendingRequest>();
  private stopping = false;
  private outputBytes = { stdout: 0, stderr: 0, ipc: 0 };
  private outputLimitNotified = new Set<"stdout" | "stderr" | "ipc">();
  state: NativeToolHostState = "inactive";

  constructor(
    readonly plugin: LoadedNativePlugin,
    private readonly options: NativeToolHostOptions = {},
  ) {}

  async start(): Promise<NativeToolRegistration[]> {
    if (this.child) throw new NativeToolHostError("tool_protocol_error", "Native Tool Host is already started");
    const entries = this.plugin.components.tools?.value ?? [];
    if (entries.length === 0) return [];
    this.state = "starting";
    const hostEntry = new URL("./host-entry.mjs", import.meta.url);
    const inheritedEnv = ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG"]
      .reduce<NodeJS.ProcessEnv>((result, key) => {
        if (process.env[key] !== undefined) result[key] = process.env[key];
        return result;
      }, {});
    const child = fork(hostEntry, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "advanced",
      // Do not leak daemon API keys or other ambient secrets into third-party code.
      env: buildNativeToolHostEnvironment(inheritedEnv, process.versions.electron),
    });
    this.child = child;
    child.on("message", (message) => this.handleMessage(message));
    child.on("error", (error) => this.handleCrash(new NativeToolHostError("tool_host_spawn_failed", error.message, { cause: error })));
    child.on("exit", (code, signal) => {
      if (!this.stopping) this.handleCrash(new NativeToolHostError("tool_host_crashed", `Native Tool Host exited (code=${code ?? "none"}, signal=${signal ?? "none"})`));
    });
    child.stderr?.on("data", (chunk) => this.emitLimitedOutput("stderr", "error", chunk));
    child.stdout?.on("data", (chunk) => this.emitLimitedOutput("stdout", "info", chunk));

    try {
      await this.request("healthcheck", undefined, this.options.registrationTimeoutMs ?? 10_000);
      const payload: RegisterToolsPayload = {
        plugin: {
          id: this.plugin.manifest.id,
          name: this.plugin.manifest.name,
          version: this.plugin.manifest.version,
          root: this.plugin.root,
        },
        entries: entries.map((entry) => ({ entryPath: entry.entryPath, permissions: entry.effectivePermissions })),
      };
      const registrations = await this.request("registerTools", payload, this.options.registrationTimeoutMs ?? 10_000);
      if (!Array.isArray(registrations)) throw new NativeToolHostError("tool_protocol_error", "Tool Host returned an invalid registration result");
      this.state = "active";
      return registrations as NativeToolRegistration[];
    } catch (error) {
      this.state = "error";
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async call(
    name: string,
    input: Record<string, unknown>,
    context: Omit<NativeToolCallContext, "deadline">,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (this.state !== "active") throw new NativeToolHostError("tool_host_unavailable", `Native Tool Host is ${this.state}`);
    const timeoutMs = this.options.callTimeoutMs ?? 60_000;
    return await this.request("callTool", {
      name,
      input,
      context: { ...context, deadline: Date.now() + timeoutMs },
    }, timeoutMs, signal) as ToolResult;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) { this.state = "inactive"; return; }
    this.stopping = true;
    try {
      if (child.connected) await this.request("shutdown", undefined, this.options.shutdownTimeoutMs ?? 2_000);
    } catch {
      // The forced kill below is the final lifecycle boundary.
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      this.rejectPending(new NativeToolHostError("tool_host_stopped", "Native Tool Host stopped"));
      this.child = undefined;
      this.state = "inactive";
    }
  }

  stopSync(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = undefined;
    this.state = "inactive";
  }

  private request(method: "healthcheck" | "registerTools" | "callTool" | "shutdown", payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new NativeToolHostError("tool_host_unavailable", "Native Tool Host IPC is unavailable"));
    if (signal?.aborted) return Promise.reject(new NativeToolHostError("tool_call_cancelled", "Native Tool call was cancelled"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const error = new NativeToolHostError(
            method === "callTool" ? "tool_call_timeout" : "tool_protocol_timeout",
            `${method} timed out after ${timeoutMs} ms`,
          );
          if (method === "callTool") {
            this.cancelPendingCall(id, pending, child, error);
          } else {
            this.finishPending(id, undefined, error);
          }
        }, timeoutMs),
      };
      if (signal) {
        const onAbort = () => {
          this.cancelPendingCall(
            id,
            pending,
            child,
            new NativeToolHostError("tool_call_cancelled", "Native Tool call was cancelled"),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, pending);
      child.send({ type: "request", id, method, payload }, (error) => {
        if (!error) return;
        this.finishPending(id, undefined, new NativeToolHostError("tool_protocol_error", error.message, { cause: error }));
      });
    });
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    if ((message as NativeToolHostLog).type === "log") {
      const event = message as NativeToolHostLog;
      this.emitLimitedOutput("ipc", event.level, event.message);
      return;
    }
    const response = message as NativeToolHostResponse;
    if (response.type !== "response" || typeof response.id !== "string") return;
    const error = response.error
      ? new NativeToolHostError(response.error.code, response.error.message)
      : undefined;
    this.finishPending(response.id, response.result, error);
  }

  private emitLimitedOutput(source: "stdout" | "stderr" | "ipc", level: NativeToolHostLog["level"], chunk: unknown): void {
    const raw = String(chunk).trimEnd();
    if (!raw) return;
    const maxBytes = this.options.outputMaxBytes ?? 64 * 1024;
    const currentBytes = this.outputBytes[source];
    if (currentBytes >= maxBytes) {
      this.notifyOutputLimit(source, maxBytes);
      return;
    }
    const rawBytes = Buffer.byteLength(raw, "utf8");
    const remainingBytes = maxBytes - currentBytes;
    const message = rawBytes > remainingBytes
      ? `${truncateUtf8(raw, remainingBytes)}\n[truncated: native tool ${source} output exceeded ${maxBytes} bytes]`
      : raw;
    this.outputBytes[source] += Math.min(rawBytes, remainingBytes);
    this.options.onLog?.({
      type: "log",
      level,
      message: truncateChars(message, this.options.logMessageMaxChars ?? 8 * 1024),
    });
    if (rawBytes > remainingBytes) this.notifyOutputLimit(source, maxBytes);
  }

  private notifyOutputLimit(source: "stdout" | "stderr" | "ipc", maxBytes: number): void {
    if (this.outputLimitNotified.has(source)) return;
    this.outputLimitNotified.add(source);
    this.options.onLog?.({
      type: "log",
      level: "warn",
      message: `Native Tool Host ${source} output limit reached (${maxBytes} bytes); further ${source} output is suppressed.`,
    });
  }

  private finishPending(id: string, value: unknown, error?: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.cancellationTimer) clearTimeout(pending.cancellationTimer);
    pending.removeAbortListener?.();
    if (pending.callerSettled) return;
    pending.callerSettled = true;
    if (error) pending.reject(error); else pending.resolve(value);
  }

  private cancelPendingCall(
    id: string,
    pending: PendingRequest,
    child: ChildProcess,
    error: NativeToolHostError,
  ): void {
    if (pending.callerSettled) return;
    pending.callerSettled = true;
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    pending.reject(error);
    try {
      if (child.connected) child.send({ type: "cancel", id });
    } catch {
      // The grace timer below is the authoritative containment boundary.
    }
    pending.cancellationTimer = setTimeout(() => {
      if (this.pending.get(id) !== pending || this.child !== child) return;
      this.pending.delete(id);
      child.kill();
      this.handleCrash(new NativeToolHostError(
        "tool_host_unresponsive",
        `Native Tool Host did not stop call ${id} within the cancellation grace period`,
        { cause: error },
      ));
    }, this.options.cancellationGraceMs ?? 250);
  }

  private handleCrash(error: NativeToolHostError): void {
    if (this.state === "error" && !this.child) return;
    this.state = "error";
    this.rejectPending(error);
    this.child = undefined;
    this.options.onCrash?.(error);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (pending.cancellationTimer) clearTimeout(pending.cancellationTimer);
      pending.removeAbortListener?.();
      if (!pending.callerSettled) {
        pending.callerSettled = true;
        pending.reject(error);
      }
    }
  }
}

export function buildNativeToolHostEnvironment(
  inheritedEnv: NodeJS.ProcessEnv,
  electronVersion?: string,
): NodeJS.ProcessEnv {
  return {
    ...inheritedEnv,
    VYKOR_NATIVE_TOOL_HOST: "1",
    ...(electronVersion ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
}

function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars))}\n[truncated: native tool log message exceeded ${maxChars} characters]`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let result = "";
  let used = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    result += char;
    used += size;
  }
  return result;
}
