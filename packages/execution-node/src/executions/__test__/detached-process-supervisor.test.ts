import { beforeEach as setupOwner } from "vitest";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DetachedProcessSupervisor, ExecutionRuntimeOwner } from "../index.js";
import { resolveSandboxPolicy } from "@vykor/sandbox";
import type { ShellAdmissionPorts, StartShellExecutionOptions } from "../types.js";

const NODE = process.execPath;
const NODE_COMMAND = JSON.stringify(NODE);
let testConfigDir: string;
let previousConfigDir: string | undefined;

beforeAll(() => {
  previousConfigDir = process.env.VYKOR_CONFIG_DIR;
  testConfigDir = mkdtempSync(join(tmpdir(), "oh-execution-config-"));
  process.env.VYKOR_CONFIG_DIR = testConfigDir;
});
afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
  else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
  rmSync(testConfigDir, { recursive: true, force: true });
});

function tempTasksDir(): string {
  return mkdtempSync(join(tmpdir(), "oh-tasks-"));
}

/** Probe whether a pid is still alive. `kill(pid, 0)` performs no signalling. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH => no such process. EPERM => alive but not ours (treat as alive).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const managers: DetachedProcessSupervisor[] = [];
function makeManager(): DetachedProcessSupervisor {
  const mgr = new DetachedProcessSupervisor(tempTasksDir());
  managers.push(mgr);
  return mgr;
}

afterEach(async () => {
  await owner.closeScope();
  while (managers.length) {
    const mgr = managers.pop()!;
    await mgr.aclose().catch(() => {});
  }
  await owner.close();
});

describe("scoped DetachedProcessSupervisor", () => {
  it("keeps stopping after a kill fault and settles when the same real process later exits", async () => {
    const supervisor = makeManager();
    const task = await supervisor.startShellExecution({ argv: [NODE, "-e", "setInterval(() => {}, 1000)"], cwd: process.cwd(), description: "stop fault" });
    const state = (supervisor as any).states.get(task.id);
    const terminate = (supervisor as any).terminateState.bind(supervisor);
    const fault = vi.spyOn(supervisor as any, "terminateState").mockRejectedValueOnce(new Error("controlled kill failure"));
    await expect(supervisor.stopExecution(task.id)).rejects.toThrow("controlled kill failure");
    expect(supervisor.getExecution(task.id)?.status).toBe("stopping");
    fault.mockRestore();
    await terminate(state);
    await waitFor(() => supervisor.getExecution(task.id)?.status === "stopped");
  });

  it("does not publish stopped until the real process output drain is confirmed", async () => {
    const supervisor = makeManager();
    const task = await supervisor.startShellExecution({ argv: [NODE, "-e", "process.stdout.write('before-stop'); setInterval(() => {}, 1000)"], cwd: process.cwd(), description: "drain" });
    let drained!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { drained = resolve; });
    const entered = new Promise<void>(resolve => { observed = resolve; });
    const terminate = (supervisor as any).terminateState.bind(supervisor);
    const fault = vi.spyOn(supervisor as any, "terminateState").mockImplementation(async (state) => { await terminate(state); observed(); await gate; });
    const stopping = supervisor.stopExecution(task.id);
    try {
      await entered;
      expect(supervisor.getExecution(task.id)?.status).toBe("stopping");
      drained();
      expect((await stopping).status).toBe("stopped");
    } finally { drained(); fault.mockRestore(); await stopping; }
  });

  it("does not spawn when cancelled before environment admission", async () => {
    const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
    const requested = gate(), environment = gate();
    const supervisor = makeManager();
    const invoke = vi.fn(async () => { throw new Error("must not spawn"); });
    const released = vi.fn(async () => undefined);
    const options: StartShellExecutionOptions & { id: string } = { id: "cancel-before-environment", argv: [process.execPath, "-e", "process.exit(0)"], cwd: process.cwd(), sessionId: "s", description: "controlled environment", processExecutor: { execShell: invoke, execProcess: invoke } };
    const ports: ShellAdmissionPorts = { reserve: async () => undefined, load: async () => undefined, save: async () => undefined,
      acquireEnvironment: async input => { requested.resolve(); await environment.promise; return { launch: input, release: released }; } };
    const started = supervisor.startShellExecution(options, ports);
    const outcome = Promise.allSettled([started]);
    await requested.promise;
    const stopping = supervisor.stopExecution(options.id);
    expect(supervisor.getExecution(options.id)?.status).not.toBe("stopped");
    environment.resolve();
    await Promise.all([outcome, stopping]);
    expect(invoke).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledTimes(1);
  });
  it("returns isolated managers per cwd", async () => {
    const cwdA = join(tempTasksDir(), "repo-a");
    const cwdB = join(tempTasksDir(), "repo-b");
    const first = getDetachedProcessSupervisor(cwdA);
    const second = getDetachedProcessSupervisor(cwdA);
    const other = getDetachedProcessSupervisor(cwdB);

    expect(first).toBe(second);
    expect(first).not.toBe(other);

    await resetExecutionRuntimes(cwdA);
    expect(getDetachedProcessSupervisor(cwdA)).not.toBe(first);
    expect(getDetachedProcessSupervisor(cwdB)).toBe(other);
  });

  it("isolates managers and task lists per session within the same cwd", async () => {
    const cwd = join(tempTasksDir(), "repo");
    const sessionA = getDetachedProcessSupervisor({ cwd, sessionId: "s-a" });
    const sameSessionA = getDetachedProcessSupervisor({ cwd, sessionId: "s-a" });
    const sessionB = getDetachedProcessSupervisor({ cwd, sessionId: "s-b" });
    const cwdOnly = getDetachedProcessSupervisor(cwd);

    expect(sessionA).toBe(sameSessionA);
    expect(sessionA).not.toBe(sessionB);
    expect(sessionA).not.toBe(cwdOnly);

    const task = await sessionA.startShellExecution({
      argv: [NODE, "-e", "process.stdout.write('session-a')"],
      description: "session scoped",
      cwd,
      sessionId: "s-a",
    });
    expect(task.sessionId).toBe("s-a");
    expect(sessionA.listExecutions()).toHaveLength(1);
    expect(sessionB.listExecutions()).toHaveLength(0);
    expect(cwdOnly.listExecutions()).toHaveLength(0);

    await resetExecutionRuntimes({ cwd, sessionId: "s-a" });
    expect(getDetachedProcessSupervisor({ cwd, sessionId: "s-a" })).not.toBe(sessionA);
    expect(getDetachedProcessSupervisor({ cwd, sessionId: "s-b" })).toBe(sessionB);

    await resetExecutionRuntimes(cwd);
    expect(getDetachedProcessSupervisor({ cwd, sessionId: "s-b" })).not.toBe(sessionB);
  });
});

describe("DetachedProcessSupervisor real execution", () => {
  it("keeps a background shell on the supplied execution environment", async () => {
    const mgr = makeManager();
    const task = await mgr.startShellExecution({
      command: "pwd",
      description: "environment shell",
      cwd: "/mnt/d/repo",
      processExecutor: {
        execShell: async () => environmentProcess("/mnt/d/repo\n"),
        execProcess: async () => environmentProcess(""),
      },
    });

    await waitFor(() => mgr.getExecution(task.id)?.status === "completed");
    expect(mgr.readOutput(task.id)).toBe("/mnt/d/repo\n");
  });

  it("starts one process for concurrent requests with the same explicit job id", async () => {
    const mgr = makeManager();
    const options = {
      id: "task-idempotent",
      argv: [NODE, "-e", "setTimeout(() => process.stdout.write('once'), 50)"],
      description: "idempotent shell",
      cwd: process.cwd(),
      sessionId: "session-1",
    };

    const [first, retry] = await Promise.all([
      mgr.startShellExecution(options),
      mgr.startShellExecution(options),
    ]);

    expect(retry).toBe(first);
    expect(mgr.listExecutions()).toHaveLength(1);
    await waitFor(() => mgr.getExecution(first.id)?.status === "completed");
    expect(mgr.readOutput(first.id)).toContain("once");
  });

  it("returns a completed task when its exact start request is retried", async () => {
    const mgr = makeManager();
    const options = {
      id: "task-short-retry",
      argv: [NODE, "-e", "process.stdout.write('done')"],
      description: "short shell",
      cwd: process.cwd(),
    };
    const first = await mgr.startShellExecution(options);
    await waitFor(() => mgr.getExecution(first.id)?.status === "completed");

    await expect(mgr.startShellExecution(options)).resolves.toBe(first);
    expect(mgr.listExecutions()).toHaveLength(1);
  });

  it("rejects a reused job id when immutable start parameters differ", async () => {
    const mgr = makeManager();
    const common = { id: "task-conflict", description: "shell", cwd: process.cwd() };
    const first = await mgr.startShellExecution({ ...common, argv: [NODE, "-e", "0"] });

    await expect(mgr.startShellExecution({ ...common, argv: [NODE, "-e", "1"] }))
      .rejects.toThrow("request identity conflict");
    await waitFor(() => mgr.getExecution(first.id)?.status === "completed");
  });

  it("records a failed task and rejects when strict SRT sandbox is unavailable", async () => {
    const mgr = makeManager();
    let failure = "";
    await mgr.startShellExecution({
      command: "echo must-not-run-on-host",
      description: "strict sandbox",
      cwd: process.cwd(),
      sessionId: "strict-session",
      settings: {
        model: "test",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        sandbox: { enabled: true, failIfUnavailable: true },
      },
    }).catch((error) => { failure = error instanceof Error ? error.message : String(error); });
    expect(failure).toBeTruthy();

    const [task] = mgr.listExecutions("failed");
    expect(task).toMatchObject({
      status: "failed",
      exitCode: 1,
      metadata: { status_note: failure },
    });
    expect(task?.processExitCode).toBeUndefined();
    expect(mgr.readOutput(task!.id)).toContain("[spawn error]");
  });

  it("uses an explicit task policy instead of re-resolving strict settings", async () => {
    const mgr = makeManager();
    const policy = resolveSandboxPolicy({ cwd: process.cwd(), config: { enabled: false } });
    const task = await mgr.startShellExecution({
      argv: [NODE, "-e", "process.stdout.write('task-policy-ok')"],
      description: "explicit policy",
      cwd: process.cwd(),
      policy,
      settings: {
        model: "test",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        sandbox: { enabled: true, failIfUnavailable: true },
      },
    });

    await waitFor(() => mgr.getExecution(task.id)?.status === "completed");
    expect(mgr.readOutput(task.id)).toContain("task-policy-ok");
  });

  it("forwards an explicit policy through agent task creation", async () => {
    const mgr = makeManager();
    const policy = resolveSandboxPolicy({ cwd: process.cwd(), config: { enabled: false } });
    const task = await mgr.startAgentProcess({
      prompt: "run",
      description: "agent explicit policy",
      cwd: process.cwd(),
      argv: [
        NODE,
        "-e",
        "process.stdin.once('data',()=>{process.stdout.write('agent-policy-ok');process.exit(0)})",
      ],
      policy,
      settings: {
        model: "test",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        sandbox: { enabled: true, failIfUnavailable: true },
      },
    });

    await waitFor(() => mgr.getExecution(task.id)?.status === "completed");
    expect(mgr.readOutput(task.id)).toContain("agent-policy-ok");
  });

  it("runs a shell task and captures output to the log file", async () => {
    const mgr = makeManager();
    const task = await mgr.startShellExecution(
      `${NODE_COMMAND} -e "process.stdout.write('hello-shell')"`,
      "echo via node",
      process.cwd(),
    );
    expect(task.status).toBe("running");
    expect(task.outputFile).toBeTruthy();
    await waitFor(() => mgr.getExecution(task.id)!.status === "completed");
    const out = mgr.readOutput(task.id);
    expect(out).toContain("hello-shell");
    expect(mgr.getExecution(task.id)!.exitCode).toBe(0);
  });

  it("captures stderr and marks non-zero exit as failed", async () => {
    const mgr = makeManager();
    const task = await mgr.startShellExecution({
      argv: [NODE, "-e", "process.stderr.write('boom'); process.exit(3)"],
      description: "failing task",
      cwd: process.cwd(),
    });
    await waitFor(() => mgr.getExecution(task.id)!.status === "failed");
    expect(mgr.getExecution(task.id)!.exitCode).toBe(3);
    expect(mgr.getExecution(task.id)!.processExitCode).toBe(3);
    expect(mgr.readOutput(task.id)).toContain("boom");
  });

  it("keeps a signal exit distinct from the compatible synthetic code", async () => {
    const mgr = makeManager();
    const task = await mgr.startShellExecution({
      command: "signal",
      description: "signal exit",
      cwd: process.cwd(),
      processExecutor: {
        execShell: async () => ({ ...environmentProcess(""), wait: async () => ({ exitCode: null, signal: "SIGTERM" as const }) }),
        execProcess: async () => environmentProcess(""),
      },
    });
    await waitFor(() => mgr.getExecution(task.id)?.status === "failed");
    expect(mgr.getExecution(task.id)).toMatchObject({ exitCode: 1, processExitCode: null });
  });

  it("leaves raw exit unknown when a process adapter fails to wait", async () => {
    const mgr = makeManager();
    const task = await mgr.startShellExecution({
      command: "fail",
      description: "adapter failure",
      cwd: process.cwd(),
      processExecutor: {
        execShell: async () => ({ ...environmentProcess(""), wait: async () => { throw new Error("wait failed"); } }),
        execProcess: async () => environmentProcess(""),
      },
    });
    await waitFor(() => mgr.getExecution(task.id)?.status === "failed");
    expect(mgr.getExecution(task.id)?.exitCode).toBe(1);
    expect(mgr.getExecution(task.id)?.processExitCode).toBeUndefined();
  });

  it("runs an argv (direct-exec) task without a shell", async () => {
    const mgr = makeManager();
    const task = await mgr.startShellExecution({
      argv: [NODE, "-e", "process.stdout.write('argv-out')"],
      description: "argv task",
      cwd: process.cwd(),
    });
    await waitFor(() => mgr.getExecution(task.id)!.status === "completed");
    expect(mgr.readOutput(task.id)).toContain("argv-out");
  });

  it("writes to task stdin and the child echoes it back", async () => {
    const mgr = makeManager();
    // Reads one line from stdin and echoes it, then exits.
    const script =
      "let buf='';process.stdin.on('data',d=>{buf+=d;const i=buf.indexOf('\\n');" +
      "if(i>=0){process.stdout.write('got:'+buf.slice(0,i));process.exit(0);}});";
    const task = await mgr.startShellExecution({
      argv: [NODE, "-e", script],
      description: "stdin reader",
      cwd: process.cwd(),
    });
    await mgr.writeInput(task.id, "ping");
    await waitFor(() => mgr.getExecution(task.id)!.status === "completed");
    expect(mgr.readOutput(task.id)).toContain("got:ping");
  });

  it("wraps multi-line stdin payloads as a single JSON frame", async () => {
    const mgr = makeManager();
    const script =
      "let buf='';process.stdin.on('data',d=>{buf+=d;const i=buf.indexOf('\\n');" +
      "if(i>=0){process.stdout.write(buf.slice(0,i));process.exit(0);}});";
    const task = await mgr.startShellExecution({
      argv: [NODE, "-e", script],
      description: "stdin json frame",
      cwd: process.cwd(),
    });
    await mgr.writeInput(task.id, "line1\nline2");
    await waitFor(() => mgr.getExecution(task.id)!.status === "completed");
    const out = mgr.readOutput(task.id);
    const parsed = JSON.parse(out.trim());
    expect(parsed.text).toBe("line1\nline2");
  });

  it("fires completion listeners on terminal state", async () => {
    const mgr = makeManager();
    const seen: string[] = [];
    mgr.registerCompletionListener((t) => {
      seen.push(`${t.id}:${t.status}`);
    });
    const task = await mgr.startShellExecution(
      `${NODE_COMMAND} -e "process.exit(0)"`,
      "completes",
      process.cwd(),
    );
    await waitFor(() => seen.length > 0);
    expect(seen).toContain(`${task.id}:completed`);
  });

  it("unregister stops further listener notifications", async () => {
    const mgr = makeManager();
    let count = 0;
    const unregister = mgr.registerCompletionListener(() => {
      count++;
    });
    unregister();
    await mgr.startShellExecution(`${NODE_COMMAND} -e "process.exit(0)"`, "x", process.cwd());
    await new Promise((r) => setTimeout(r, 300));
    expect(count).toBe(0);
  });

  it("stops a long-running task and terminates the process", async () => {
    const mgr = makeManager();
    const seen: string[] = [];
    mgr.registerCompletionListener((t) => seen.push(t.status));
    const task = await mgr.startShellExecution(
      `${NODE_COMMAND} -e "setInterval(()=>{},1000)"`,
      "long runner",
      process.cwd(),
    );
    expect(mgr.getExecution(task.id)!.status).toBe("running");
    const stopped = await mgr.stopExecution(task.id);
    expect(stopped.status).toBe("stopped");
    expect(seen).toContain("stopped");
  });

  it("stopping a shell task kills shell-spawned grandchildren (whole process tree)", async () => {
    const mgr = makeManager();
    const dir = tempTasksDir();
    const pidFile = join(dir, "grandchild.pid");
    const readyFile = join(dir, "ready");

    // A node grandchild that records its own pid, signals readiness, and then
    // sleeps forever. It inherits the task process group, so killing only the
    // direct parent would leave it orphaned and alive.
    const grandchildJs =
      `const fs=require('fs');` +
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      `fs.writeFileSync(${JSON.stringify(readyFile)}, '1');` +
      `setInterval(()=>{},1000);`;

    let command: string;
    if (process.platform === "win32") {
      command =
        `start /b "" "${NODE}" -e "${grandchildJs.replace(/"/g, '""')}" & ` +
        `"${NODE}" -e "setInterval(()=>{},1000)"`;
    } else {
      command =
        `'${NODE}' -e '${grandchildJs.replace(/'/g, "'\\''")}' & ` +
        `'${NODE}' -e 'setInterval(()=>{},1000)'`;
    }

    const task = await mgr.startShellExecution(command, "tree with grandchild", process.cwd());
    await waitFor(() => existsSync(pidFile) && existsSync(readyFile), 8000);
    const grandPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    expect(Number.isFinite(grandPid)).toBe(true);

    await mgr.stopExecution(task.id);

    // After stop, the grandchild must no longer be alive. On POSIX we probe via
    // signal 0; on Windows the process-group kill is exercised through the same
    // stop path (taskkill /T), and we likewise verify the pid is gone.
    await waitFor(() => !isAlive(grandPid), 8000);
    expect(isAlive(grandPid)).toBe(false);
  });

  it("does NOT auto-restart an agent task that exits on its own (mirrors Python _watch_process)", async () => {
    const mgr = makeManager();
    // Agent task whose argv exits non-zero immediately. Python's _watch_process
    // only records terminal state; it never proactively restarts on exit.
    const task = await mgr.startAgentProcess({
      prompt: "go",
      description: "crash-on-exit agent",
      cwd: process.cwd(),
      argv: [NODE, "-e", "process.exit(1)"],
    });
    await waitFor(() => mgr.getExecution(task.id)!.status === "failed");
    // Give any (incorrect) restart loop a window to fire — it must not.
    await new Promise((r) => setTimeout(r, 400));
    const t = mgr.getExecution(task.id)!;
    expect(t.status).toBe("failed");
    expect(t.exitCode).toBe(1);
    // No restart was triggered by the exit itself.
    expect(parseInt(t.metadata.restart_count ?? "0", 10)).toBe(0);
  });

  it("rejects input for a completed process without restarting its execution identity", async () => {
    const mgr = makeManager();
    const task = await mgr.startAgentProcess({ argv: [NODE, "-e", "process.stdout.write('finished')"], prompt: "first", description: "explicit process", cwd: process.cwd() });
    await mgr.awaitExecution(task.id);
    const before = { ...task };
    await expect(mgr.writeInput(task.id, "late")).rejects.toThrow("does not accept input");
    expect(mgr.getExecution(task.id)).toEqual(before);
    expect(mgr.listExecutions()).toHaveLength(1);
  });

  it("agent task without argv/command is failed with needs-argv, not pending", async () => {
    const mgr = makeManager();
    const task = await mgr.startAgentProcess("do work", "no argv", process.cwd());
    expect(task.status).toBe("failed");
    expect(task.metadata.needs_argv).toBe("1");
    expect(mgr.readOutput(task.id)).toContain("argv");
  });

  it("agent task with argv spawns and runs", async () => {
    const mgr = makeManager();
    const task = await mgr.startAgentProcess({
      prompt: "hi-agent",
      description: "agent argv",
      cwd: process.cwd(),
      // Reads the forwarded prompt from stdin and echoes it.
      argv: [
        NODE,
        "-e",
        "let b='';process.stdin.on('data',d=>{b+=d;const i=b.indexOf('\\n');if(i>=0){process.stdout.write('agent:'+b.slice(0,i));process.exit(0);}});",
      ],
    });
    expect(task.type).toBe("agent");
    await waitFor(() => mgr.getExecution(task.id)!.status === "completed");
    expect(mgr.readOutput(task.id)).toContain("agent:hi-agent");
  });

  it("aclose terminates all running tasks", async () => {
    const mgr = new DetachedProcessSupervisor(tempTasksDir());
    const t1 = await mgr.startShellExecution(
      `${NODE_COMMAND} -e "setInterval(()=>{},1000)"`,
      "runner 1",
      process.cwd(),
    );
    expect(mgr.getExecution(t1.id)!.status).toBe("running");
    await mgr.aclose();
    // No more tracked processes — a subsequent stop reports not-running terminal handling.
    // The task record is retained but the process is gone.
    expect(mgr.getExecution(t1.id)).toBeTruthy();
  });

  it("throws when neither command nor argv is provided to startShellExecution", async () => {
    const mgr = makeManager();
    await expect(
      mgr.startShellExecution({ description: "empty", cwd: process.cwd() }),
    ).rejects.toThrow(/command or argv/);
  });

  it("writeInput rejects for a non-agent task whose process has exited", async () => {
    const mgr = makeManager();
    const task = await mgr.startShellExecution(
      `${NODE_COMMAND} -e "process.exit(0)"`,
      "short",
      process.cwd(),
    );
    await waitFor(() => mgr.getExecution(task.id)!.status === "completed");
    await expect(mgr.writeInput(task.id, "late")).rejects.toThrow(/does not accept input/);
  });
});

function environmentProcess(output: string) {
  return {
    write() {},
    end() {},
    onOutput(listener: (chunk: Uint8Array) => void) {
      setImmediate(() => listener(Buffer.from(output)));
      return () => {};
    },
    async wait() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { exitCode: 0 };
    },
    async signal() {},
  };
}

describe("DetachedProcessSupervisor.awaitExecution", () => {
  it("rejects an unreadable completed log without inventing a write failure", async () => {
    const directory = tempTasksDir();
    const mgr = new DetachedProcessSupervisor(directory);
    try {
      const task = await mgr.startShellExecution({ argv: [NODE, "-e", "process.stdout.write('already finished')"],
        description: "read failure", cwd: process.cwd() });
      await waitFor(() => mgr.getExecution(task.id)?.status === "completed");
      renameSync(task.outputFile!, `${task.outputFile}.old`);
      mkdirSync(task.outputFile!);
      await expect(mgr.awaitExecution(task.id)).rejects.toThrow(/EISDIR|directory/i);
      expect(mgr.getExecution(task.id)).toMatchObject({ status: "completed", exitCode: 0 });
      expect(mgr.getExecution(task.id)?.metadata.outputWriteFailed).toBeUndefined();
    } finally { await mgr.aclose(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects unreadable output from a pending completion listener and timeout", async () => {
    const directory = tempTasksDir();
    const mgr = new DetachedProcessSupervisor(directory);
    try {
      const ending = await mgr.startShellExecution({ argv: [NODE, "-e", "process.stdout.write('started'); setTimeout(() => process.exit(0), 350)"],
        description: "listener read failure", cwd: process.cwd() });
      await waitFor(() => mgr.readOutput(ending.id).includes("started"));
      renameSync(ending.outputFile!, `${ending.outputFile}.old`);
      mkdirSync(ending.outputFile!);
      await expect(mgr.awaitExecution(ending.id, { timeoutMs: 2000 })).rejects.toThrow(/EISDIR|directory/i);
      expect(mgr.getExecution(ending.id)).toMatchObject({ status: "completed", exitCode: 0 });
      expect(mgr.getExecution(ending.id)?.metadata.outputWriteFailed).toBeUndefined();

      const waiting = await mgr.startShellExecution({ argv: [NODE, "-e", "setInterval(() => {}, 1000)"],
        description: "timeout read failure", cwd: process.cwd() });
      renameSync(waiting.outputFile!, `${waiting.outputFile}.old`);
      mkdirSync(waiting.outputFile!);
      await expect(mgr.awaitExecution(waiting.id, { timeoutMs: 100 })).rejects.toThrow(/EISDIR|directory/i);
      expect(mgr.getExecution(waiting.id)?.status).toBe("running");
      expect(mgr.getExecution(waiting.id)?.metadata.outputWriteFailed).toBeUndefined();
    } finally { await mgr.aclose(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("returns immediately for an already-terminal task with its output/status", async () => {
    const mgr = makeManager();
    const task = await mgr.startShellExecution(
      `${NODE_COMMAND} -e "process.stdout.write('done-out'); process.exit(0)"`,
      "fast",
      process.cwd(),
    );
    await waitFor(() => mgr.getExecution(task.id)!.status === "completed");
    const res = await mgr.awaitExecution(task.id);
    expect(res.status).toBe("completed");
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("done-out");
    expect(res.timedOut).toBeUndefined();
  });

  it("resolves with failed status for a non-zero exit", async () => {
    const mgr = makeManager();
    const task = await mgr.startShellExecution({
      argv: [NODE, "-e", "process.stderr.write('nope'); process.exit(2)"],
      description: "fails",
      cwd: process.cwd(),
    });
    await waitFor(() => mgr.getExecution(task.id)!.status === "failed");
    const res = await mgr.awaitExecution(task.id);
    expect(res.status).toBe("failed");
    expect(res.exitCode).toBe(2);
    expect(res.output).toContain("nope");
  });

  it("resolves when a still-running task completes", async () => {
    const mgr = makeManager();
    // Sleep briefly, then emit output and exit — task is running at await time.
    const task = await mgr.startShellExecution(
      `${NODE_COMMAND} -e "setTimeout(()=>{process.stdout.write('late-out');process.exit(0);},300)"`,
      "slow",
      process.cwd(),
    );
    expect(mgr.getExecution(task.id)!.status).toBe("running");
    const res = await mgr.awaitExecution(task.id);
    expect(res.status).toBe("completed");
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("late-out");
    expect(res.timedOut).toBeUndefined();
  });

  it("returns timedOut:true for a long-running task that exceeds timeoutMs", async () => {
    const mgr = makeManager();
    const task = await mgr.startShellExecution(
      `${NODE_COMMAND} -e "setInterval(()=>{},1000)"`,
      "long",
      process.cwd(),
    );
    const res = await mgr.awaitExecution(task.id, { timeoutMs: 200 });
    expect(res.timedOut).toBe(true);
    expect(res.status).toBe("running");
    // Still running after the timeout — not yet terminal.
    expect(mgr.getExecution(task.id)!.status).toBe("running");
  });

  it("does not resolve early before the timeout when the task keeps running", async () => {
    const mgr = makeManager();
    const task = await mgr.startShellExecution(
      `${NODE_COMMAND} -e "setInterval(()=>{},1000)"`,
      "long2",
      process.cwd(),
    );
    const start = Date.now();
    const res = await mgr.awaitExecution(task.id, { timeoutMs: 250 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  });

  it("throws for an unknown taskId", () => {
    const mgr = makeManager();
    expect(() => mgr.awaitExecution("task_does_not_exist")).toThrow(/not found/i);
  });
});

describe("DetachedProcessSupervisor.registerExecutionListener", () => {
  it("reports actual tail discard once while running and final bytes at completion", async () => {
    const directory = tempTasksDir();
    const mgr = new DetachedProcessSupervisor(directory);
    try {
      const events: Array<{ event: string; discarded?: string }> = [];
      mgr.registerExecutionListener((task, event) => events.push({ event, discarded: task.metadata.outputDiscardedBytes }));
      const task = await mgr.startShellExecution({
        argv: [NODE, "-e", "process.stdout.write('a'.repeat(10 * 1024 * 1024 + 31))"],
        description: "large output", cwd: process.cwd(),
      });
      await waitFor(() => mgr.getExecution(task.id)?.status === "completed", 10_000);
      expect(Number(mgr.getExecution(task.id)?.metadata.outputDiscardedBytes)).toBe(31);
      expect(events.filter((item) => item.event === "updated")).toEqual([{ event: "updated", discarded: "31" }]);
      expect(events.at(-1)).toEqual({ event: "completed", discarded: "31" });
      expect(mgr.readOutput(task.id, 32)).toBe("a".repeat(32));
    } finally { await mgr.aclose(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("reports one write failure without changing the command result", async () => {
    const directory = tempTasksDir();
    const mgr = new DetachedProcessSupervisor(directory);
    try {
      const events: Array<{ event: string; failed?: string }> = [];
      mgr.registerExecutionListener((task, event) => events.push({ event, failed: task.metadata.outputWriteFailed }));
      const task = await mgr.startShellExecution({
        argv: [NODE, "-e", "setTimeout(() => { process.stdout.write('first'); process.stdout.write('second'); }, 300)"],
        description: "write failure", cwd: process.cwd(),
      });
      renameSync(task.outputFile!, `${task.outputFile}.old`);
      mkdirSync(task.outputFile!);
      await waitFor(() => mgr.getExecution(task.id)?.status === "completed", 10_000);
      expect(mgr.getExecution(task.id)).toMatchObject({ exitCode: 0, metadata: { outputWriteFailed: "1" } });
      await expect(mgr.awaitExecution(task.id)).rejects.toThrow(/EISDIR|directory/i);
      expect(events.filter((item) => item.event === "updated")).toEqual([{ event: "updated", failed: "1" }]);
      expect(events.at(-1)).toEqual({ event: "completed", failed: "1" });
    } finally { await mgr.aclose(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("fires 'created' when a task is created", async () => {
    const mgr = makeManager();
    const events: Array<{ id: string; event: string; status: string }> = [];
    mgr.registerExecutionListener((t, event) => {
      events.push({ id: t.id, event, status: t.status });
    });
    const task = await mgr.startShellExecution(
      `${NODE_COMMAND} -e "process.exit(0)"`,
      "create-event",
      process.cwd(),
    );
    const created = events.find((e) => e.id === task.id && e.event === "created");
    expect(created).toBeTruthy();
    expect(created!.status).toBe("pending");
  });

  it("fires 'completed' when a task reaches a terminal state", async () => {
    const mgr = makeManager();
    const events: Array<{ id: string; event: string; status: string }> = [];
    mgr.registerExecutionListener((t, event) => {
      events.push({ id: t.id, event, status: t.status });
    });
    const task = await mgr.startShellExecution(
      `${NODE_COMMAND} -e "process.exit(0)"`,
      "complete-event",
      process.cwd(),
    );
    await waitFor(() => events.some((e) => e.id === task.id && e.event === "completed"));
    const completed = events.find((e) => e.id === task.id && e.event === "completed");
    expect(completed!.status).toBe("completed");
  });

  it("the returned unregister callback stops further events", async () => {
    const mgr = makeManager();
    let count = 0;
    const unregister = mgr.registerExecutionListener(() => {
      count++;
    });
    unregister();
    await mgr.startShellExecution(`${NODE_COMMAND} -e "process.exit(0)"`, "x", process.cwd());
    await new Promise((r) => setTimeout(r, 300));
    expect(count).toBe(0);
  });

  it("isolates a throwing listener from the others", async () => {
    const mgr = makeManager();
    const seen: string[] = [];
    mgr.registerExecutionListener(() => {
      throw new Error("boom in listener");
    });
    mgr.registerExecutionListener((t, event) => {
      if (event === "created") seen.push(t.id);
    });
    const task = await mgr.startShellExecution(
      `${NODE_COMMAND} -e "process.exit(0)"`,
      "isolate",
      process.cwd(),
    );
    expect(seen).toContain(task.id);
  });

  it("fires both 'created' and 'completed' for an agent task missing argv (failed early)", async () => {
    const mgr = makeManager();
    const events: string[] = [];
    mgr.registerExecutionListener((_t, event) => events.push(event));
    await mgr.startAgentProcess("do work", "no argv", process.cwd());
    expect(events).toContain("created");
    expect(events).toContain("completed");
  });
});

let owner: ExecutionRuntimeOwner;
setupOwner(() => { owner = new ExecutionRuntimeOwner(); });
function getDetachedProcessSupervisor(scope?: Parameters<ExecutionRuntimeOwner["getDetachedProcessSupervisor"]>[0]) { return owner.getDetachedProcessSupervisor(scope); }
function resetExecutionRuntimes(scope?: Parameters<ExecutionRuntimeOwner["closeScope"]>[0]) { return owner.closeScope(scope); }

it("aborts only the current process observation and leaves the owner able to stop", async () => {
  const manager = makeManager();
  const execution = await manager.startShellExecution({ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], cwd: process.cwd(), description: "observation abort" });
  const controller = new AbortController();
  const observed = manager.awaitExecution(execution.id, { signal: controller.signal });
  const rejected = expect(observed).rejects.toThrow("observer left");
  controller.abort(new Error("observer left"));
  await rejected;
  expect(manager.getExecution(execution.id)?.status).toBe("running");
  await manager.stopExecution(execution.id);
  expect((await manager.awaitExecution(execution.id)).status).toBe("stopped");
});
