import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { getTasksDir, PROJECT_CONFIG_DIR_NAME, type Settings } from "@vykor/core";
import type { EnvironmentProcess, EnvironmentProcessExecutor } from "@vykor/environment";
import {
  createProcess,
  createShellProcess,
  signalProcessTree,
  terminateProcessTree,
  type SandboxPolicy,
} from "@vykor/sandbox";
import type {
  AwaitExecutionResult,
  DetachedProcessExecution,
  ExecutionEvent,
  ExecutionStatus,
  ProcessCompletionListener,
  ProcessExecutionListener,
  StartAgentProcessOptions,
  StartShellExecutionOptions,
} from "./types.js";
import { appendBoundedOutput } from "./bounded-output-file.js";

const MAX_OUTPUT_BYTES = 12_000;
const STOP_GRACE_MS = 3_000;
const MAX_RESTARTS = 5;
const RESTART_NOTICE =
  "[Vykor] Agent task restarted; prior interactive context was not preserved.\n";

interface RunState {
  child: ChildProcess;
  /** Monotonically increasing per restart; stale watchers ignore terminal updates. */
  generation: number;
}

/**
 * Supervise locally spawned non-PTY shell, dream, and explicit Agent processes.
 * Framework child Agent handles live in ChildAgentExecutionRegistry instead.
 */
export class DetachedProcessSupervisor {
  private executions = new Map<string, DetachedProcessExecution>();
  private states = new Map<string, RunState>();
  private generations = new Map<string, number>();
  private writeChains = new Map<string, Promise<void>>();
  private completionListeners = new Map<string, ProcessCompletionListener>();
  private executionListeners = new Map<string, ProcessExecutionListener>();
  private idCounter = 0;
  private readonly tasksDir: string;
  private taskSettings = new Map<string, Settings>();
  private taskPolicies = new Map<string, SandboxPolicy>();
  private taskProcessExecutors = new Map<string, EnvironmentProcessExecutor>();
  private shellStartPromises = new Map<string, Promise<DetachedProcessExecution>>();

  constructor(tasksDir?: string) {
    // Lazily fall back to a temp dir if core paths are unavailable; callers in
    // tests pass an explicit dir.
    this.tasksDir = tasksDir ?? defaultTasksDir();
  }

  // ── creation ────────────────────────────────────────────

  /**
   * Start a background shell task.
   *
   * Positional form: `startShellExecution(command, description, cwd)`.
   * Options form supports `argv` (direct-exec, no shell) and `env`.
   */
  async startShellExecution(command: string, description: string, cwd: string): Promise<DetachedProcessExecution>;
  async startShellExecution(options: StartShellExecutionOptions): Promise<DetachedProcessExecution>;
  async startShellExecution(
    commandOrOptions: string | StartShellExecutionOptions,
    description?: string,
    cwd?: string,
  ): Promise<DetachedProcessExecution> {
    const opts: StartShellExecutionOptions =
      typeof commandOrOptions === "string"
        ? { command: commandOrOptions, description: description!, cwd: cwd! }
        : commandOrOptions;

    if (opts.command == null && opts.argv == null) {
      throw new Error("startShellExecution requires either command or argv");
    }
    if (opts.command != null && opts.argv != null) {
      throw new Error("startShellExecution accepts only one of command or argv");
    }

    const id = opts.id ?? `task_${++this.idCounter}`;
    const existing = this.executions.get(id);
    if (existing) {
      if (!this.matchesShellRequest(existing, opts)) {
        throw new Error(`Execution request identity conflict: ${id}`);
      }
      const inFlight = this.shellStartPromises.get(id);
      return inFlight ? await inFlight : existing;
    }
    const starting = this.startShellExecutionOnce(id, opts);
    this.shellStartPromises.set(id, starting);
    try {
      return await starting;
    } finally {
      this.shellStartPromises.delete(id);
    }
  }

  private async startShellExecutionOnce(
    id: string,
    opts: StartShellExecutionOptions,
  ): Promise<DetachedProcessExecution> {
    const outputFile = join(this.tasksDir, `${id}.log`);
    const task: DetachedProcessExecution = {
      id,
      backend: "detached_process",
      type: opts.type ?? "shell",
      status: "running",
      description: opts.description,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      command: opts.command,
      argv: opts.argv ? [...opts.argv] : undefined,
      env: opts.env ? { ...opts.env } : undefined,
      outputFile,
      createdAt: Date.now(),
      startedAt: Date.now(),
      metadata: {},
    };
    this.ensureTasksDir();
    writeFileSync(outputFile, "");
    this.executions.set(id, task);
    if (opts.settings) this.taskSettings.set(id, opts.settings);
    if (opts.policy) this.taskPolicies.set(id, opts.policy);
    if (opts.processExecutor) this.taskProcessExecutors.set(id, opts.processExecutor);
    this.notifyExecutionEvent(task, "created");
    try {
      await this.startProcess(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      task.status = "failed";
      task.exitCode = 1;
      task.finishedAt = Date.now();
      task.metadata.status_note = message;
      try {
        appendBoundedOutput(outputFile, `[spawn error] ${message}\n`);
      } catch {
        /* output file may have been removed by shutdown */
      }
      await this.notifyCompletion(task);
      throw error;
    }
    return task;
  }

  private matchesShellRequest(
    task: DetachedProcessExecution,
    opts: StartShellExecutionOptions,
  ): boolean {
    return task.type === (opts.type ?? "shell") &&
      task.description === opts.description &&
      task.cwd === opts.cwd &&
      task.sessionId === opts.sessionId &&
      task.command === opts.command &&
      isDeepStrictEqual(task.argv, opts.argv) &&
      isDeepStrictEqual(task.env, opts.env) &&
      isDeepStrictEqual(this.taskSettings.get(task.id), opts.settings) &&
      isDeepStrictEqual(this.taskPolicies.get(task.id), opts.policy);
  }

  /**
   * Start a local agent task as a subprocess.
   *
   * Positional form: `startAgentProcess(prompt, description, cwd, model?)`.
   *
   * The agent's concrete command is the swarm's responsibility (Phase D): this
   * manager only spawns whatever `argv`/`command` it is handed and wires it
   * into the same execution/output/stop machinery. When neither `argv` nor
   * `command` is supplied the task is NOT silently left pending — it is marked
   * `failed` with `metadata.needs_argv = "1"` and a clear log line, so callers
   * (and the eventual swarm dispatcher) get an explicit, observable signal.
   */
  async startAgentProcess(
    prompt: string,
    description: string,
    cwd: string,
    model?: string,
  ): Promise<DetachedProcessExecution>;
  async startAgentProcess(options: StartAgentProcessOptions): Promise<DetachedProcessExecution>;
  async startAgentProcess(
    promptOrOptions: string | StartAgentProcessOptions,
    description?: string,
    cwd?: string,
    model?: string,
  ): Promise<DetachedProcessExecution> {
    const opts: StartAgentProcessOptions =
      typeof promptOrOptions === "string"
        ? { prompt: promptOrOptions, description: description!, cwd: cwd!, model }
        : promptOrOptions;

    // No concrete command yet (swarm dispatch is Phase D). Don't spawn — but
    // don't go silently pending either: register an explicit failed record.
    if (opts.command == null && opts.argv == null) {
      const id = opts.id ?? `task_${++this.idCounter}`;
      if (this.executions.has(id)) throw new Error(`Execution already exists: ${id}`);
      const outputFile = join(this.tasksDir, `${id}.log`);
      this.ensureTasksDir();
      const message =
        "Agent task requires argv or command to spawn a subprocess " +
        "(swarm dispatch is not wired yet — Phase D).\n";
      writeFileSync(outputFile, message);
      const task: DetachedProcessExecution = {
        id,
        backend: "detached_process",
        type: opts.type ?? "agent",
        status: "failed",
        description: opts.description,
        cwd: opts.cwd,
        sessionId: opts.sessionId,
        prompt: opts.prompt,
        outputFile,
        createdAt: Date.now(),
        finishedAt: Date.now(),
        metadata: { needs_argv: "1", status_note: "Missing argv/command for agent task" },
      };
      this.executions.set(id, task);
      this.notifyExecutionEvent(task, "created");
      await this.notifyCompletion(task);
      return task;
    }

    const task = await this.startShellExecution({
      command: opts.command,
      argv: opts.argv,
      description: opts.description,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      type: opts.type ?? "agent",
      env: opts.env,
      settings: opts.settings,
      policy: opts.policy,
    });
    task.prompt = opts.prompt;
    // Forward the prompt to the freshly spawned agent over stdin.
    await this.writeInput(task.id, opts.prompt);
    return task;
  }

  // ── queries ─────────────────────────────────────────────

  getExecution(executionId: string): DetachedProcessExecution | undefined {
    return this.executions.get(executionId);
  }

  listExecutions(status?: string): DetachedProcessExecution[] {
    const all = [...this.executions.values()].sort((a, b) => b.createdAt - a.createdAt);
    if (status) return all.filter((t) => t.status === status);
    return all;
  }

  /** Return the tail of a task's output log. */
  readOutput(executionId: string, maxBytes = MAX_OUTPUT_BYTES): string {
    const task = this.executions.get(executionId);
    if (!task) throw new Error(`Execution not found: ${executionId}`);
    let content = "";
    if (task.outputFile && existsSync(task.outputFile)) {
      content = readFileSync(task.outputFile, "utf-8");
    }
    if (content.length > maxBytes) content = content.slice(-maxBytes);
    return content || "(no output)";
  }

  // ── stdin ───────────────────────────────────────────────

  /**
   * Write one frame to a task's stdin. Plain text is sent line-framed; payloads
   * that contain embedded newlines are wrapped as a single JSON `{text}` line so
   * a readline-based worker protocol can consume them atomically.
   */
  async writeInput(executionId: string, data: string): Promise<void> {
    const task = this.executions.get(executionId);
    if (!task) throw new Error(`Execution not found: ${executionId}`);
    const payload = encodeWorkerPayload(data);

    // Serialize writes per task so frames never interleave.
    const prev = this.writeChains.get(executionId) ?? Promise.resolve();
    const next = prev.then(() => this.doWrite(task, payload));
    this.writeChains.set(
      executionId,
      next.catch(() => {}),
    );
    return next;
  }

  private async doWrite(task: DetachedProcessExecution, payload: string): Promise<void> {
    let state = this.states.get(task.id);
    const writable = state?.child.stdin && !state.child.stdin.destroyed && state.child.exitCode === null;
    if (!writable) {
      if (task.type !== "agent") {
        throw new Error(`Task ${task.id} does not accept input`);
      }
      // Lazily resurrect the dead agent before writing (restart limit enforced
      // inside restartAgentProcess).
      state = await this.restartAgentProcess(task);
    }
    const stdin = state!.child.stdin!;
    try {
      await writeToStdin(stdin, payload);
    } catch (err) {
      // Broken pipe mid-write: restart the agent once and retry (still bounded
      // by the restart limit). Non-agent tasks just propagate the error.
      if (task.type !== "agent") throw err;
      const restarted = await this.restartAgentProcess(task);
      await writeToStdin(restarted.child.stdin!, payload);
    }
  }

  // ── stop / shutdown ─────────────────────────────────────

  /** Terminate a running process: graceful signal, then forced tree cleanup. */
  async stopExecution(executionId: string): Promise<DetachedProcessExecution> {
    const task = this.executions.get(executionId);
    if (!task) throw new Error(`Execution not found: ${executionId}`);
    const state = this.states.get(executionId);
    if (!state) {
      if (task.status === "completed" || task.status === "failed" || task.status === "stopped") {
        return task;
      }
      throw new Error(`Execution ${executionId} is not running`);
    }

    // Mark stopped first so the exit watcher does not overwrite the status.
    task.status = "stopped";
    task.finishedAt = Date.now();
    // Bump generation so the watcher ignores this child's exit transition.
    this.generations.set(executionId, (this.generations.get(executionId) ?? 0) + 1);

    await terminateProcess(state.child, STOP_GRACE_MS);
    this.states.delete(executionId);
    await this.notifyCompletion(task);
    return task;
  }

  /** Register a completion listener; returns an unregister callback. */
  registerCompletionListener(listener: ProcessCompletionListener): () => void {
    const id = `listener_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    this.completionListeners.set(id, listener);
    return () => {
      this.completionListeners.delete(id);
    };
  }

  /**
   * Subscribe to task lifecycle events (`created` / `updated` / `completed`),
   * the symmetric counterpart to {@link registerCompletionListener}. Returns an
   * unregister callback. Listeners receive an immutable snapshot; a throwing
   * listener is isolated from the others.
   */
  registerExecutionListener(listener: ProcessExecutionListener): () => void {
    const id = `tasklistener_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    this.executionListeners.set(id, listener);
    return () => {
      this.executionListeners.delete(id);
    };
  }

  /**
   * Block until a task reaches a terminal state, then return its final status
   * and output tail.
   *
   * - Already terminal (completed/failed/stopped) → resolves immediately.
   * - Otherwise registers a one-shot completion listener scoped to `taskId` and
   *   resolves when that task completes (the listener unregisters itself).
   * - With `timeoutMs`, a timeout resolves `{ timedOut: true }` carrying the
   *   current status/output instead of rejecting; the timer and listener are
   *   both cleaned up to avoid leaks.
   * - Unknown `taskId` → throws.
   */
  awaitExecution(executionId: string, opts?: { timeoutMs?: number }): Promise<AwaitExecutionResult> {
    const task = this.executions.get(executionId);
    if (!task) throw new Error(`Execution not found: ${executionId}`);

    if (isTerminal(task.status)) {
      return Promise.resolve({
        status: task.status,
        output: this.readOutput(executionId),
        exitCode: task.exitCode,
      });
    }

    return new Promise<AwaitExecutionResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Forward-declared so cleanup can reference the unregister handle even
      // though it is assigned just below.
      let unregister: () => void = () => {};

      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        unregister();
      };

      unregister = this.registerCompletionListener((finished) => {
        if (settled || finished.id !== executionId) return;
        settled = true;
        cleanup();
        resolve({
          status: finished.status,
          output: this.readOutput(executionId),
          exitCode: finished.exitCode,
        });
      });

      // Late-binding guard: if the task became terminal between the snapshot
      // above and the listener registration, resolve from current state.
      const now = this.executions.get(executionId);
      if (now && isTerminal(now.status) && !settled) {
        settled = true;
        cleanup();
        resolve({
          status: now.status,
          output: this.readOutput(executionId),
          exitCode: now.exitCode,
        });
        return;
      }

      if (opts?.timeoutMs != null) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          const current = this.executions.get(executionId);
          resolve({
            status: current?.status ?? "running",
            output: this.readOutput(executionId),
            exitCode: current?.exitCode,
            timedOut: true,
          });
        }, opts.timeoutMs);
        // Don't let a pending await timer keep the process alive on its own.
        if (typeof timer.unref === "function") timer.unref();
      }
    });
  }

  /** Best-effort synchronous cleanup of all tracked subprocesses. */
  close(): void {
    for (const [id, state] of this.states) {
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
      try {
        state.child.stdin?.end();
      } catch {
        /* ignore */
      }
      try {
        killProcessTree(state.child);
      } catch {
        /* ignore */
      }
    }
    this.states.clear();
  }

  /** Async graceful shutdown: SIGTERM all, await exit (KILL on timeout). */
  async aclose(): Promise<void> {
    const states = [...this.states.values()];
    for (const id of this.states.keys()) {
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    }
    await Promise.all(states.map((s) => terminateProcess(s.child, STOP_GRACE_MS)));
    this.states.clear();
  }

  // ── internals ───────────────────────────────────────────

  private ensureTasksDir(): void {
    if (!existsSync(this.tasksDir)) {
      mkdirSync(this.tasksDir, { recursive: true });
    }
  }

  private async startProcess(taskId: string): Promise<RunState> {
    const task = this.executions.get(taskId)!;
    if (task.command == null && task.argv == null) {
      throw new Error(`Task ${taskId} does not have a command or argv to run`);
    }
    const generation = (this.generations.get(taskId) ?? 0) + 1;
    this.generations.set(taskId, generation);

    // On POSIX, run each task in its own process group (detached) so that, on
    // stop, we can signal the whole tree (the shell plus any grandchildren it
    // spawned) via `process.kill(-pid)`. Without this, a `shell: true` task's
    // grandchildren survive a `child.kill()` and leak. Windows uses
    // `taskkill /T` instead (see killProcessTree).
    const detached = process.platform !== "win32";

    let child: ChildProcess;
    const environmentExecutor = this.taskProcessExecutors.get(taskId);
    if (environmentExecutor && task.argv != null) {
      child = adaptEnvironmentProcess(await environmentExecutor.execProcess(task.argv, {
        cwd: task.cwd,
        env: task.env,
        owner: { kind: task.type === "agent" ? "agent" : "background", id: task.id },
      }));
    } else if (environmentExecutor) {
      child = adaptEnvironmentProcess(await environmentExecutor.execShell(task.command!, {
        cwd: task.cwd,
        env: task.env,
        owner: { kind: task.type === "agent" ? "agent" : "background", id: task.id },
      }));
    } else if (task.argv != null) {
      child = await createProcess(task.argv, {
        cwd: task.cwd,
        sessionId: task.sessionId,
        settings: this.taskSettings.get(taskId),
        policy: this.taskPolicies.get(taskId),
        env: task.env,
        owner: {
          kind: task.type === "agent" ? "agent" : "background",
          id: task.id,
        },
        detached,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      child = await createShellProcess(task.command!, {
        cwd: task.cwd,
        sessionId: task.sessionId,
        settings: this.taskSettings.get(taskId),
        policy: this.taskPolicies.get(taskId),
        env: task.env,
        owner: {
          kind: task.type === "agent" ? "agent" : "background",
          id: task.id,
        },
        detached,
        hostShell: "system",
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    const append = (chunk: Buffer | string) => {
      try {
        if (task.outputFile) appendBoundedOutput(task.outputFile, chunk);
      } catch {
        /* output file may be gone after shutdown */
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const state: RunState = { child, generation };
    this.states.set(taskId, state);

    // `exit` can fire before stdout/stderr have drained. `close` fires only
    // after the process has ended and its stdio streams are closed, so readers
    // cannot observe a terminal task before its final output is persisted.
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      void this.handleExit(taskId, generation, code, signal);
    };
    child.on("close", onClose);
    child.on("error", (err) => {
      append(`[spawn error] ${(err as Error).message}\n`);
    });

    return state;
  }

  private async handleExit(
    taskId: string,
    generation: number,
    code: number | null,
    _signal: NodeJS.Signals | null,
  ): Promise<void> {
    // Stale watcher (task was restarted or explicitly stopped).
    if (this.generations.get(taskId) !== generation) return;
    const task = this.executions.get(taskId);
    if (!task) return;

    const exitCode = code ?? 1;

    // Process exit only records terminal state. Unlike a naive "restart on any
    // non-zero exit" loop, this mirrors Python's `_watch_process`: a dead
    // process is just marked completed/failed and never proactively restarted.
    // Agent tasks are resurrected lazily, only when something tries to write to
    // a dead agent's stdin (see `doWrite` -> `restartAgentProcess`).
    task.exitCode = exitCode;
    if (task.status !== "stopped") {
      task.status = exitCode === 0 ? "completed" : "failed";
    }
    task.finishedAt = Date.now();
    this.states.delete(taskId);
    await this.notifyCompletion(task);
  }

  /**
   * Restart a dead agent task on demand (e.g. a write hit a broken pipe).
   *
   * This is the single chokepoint for the restart limit — every restart path
   * funnels through here, so it can never exceed `MAX_RESTARTS`. Before
   * spawning the replacement it reaps any lingering old child (mirroring
   * Python's `_restart_agent_task`, which awaits the prior waiter), so we never
   * leak an un-reaped subprocess.
   */
  private async restartAgentProcess(task: DetachedProcessExecution): Promise<RunState> {
    if (task.command == null && task.argv == null) {
      throw new Error(`Task ${task.id} does not have a restart command or argv`);
    }
    const restartCount = parseInt(task.metadata.restart_count ?? "0", 10) + 1;
    if (restartCount > MAX_RESTARTS) {
      task.metadata.status_note = `Agent task restart limit (${MAX_RESTARTS}) reached.`;
      throw new Error(`Task ${task.id} exceeded restart limit (${MAX_RESTARTS})`);
    }

    // Reap any still-tracked previous child before spawning a replacement so we
    // never leave an orphaned subprocess behind.
    const prev = this.states.get(task.id);
    if (prev) {
      // Bump generation so the old child's exit watcher does not clobber state.
      this.generations.set(task.id, (this.generations.get(task.id) ?? 0) + 1);
      this.states.delete(task.id);
      await terminateProcess(prev.child, STOP_GRACE_MS);
    }

    task.metadata.restart_count = String(restartCount);
    task.metadata.status_note = "Task restarted; prior interactive context was not preserved.";
    task.status = "running";
    task.startedAt = Date.now();
    task.finishedAt = undefined;
    task.exitCode = undefined;
    if (task.outputFile) {
      try {
        appendBoundedOutput(task.outputFile, RESTART_NOTICE);
      } catch {
        /* ignore */
      }
    }
    return this.startProcess(task.id);
  }

  private async notifyCompletion(task: DetachedProcessExecution): Promise<void> {
    const snapshot: DetachedProcessExecution = { ...task, metadata: { ...task.metadata } };
    for (const listener of [...this.completionListeners.values()]) {
      try {
        await listener(snapshot);
      } catch {
        /* a failing listener must not break others */
      }
    }
    // Terminal state is also a lifecycle event: drive the (symmetric) task
    // listeners from the same chokepoint so the two notification paths can
    // never diverge. Reuse the same immutable snapshot.
    this.notifyExecutionEvent(snapshot, "completed");
  }

  /**
   * Fan a lifecycle event out to every registered process-execution listener using an
   * immutable snapshot. A throwing listener is isolated and never blocks the
   * others. Synchronous on purpose so `created` fires before the caller of a
   * create method observes the returned task.
   */
  private notifyExecutionEvent(task: DetachedProcessExecution, event: ExecutionEvent): void {
    const snapshot: DetachedProcessExecution = { ...task, metadata: { ...task.metadata } };
    for (const listener of [...this.executionListeners.values()]) {
      try {
        const r = listener(snapshot, event);
        // A listener may be async; swallow its rejection so it can't surface as
        // an unhandled rejection and so one slow/failing listener can't break
        // the others.
        if (r && typeof (r as Promise<void>).then === "function") {
          (r as Promise<void>).catch(() => {});
        }
      } catch {
        /* a failing listener must not break others */
      }
    }
  }
}

function adaptEnvironmentProcess(process: EnvironmentProcess): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const mutable = child as unknown as {
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
  };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      try {
        process.write(chunk);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      process.end();
      callback();
    },
  });
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  mutable.pid = process.pid;
  mutable.exitCode = null;
  mutable.signalCode = null;
  mutable.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    mutable.killed = true;
    void process.signal(signal === "SIGINT" ? "interrupt" : "terminate");
    return true;
  }) as ChildProcess["kill"];
  const stop = process.onOutput((chunk) => stdout.write(chunk));
  const stopErrors = process.onErrorOutput?.((chunk) => stderr.write(chunk));
  void process.wait().then((result) => {
    stop();
    stopErrors?.();
    mutable.exitCode = result.exitCode;
    stdout.end();
    stderr.end();
    child.emit("close", result.exitCode, result.signal ?? null);
    child.emit("exit", result.exitCode, result.signal ?? null);
  }).catch((error) => {
    stop();
    stopErrors?.();
    stdout.end();
    stderr.end();
    child.emit("error", error);
    child.emit("close", 1, null);
    child.emit("exit", 1, null);
  });
  return child;
}

// ── helpers ───────────────────────────────────────────────

/** A task in a terminal state will receive no further status transitions. */
function isTerminal(status: ExecutionStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

function defaultTasksDir(): string {
  try {
    return getTasksDir();
  } catch {
    return join(process.cwd(), PROJECT_CONFIG_DIR_NAME, "tasks");
  }
}

/** Write a frame to stdin, resolving on flush or rejecting on a pipe error. */
function writeToStdin(stdin: NodeJS.WritableStream, payload: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stdin.write(payload, (err) => (err ? reject(err) : resolve()));
  });
}

/** Serialize one worker input as a single newline-terminated frame. */
function encodeWorkerPayload(data: string): string {
  const stripped = data.replace(/\n+$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
    return stripped + "\n";
  }
  if (!stripped.includes("\n") && !stripped.includes("\r")) {
    return stripped + "\n";
  }
  return JSON.stringify({ text: stripped }) + "\n";
}

/** SIGTERM, then SIGKILL after `graceMs`. Resolves when the child has exited. */
function terminateProcess(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return (async () => {
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    await terminateProcessTree(child, "SIGTERM").catch(() => false);
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (await waitForProcessExit(child, graceMs)) return;
    await terminateProcessTree(child, "SIGKILL").catch(() => false);
    await waitForProcessExit(child, 200);
  })();
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

/** Force-kill a process and its children, cross-platform. */
function killProcessTree(child: ChildProcess): void {
  signalProcessTree(child, "SIGKILL");
}
