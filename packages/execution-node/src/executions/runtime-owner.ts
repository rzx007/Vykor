import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { getProjectConfigDir } from "@vykor/host-config";
import { ChildAgentExecutionRegistry } from "./child-agent-execution-registry.js";
import { DetachedProcessSupervisor } from "./detached-process-supervisor.js";
import type { ExecutionRuntimeScope } from "./types.js";
import { LspClient, type LspServerConfig } from "../lsp/index.js";

type Scope = string | ExecutionRuntimeScope;

function normalize(scope?: Scope): ExecutionRuntimeScope {
  const input = typeof scope === "string" ? { cwd: scope } : (scope ?? { cwd: process.cwd() });
  const cwd = resolve(input.cwd);
  return {
    cwd: process.platform === "win32" ? cwd.toLowerCase() : cwd,
    sessionId: input.sessionId?.trim() || undefined,
  };
}

function keyOf(scope: ExecutionRuntimeScope): string {
  // Tuple encoding prevents cwd/session delimiters from aliasing another scope.
  return JSON.stringify([scope.cwd, scope.sessionId ?? null]);
}

/** One Node host owns its execution directory, in-flight LSP calls and shutdown. */
export class ExecutionRuntimeOwner {
  private readonly id = randomUUID();
  private readonly processes = new Map<string, DetachedProcessSupervisor>();
  private readonly children = new Map<string, ChildAgentExecutionRegistry>();
  private readonly scopes = new Map<string, ExecutionRuntimeScope>();
  private readonly closingScopes = new Map<string, Promise<void>>();
  private readonly lspCalls = new Map<Promise<unknown>, { key: string; abort: AbortController }>();
  private readonly abort = new AbortController();
  private closePromise?: Promise<void>;

  getDetachedProcessSupervisor(scope?: Scope): DetachedProcessSupervisor {
    const normalized = normalize(scope),
      key = keyOf(normalized);
    this.assertOpen(key);
    let supervisor = this.processes.get(key);
    if (!supervisor) {
      supervisor = new DetachedProcessSupervisor(this.outputDir(normalized, "processes"));
      this.processes.set(key, supervisor);
      this.scopes.set(key, normalized);
    }
    return supervisor;
  }

  getChildAgentExecutionRegistry(scope?: Scope): ChildAgentExecutionRegistry {
    const normalized = normalize(scope),
      key = keyOf(normalized);
    this.assertOpen(key);
    let registry = this.children.get(key);
    if (!registry) {
      registry = new ChildAgentExecutionRegistry(this.outputDir(normalized, "child-agents"));
      this.children.set(key, registry);
      this.scopes.set(key, normalized);
    }
    return registry;
  }

  /** Each LSP request has its own signal/config; the host waits for active calls on close. */
  withLspClient<T>(config: LspServerConfig, work: (client: LspClient) => Promise<T>): Promise<T> {
    const scope = normalize({ cwd: config.cwd ?? process.cwd(), sessionId: config.sessionId });
    const key = keyOf(scope);
    this.assertOpen(key);
    const abort = new AbortController();
    const client = new LspClient({
      ...config,
      signal: AbortSignal.any([
        this.abort.signal,
        abort.signal,
        ...(config.signal ? [config.signal] : []),
      ]),
    });
    const call = Promise.resolve()
      .then(() => {
        this.assertOpen();
        return work(client);
      })
      .finally(() => client.disconnect());
    this.lspCalls.set(call, { key, abort });
    this.scopes.set(key, scope);
    void call.finally(() => this.lspCalls.delete(call)).catch(() => {});
    return call;
  }

  /** Release one session (or every session in a cwd), awaiting actual process cleanup. */
  closeScope(scope?: Scope): Promise<void> {
    const normalized = scope === undefined ? undefined : normalize(scope);
    const keys = [...this.scopes]
      .filter(
        ([, value]) =>
          !normalized ||
          (value.cwd === normalized.cwd &&
            (!normalized.sessionId || value.sessionId === normalized.sessionId)),
      )
      .map(([key]) => key);
    const work = keys.map((key) => {
      const supervisor = this.processes.get(key),
        children = this.children.get(key);
      this.processes.delete(key);
      this.children.delete(key);
      this.scopes.delete(key);
      children?.close(); // Observation only; the framework remains the child lifecycle owner.
      const calls = [...this.lspCalls].filter(([, value]) => value.key === key);
      for (const [, value] of calls) value.abort.abort(new Error("Execution scope is closing"));
      const processClosing = supervisor?.aclose() ?? Promise.resolve();
      const closing = settleShutdown([
        processClosing,
        Promise.allSettled(calls.map(([call]) => call)),
      ]);
      this.closingScopes.set(key, closing);
      void closing.finally(() => this.closingScopes.delete(key)).catch(() => {});
      return closing;
    });
    const pending = [...this.closingScopes]
      .filter(([key]) => {
        const [cwd, sessionId] = JSON.parse(key) as [string, string | null];
        return (
          !normalized ||
          (cwd === normalized.cwd && (!normalized.sessionId || sessionId === normalized.sessionId))
        );
      })
      .map(([, closing]) => closing);
    return settleShutdown(pending);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    this.closePromise = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // Close admission before abort callbacks can re-enter shutdown.
    this.abort.abort(new Error("Execution runtime owner is closing"));
    void this.closeScope().then(finish, fail);
    return this.closePromise;
  }

  private assertOpen(key?: string): void {
    if (this.abort.signal.aborted || this.closePromise)
      throw new Error("Execution runtime owner is closed");
    if (key && this.closingScopes.has(key)) throw new Error("Execution runtime scope is closing");
  }

  private outputDir(scope: ExecutionRuntimeScope, backend: string): string {
    // A released scope can be recreated without overwriting a prior task's persisted log.
    const base = join(
      getProjectConfigDir(scope.cwd),
      "executions",
      backend,
      "owners",
      this.id,
      randomUUID(),
    );
    if (!scope.sessionId) return base;
    // Keep output isolated even when different raw session IDs have the same safe filename.
    return join(
      base,
      "sessions",
      createHash("sha256").update(scope.sessionId).digest("hex").slice(0, 32),
    );
  }
}

async function settleShutdown(work: Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(work);
  const failures = [
    ...new Set(settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))),
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Failed to close execution resources");
}
