import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import type { EnvironmentPtyTarget } from "@vykor/environment";
import type {
  TerminalCreateRequest,
  TerminalProvider,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalSignalRequest,
  TerminalWaitRequest,
  TerminalWaitResult,
  TerminalWriteRequest,
} from "@vykor/terminal";
import {
  TerminalEventBus,
  type TerminalEventListener,
} from "@vykor/terminal";
import type { IPty } from "node-pty";

import { OutputBuffer } from "./output-buffer";
import { createTerminalEnv, resolveDefaultShell } from "./shell";
import { TerminalOutputStore } from "./terminal-output-store";
import { createHostTerminalTarget } from "./environment-terminal-target.js";

export interface LocalTerminalProviderOptions {
  resolveCwd: (input: TerminalCreateRequest) => Promise<string>;
  resolveSessionInfo?: (
    input: TerminalCreateRequest,
  ) => Pick<TerminalSessionInfo, "projectId" | "sessionId">;
  resolveTarget?: (
    input: TerminalCreateRequest,
    resolvedCwd: string,
    terminalId: string,
  ) => Promise<EnvironmentPtyTarget>;
  spawnPty?: (
    command: string,
    args: string[],
    options: Parameters<(typeof import("node-pty"))["spawn"]>[2],
  ) => IPty;
}

interface PtyTerminalSession {
  info: TerminalSessionInfo;
  pty: IPty | null;
  target: EnvironmentPtyTarget;
  targetClosed: boolean;
  output: OutputBuffer;
  transcript: TerminalOutputStore;
  cancelRequested: boolean;
}

export class LocalTerminalProvider implements TerminalProvider {
  private readonly sessions = new Map<string, PtyTerminalSession>();
  private readonly events = new TerminalEventBus();

  constructor(private readonly options: LocalTerminalProviderOptions) {}

  async create(input: TerminalCreateRequest): Promise<TerminalSessionInfo> {
    const id = randomUUID();
    const resolvedCwd = await this.options.resolveCwd(input);
    const resolvedInfo = this.options.resolveSessionInfo?.(input) ?? (
      input.scope.kind === "project"
        ? { projectId: input.scope.projectId }
        : { sessionId: input.scope.sessionId }
    );
    const scopeInfo = {
      ...(resolvedInfo.projectId ? { projectId: resolvedInfo.projectId } : {}),
      ...(resolvedInfo.sessionId ? { sessionId: resolvedInfo.sessionId } : {}),
    };
    const target = input.runtime === "environment"
      ? await this.requireEnvironmentTarget(input, resolvedCwd, id)
      : createHostTerminalTarget({
          cwd: resolvedCwd,
          shell: input.shell?.trim() || resolveDefaultShell().command,
        });
    try {
      await requireDirectory(target.hostCwd);
      return await this.createPtyTerminal(id, input, target, scopeInfo);
    } catch (error) {
      // The environment target owns the runtime lease. A failed create is not
      // registered in sessions, so this is the only place that can release it.
      await target.close().catch(() => undefined);
      throw error;
    }
  }

  private async createPtyTerminal(
    id: string,
    input: TerminalCreateRequest,
    target: EnvironmentPtyTarget,
    scopeInfo: Pick<TerminalSessionInfo, "projectId" | "sessionId">,
  ): Promise<TerminalSessionInfo> {
    const spawnPty = this.options.spawnPty ?? (await import("node-pty")).spawn;
    const pty = spawnPty(target.command, target.args, {
      cwd: target.hostCwd,
      cols: clampDimension(input.cols),
      rows: clampDimension(input.rows),
      env: { ...createTerminalEnv(), ...(target.env ?? {}) },
      name: "xterm-256color",
    });
    const transcript = new TerminalOutputStore();
    const output = new OutputBuffer((data) => {
      const snapshot = transcript.append(id, data);
      this.events.emit({
        type: "data",
        terminalId: id,
        data,
        sequence: snapshot.sequence,
      });
    });
    const info: TerminalSessionInfo = {
      id,
      name: normalizeTerminalName(input.name),
      scope: input.scope,
      ...(scopeInfo.projectId ? { projectId: scopeInfo.projectId } : {}),
      runtime: input.runtime,
      source: input.source ?? "user",
      ...(scopeInfo.sessionId ? { sessionId: scopeInfo.sessionId } : {}),
      status: "running",
      cwd: target.executionCwd,
      shell: target.shell,
      cols: clampDimension(input.cols),
      rows: clampDimension(input.rows),
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(id, {
      info,
      pty,
      target,
      targetClosed: false,
      output,
      transcript,
      cancelRequested: false,
    });

    try {
      pty.onData((data) => output.push(data));
      pty.onExit(({ exitCode }) => {
      output.dispose();
      const session = this.sessions.get(id);
      if (!session) return;
      session.pty = null;
      const status = session.cancelRequested ? "killed" : exitCode === 0 ? "completed" : "failed";
      session.info = {
        ...session.info,
        status,
        exitedAt: new Date().toISOString(),
        exitCode,
      };
      if (status === "killed") this.events.emit({ type: "status", terminalId: id, status });
      this.events.emit({ type: "exit", terminalId: id, exitCode });
        void this.closeTarget(session);
      });
    } catch (error) {
      this.sessions.delete(id);
      output.dispose();
      try { pty.kill(); } catch {}
      throw error;
    }

    return info;
  }

  async write(input: TerminalWriteRequest): Promise<void> {
    const session = this.requireRunningSession(input.terminalId);
    session.pty.write(input.data);
  }

  async resize(input: TerminalResizeRequest): Promise<void> {
    const session = this.requireRunningSession(input.terminalId);
    const cols = clampDimension(input.cols);
    const rows = clampDimension(input.rows);
    session.pty.resize(cols, rows);
    await session.target.resize?.(cols, rows);
    session.info = { ...session.info, cols, rows };
  }

  async read(input: TerminalReadRequest): Promise<TerminalReadResult> {
    const session = this.requireSession(input.terminalId);
    session.output.drain();
    return session.transcript.read(input.terminalId, {
      after: input.after,
      maxChars: input.maxChars,
    });
  }

  async wait(input: TerminalWaitRequest): Promise<TerminalWaitResult> {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new Error("Terminal wait timeoutMs must be a positive finite number.");
    }
    const current = this.requireSession(input.terminalId);
    if (isTerminalStatus(current.info.status)) return this.waitResult(input, false);

    return await new Promise<TerminalWaitResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: () => void = () => {};
      const finish = (timedOut: boolean, error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        input.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(this.waitResult(input, timedOut));
      };
      unsubscribe = this.subscribe((event) => {
        if (event.terminalId !== input.terminalId) return;
        if (event.type === "exit" || (event.type === "status" && event.status === "killed")) {
          finish(false);
        }
      });
      timer = setTimeout(() => finish(true), input.timeoutMs);
      timer.unref?.();
      const onAbort = () => finish(false, input.signal?.reason ?? new Error("Terminal wait aborted."));
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener("abort", onAbort, { once: true });
      if (isTerminalStatus(this.requireSession(input.terminalId).info.status)) finish(false);
    });
  }

  async signal(input: TerminalSignalRequest): Promise<void> {
    if (input.signal === "terminate") {
      await this.kill(input.terminalId);
      return;
    }
    const session = this.requireRunningSession(input.terminalId);
    session.pty.write(input.signal === "interrupt" ? "\x03" : "\x04");
  }

  async kill(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    if (isTerminalStatus(session.info.status) || session.info.status === "stopping") return;
    session.output.dispose();
    session.cancelRequested = true;
    session.info = { ...session.info, status: "stopping" };
    this.events.emit({ type: "status", terminalId, status: "stopping" });
    session.pty?.kill();
    await session.target.signal("terminate").catch(() => {});
    await this.closeTarget(session);
  }

  async list(): Promise<TerminalSessionInfo[]> {
    return [...this.sessions.values()].map((session) => ({ ...session.info }));
  }

  subscribe(listener: TerminalEventListener): () => void {
    return this.events.subscribe(listener);
  }

  async dispose(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
    await Promise.all(
      ids.map((id) =>
        this.wait({ terminalId: id, timeoutMs: 1_000 }).catch(() => undefined),
      ),
    );
    this.sessions.clear();
    this.events.clear();
  }

  private waitResult(input: TerminalWaitRequest, timedOut: boolean): TerminalWaitResult {
    const session = this.requireSession(input.terminalId);
    session.output.drain();
    return {
      ...session.transcript.read(input.terminalId, {
        after: input.after,
        maxChars: input.maxChars,
      }),
      terminal: { ...session.info },
      timedOut,
    };
  }

  private requireSession(terminalId: string): PtyTerminalSession {
    const session = this.sessions.get(terminalId);
    if (!session) throw new Error(`Terminal ${terminalId} does not exist.`);
    return session;
  }

  private requireRunningSession(
    terminalId: string,
  ): PtyTerminalSession & { pty: IPty } {
    const session = this.requireSession(terminalId);
    if (
      session.info.status !== "running" ||
      !session.pty
    ) {
      throw new Error(`Terminal ${terminalId} is no longer running.`);
    }
    return session as PtyTerminalSession & { pty: IPty };
  }

  private async requireEnvironmentTarget(
    input: TerminalCreateRequest,
    cwd: string,
    terminalId: string,
  ): Promise<EnvironmentPtyTarget> {
    if (!this.options.resolveTarget) {
      throw new Error("Execution environment terminal target resolver is not configured.");
    }
    return await this.options.resolveTarget(input, cwd, terminalId);
  }

  private async closeTarget(session: PtyTerminalSession): Promise<void> {
    if (session.targetClosed) return;
    session.targetClosed = true;
    await session.target.close();
  }
}

function isTerminalStatus(status: TerminalSessionInfo["status"]): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

function normalizeTerminalName(value?: string): string {
  const name = value?.trim();
  return name ? name.slice(0, 80) : "Terminal";
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return 80;
  return Math.max(1, Math.min(Math.round(value), 1_000));
}

async function requireDirectory(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error("Terminal cwd must be a directory.");
}
