import type {
  TerminalCreateRequest,
  TerminalEventListener,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSessionInfo,
  TerminalWaitRequest,
  TerminalWaitResult,
  TerminalWriteRequest,
} from "@vykor/terminal";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAgentTerminalBundle,
  type AgentTerminalProvider,
} from "./agent-terminal-host.js";

const CREATED_AT = "2026-09-01T01:02:03.000Z";
const EXITED_AT = "2026-09-01T01:02:04.000Z";

afterEach(() => vi.restoreAllMocks());

describe("createAgentTerminalBundle", () => {
  it("opens an agent terminal and lists it as the same terminal Job", async () => {
    const provider = new FakeTerminalProvider();
    const bundle = createAgentTerminalBundle({
      cwd: "C:\\repo",
      sessionId: "session-1",
      provider,
    });

    const opened = await bundle.terminal.open({
      cwd: "C:\\repo",
      sessionId: "session-1",
      name: "node-repl",
      shell: process.execPath,
      cols: 80,
      rows: 24,
    });

    expect(provider.createdWith).toEqual({
      scope: { kind: "session", sessionId: "session-1" },
      runtime: "local",
      cols: 80,
      rows: 24,
      name: "node-repl",
      shell: process.execPath,
      cwd: "C:\\repo",
      source: "agent",
    });
    expect(await bundle.jobs.list({ sessionId: "session-1" })).toEqual([{
      id: opened.id,
      kind: "terminal",
      label: "node-repl",
      ownerSession: "session-1",
      status: "running",
      capabilities: { read: true, wait: true, send: true, cancel: true },
      cwd: "C:\\repo",
      startedAt: Date.parse(CREATED_AT),
      updatedAt: Date.parse(CREATED_AT),
    }]);
  });

  it("applies Job list filters to owned terminals", async () => {
    const provider = new FakeTerminalProvider();
    const bundle = createAgentTerminalBundle({ cwd: "C:\\repo", sessionId: "session-1", provider });
    await bundle.terminal.open({ cwd: "C:\\repo", sessionId: "session-1" });

    await expect(bundle.jobs.list({
      sessionId: "session-1",
      kinds: ["shell"],
    })).resolves.toEqual([]);
  });

  it("maps Job read and wait requests and returns terminal output with snapshots", async () => {
    const provider = new FakeTerminalProvider();
    const bundle = createAgentTerminalBundle({ cwd: "C:\\repo", sessionId: "session-1", provider });
    const opened = await bundle.terminal.open({ cwd: "C:\\repo", sessionId: "session-1" });
    const controller = new AbortController();

    await expect(bundle.jobs.read({
      sessionId: "session-1",
      jobId: opened.id,
      after: 2,
      maxChars: 40,
    })).resolves.toMatchObject({
      text: "output",
      cursor: 7,
      truncated: false,
      snapshot: { id: opened.id, status: "running" },
    });
    await expect(bundle.jobs.wait({
      sessionId: "session-1",
      jobId: opened.id,
      after: 3,
      maxChars: 50,
      timeoutMs: 250,
      signal: controller.signal,
    })).resolves.toMatchObject({
      text: "waited",
      cursor: 9,
      truncated: false,
      timedOut: true,
      snapshot: { id: opened.id, status: "running" },
    });

    expect(provider.readWith).toEqual({ terminalId: opened.id, after: 2, maxChars: 40 });
    expect(provider.waitWith).toEqual({
      terminalId: opened.id,
      after: 3,
      maxChars: 50,
      timeoutMs: 250,
      signal: controller.signal,
    });
  });

  it("keeps repeated cancellation at the provider stopping state until exit", async () => {
    let now = Date.parse(CREATED_AT) + 100;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const provider = new FakeTerminalProvider();
    const bundle = createAgentTerminalBundle({ cwd: "C:\\repo", sessionId: "session-1", provider });
    const opened = await bundle.terminal.open({ cwd: "C:\\repo", sessionId: "session-1" });

    await bundle.jobs.send({ sessionId: "session-1", jobId: opened.id, data: "hello\n" });
    const first = await bundle.jobs.cancel({
      sessionId: "session-1",
      jobId: opened.id,
      reason: "no longer needed",
    });
    now += 100;
    const second = await bundle.jobs.cancel({
      sessionId: "session-1",
      jobId: opened.id,
      reason: "still no longer needed",
    });

    expect(provider.writeWith).toEqual({ terminalId: opened.id, data: "hello\n" });
    expect(provider.killed).toEqual([opened.id, opened.id]);
    expect(first).toMatchObject({
      id: opened.id,
      status: "stopping",
      capabilities: { read: true, wait: true, send: false, cancel: false },
      updatedAt: Date.parse(CREATED_AT) + 100,
    });
    expect(first).not.toHaveProperty("finishedAt");
    expect(second).toMatchObject({
      id: opened.id,
      status: "stopping",
      capabilities: { read: true, wait: true, send: false, cancel: false },
      updatedAt: Date.parse(CREATED_AT) + 200,
    });
    expect(second).not.toHaveProperty("finishedAt");
  });

  it("reports a cancelled terminal as killed only after the provider exits", async () => {
    const provider = new FakeTerminalProvider();
    const bundle = createAgentTerminalBundle({ cwd: "C:\\repo", sessionId: "session-1", provider });
    const opened = await bundle.terminal.open({ cwd: "C:\\repo", sessionId: "session-1" });

    await bundle.jobs.cancel({ sessionId: "session-1", jobId: opened.id });
    provider.exit(opened.id, 1);

    await expect(bundle.jobs.read({ sessionId: "session-1", jobId: opened.id }))
      .resolves.toMatchObject({
        snapshot: {
          status: "killed",
          capabilities: { read: true, wait: true, send: false, cancel: false },
          updatedAt: Date.parse(EXITED_AT),
          finishedAt: Date.parse(EXITED_AT),
        },
      });
    await expect(bundle.jobs.list({ sessionId: "session-1" })).resolves.toEqual([
      expect.objectContaining({ status: "killed", finishedAt: Date.parse(EXITED_AT) }),
    ]);
  });

  it.each([
    [0, "completed"],
    [7, "failed"],
  ] as const)("does not overwrite terminal exit code %s status %s on cancel", async (
    exitCode,
    status,
  ) => {
    const provider = new FakeTerminalProvider();
    const bundle = createAgentTerminalBundle({ cwd: "C:\\repo", sessionId: "session-1", provider });
    const opened = await bundle.terminal.open({ cwd: "C:\\repo", sessionId: "session-1" });
    provider.exit(opened.id, exitCode);

    await expect(bundle.jobs.cancel({ sessionId: "session-1", jobId: opened.id }))
      .resolves.toMatchObject({
        status,
        capabilities: { read: true, wait: true, send: false, cancel: false },
        finishedAt: Date.parse(EXITED_AT),
      });
  });

  it.each([
    [0, "completed"],
    [7, "failed"],
  ] as const)("maps provider exit code %s to %s", async (exitCode, status) => {
    const provider = new FakeTerminalProvider();
    const bundle = createAgentTerminalBundle({ cwd: "C:\\repo", sessionId: "session-1", provider });
    const opened = await bundle.terminal.open({ cwd: "C:\\repo", sessionId: "session-1" });

    provider.exit(opened.id, exitCode);

    await expect(bundle.jobs.list({ sessionId: "session-1" })).resolves.toEqual([
      expect.objectContaining({
        id: opened.id,
        status,
        capabilities: { read: true, wait: true, send: false, cancel: false },
        updatedAt: Date.parse(EXITED_AT),
        finishedAt: Date.parse(EXITED_AT),
      }),
    ]);
  });

  it("updates the Job timestamp on output and input without changing it on reads", async () => {
    let now = Date.parse(CREATED_AT);
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const provider = new FakeTerminalProvider();
    const bundle = createAgentTerminalBundle({
      cwd: "C:\\repo",
      sessionId: "session-1",
      provider,
    });
    const opened = await bundle.terminal.open({ cwd: "C:\\repo", sessionId: "session-1" });
    now += 100;
    provider.output(opened.id, "one");
    expect((await bundle.jobs.list({ sessionId: "session-1" }))[0]?.updatedAt).toBe(now);

    now += 100;
    await bundle.jobs.read({ sessionId: "session-1", jobId: opened.id });
    expect((await bundle.jobs.list({ sessionId: "session-1" }))[0]?.updatedAt).toBe(now - 100);

    await bundle.jobs.send({ sessionId: "session-1", jobId: opened.id, data: "two" });
    expect((await bundle.jobs.list({ sessionId: "session-1" }))[0]?.updatedAt).toBe(now);
  });

  it("rejects every Job operation from another session", async () => {
    const provider = new FakeTerminalProvider();
    const bundle = createAgentTerminalBundle({ cwd: "C:\\repo", sessionId: "session-1", provider });
    const opened = await bundle.terminal.open({ cwd: "C:\\repo", sessionId: "session-1" });
    const mismatch = "Job owner session mismatch.";

    await expect(bundle.jobs.list({ sessionId: "session-2" })).rejects.toThrow(mismatch);
    await expect(bundle.jobs.read({ sessionId: "session-2", jobId: opened.id })).rejects.toThrow(mismatch);
    await expect(bundle.jobs.wait({
      sessionId: "session-2",
      jobId: opened.id,
      timeoutMs: 1,
    })).rejects.toThrow(mismatch);
    await expect(bundle.jobs.send({
      sessionId: "session-2",
      jobId: opened.id,
      data: "x",
    })).rejects.toThrow(mismatch);
    await expect(bundle.jobs.cancel({
      sessionId: "session-2",
      jobId: opened.id,
    })).rejects.toThrow(mismatch);
  });

  it("rejects terminal opens outside the bundle session and cwd", async () => {
    const bundle = createAgentTerminalBundle({
      cwd: "C:\\repo",
      sessionId: "session-1",
      provider: new FakeTerminalProvider(),
    });

    await expect(bundle.terminal.open({
      cwd: "C:\\repo",
      sessionId: "session-2",
    })).rejects.toThrow("Terminal owner session mismatch.");
    await expect(bundle.terminal.open({
      cwd: "C:\\other",
      sessionId: "session-1",
    })).rejects.toThrow("Terminal cwd mismatch.");
  });

  it("disposes once and preserves a failed cleanup result", async () => {
    const failure = new Error("dispose failed");
    const provider = new FakeTerminalProvider(failure);
    const bundle = createAgentTerminalBundle({ cwd: "C:\\repo", sessionId: "session-1", provider });

    const first = bundle.cleanup();
    const second = bundle.cleanup();

    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(bundle.cleanup()).rejects.toBe(failure);
    expect(provider.disposeCalls).toBe(1);
    expect(bundle.cleanupIdentity).toBe(provider);
  });
});

class FakeTerminalProvider implements AgentTerminalProvider {
  private readonly terminals = new Map<string, TerminalSessionInfo>();
  private readonly listeners = new Set<TerminalEventListener>();
  private readonly cancelRequested = new Set<string>();
  private readonly disposeFailure: Error | undefined;
  createdWith?: TerminalCreateRequest;
  readWith?: TerminalReadRequest;
  waitWith?: TerminalWaitRequest;
  writeWith?: TerminalWriteRequest;
  killed: string[] = [];
  disposeCalls = 0;

  constructor(disposeFailure?: Error) {
    this.disposeFailure = disposeFailure;
  }

  async create(input: TerminalCreateRequest): Promise<TerminalSessionInfo> {
    this.createdWith = input;
    const terminal: TerminalSessionInfo = {
      id: "terminal-1",
      name: input.name ?? "Agent terminal",
      scope: input.scope,
      ...(input.scope.kind === "project" ? { projectId: input.scope.projectId } : {}),
      runtime: input.runtime,
      source: input.source ?? "user",
      ...(input.scope.kind === "session" ? { sessionId: input.scope.sessionId } : {}),
      status: "running",
      cwd: input.cwd ?? "C:\\repo",
      shell: input.shell ?? "shell",
      cols: input.cols,
      rows: input.rows,
      createdAt: CREATED_AT,
    };
    this.terminals.set(terminal.id, terminal);
    return { ...terminal };
  }

  async list(): Promise<TerminalSessionInfo[]> {
    return [...this.terminals.values()].map((terminal) => ({ ...terminal }));
  }

  async read(input: TerminalReadRequest): Promise<TerminalReadResult> {
    this.readWith = input;
    return { terminalId: input.terminalId, data: "output", sequence: 7, truncated: false };
  }

  async wait(input: TerminalWaitRequest): Promise<TerminalWaitResult> {
    this.waitWith = input;
    return {
      terminalId: input.terminalId,
      data: "waited",
      sequence: 9,
      truncated: false,
      terminal: { ...this.require(input.terminalId) },
      timedOut: true,
    };
  }

  async write(input: TerminalWriteRequest): Promise<void> {
    this.writeWith = input;
  }

  async kill(terminalId: string): Promise<void> {
    this.killed.push(terminalId);
    const terminal = this.require(terminalId);
    if (terminal.status !== "running") return;
    this.cancelRequested.add(terminalId);
    this.terminals.set(terminalId, {
      ...terminal,
      status: "stopping",
    });
    this.emit({ type: "status", terminalId, status: "stopping" });
  }

  subscribe(listener: TerminalEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): Promise<void> {
    this.disposeCalls += 1;
    return this.disposeFailure ? Promise.reject(this.disposeFailure) : Promise.resolve();
  }

  output(terminalId: string, data: string): void {
    this.emit({ type: "data", terminalId, data, sequence: data.length });
  }

  exit(terminalId: string, exitCode: number): void {
    const terminal = this.require(terminalId);
    const status = this.cancelRequested.has(terminalId)
      ? "killed"
      : exitCode === 0 ? "completed" : "failed";
    this.terminals.set(terminalId, {
      ...terminal,
      status,
      exitedAt: EXITED_AT,
      exitCode,
    });
    if (status === "killed") this.emit({ type: "status", terminalId, status });
    this.emit({ type: "exit", terminalId, exitCode });
  }

  private emit(event: Parameters<TerminalEventListener>[0]): void {
    for (const listener of this.listeners) listener(event);
  }

  private require(terminalId: string): TerminalSessionInfo {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Terminal ${terminalId} does not exist.`);
    return terminal;
  }
}
