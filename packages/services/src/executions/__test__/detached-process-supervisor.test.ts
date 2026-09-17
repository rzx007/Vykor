import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDetachedProcessSupervisor, resetExecutionRuntimes, DetachedProcessSupervisor } from "../index.js";
import { resolveSandboxPolicy } from "@openharness/sandbox";

const NODE = process.execPath;
const NODE_COMMAND = JSON.stringify(NODE);
let testConfigDir: string;
let previousConfigDir: string | undefined;

beforeAll(() => {
  previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
  testConfigDir = mkdtempSync(join(tmpdir(), "oh-execution-config-"));
  process.env.OPENHARNESS_CONFIG_DIR = testConfigDir;
});
afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
  else process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
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
  resetExecutionRuntimes();
  while (managers.length) {
    const mgr = managers.pop()!;
    await mgr.aclose().catch(() => {});
  }
});

describe("scoped DetachedProcessSupervisor", () => {
  it("returns isolated managers per cwd", () => {
    const cwdA = join(tempTasksDir(), "repo-a");
    const cwdB = join(tempTasksDir(), "repo-b");
    const first = getDetachedProcessSupervisor(cwdA);
    const second = getDetachedProcessSupervisor(cwdA);
    const other = getDetachedProcessSupervisor(cwdB);

    expect(first).toBe(second);
    expect(first).not.toBe(other);

    resetExecutionRuntimes(cwdA);
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

    resetExecutionRuntimes({ cwd, sessionId: "s-a" });
    expect(getDetachedProcessSupervisor({ cwd, sessionId: "s-a" })).not.toBe(sessionA);
    expect(getDetachedProcessSupervisor({ cwd, sessionId: "s-b" })).toBe(sessionB);

    resetExecutionRuntimes(cwd);
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
    expect(mgr.readOutput(task.id)).toContain("boom");
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

  it("restarts a dead agent on write (broken pipe) and bounds restarts by the limit", async () => {
    const mgr = makeManager();
    // Agent that reads one line, echoes it, then exits — so each write after the
    // first lands on a dead process and forces a lazy restart.
    const script =
      "let b='';process.stdin.on('data',d=>{b+=d;const i=b.indexOf('\\n');" +
      "if(i>=0){process.stdout.write('echo:'+b.slice(0,i)+'\\n');process.exit(0);}});";
    const task = await mgr.startAgentProcess({
      prompt: "first",
      description: "restart-on-write agent",
      cwd: process.cwd(),
      argv: [NODE, "-e", script],
    });
    // Wait for the initial process to consume the prompt and exit.
    await waitFor(() => mgr.getExecution(task.id)!.status === "completed");
    expect(parseInt(mgr.getExecution(task.id)!.metadata.restart_count ?? "0", 10)).toBe(0);

    // Each subsequent write must lazily restart the dead agent. Drive it past
    // the restart limit (5) so the (limit+1)-th write rejects.
    let rejected = false;
    for (let i = 0; i < 7; i++) {
      try {
        await mgr.writeInput(task.id, `msg-${i}`);
        // Let the freshly spawned child consume the line and exit again.
        await waitFor(() => mgr.getExecution(task.id)!.status === "completed", 5000);
      } catch (e) {
        rejected = true;
        expect((e as Error).message).toMatch(/restart limit/);
        break;
      }
    }
    expect(rejected).toBe(true);
    expect(parseInt(mgr.getExecution(task.id)!.metadata.restart_count ?? "0", 10)).toBe(5);
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
    expect(created!.status).toBe("running");
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
