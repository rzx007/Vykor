import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionRuntimeOwner,
  DetachedProcessSupervisor,
} from "../index.js";

let cwd: string;
const owners: ExecutionRuntimeOwner[] = [];
const owner = () => {
  const value = new ExecutionRuntimeOwner();
  owners.push(value);
  return value;
};
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "vk-execution-owner-"));
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map((value) => value.close()));
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("host-owned execution resources", () => {
  it("keeps process ownership in the existing supervisor", () => {
    const processes = owner().getDetachedProcessSupervisor(cwd);
    expect(processes).toBeInstanceOf(DetachedProcessSupervisor);
    expect("registerChildExecution" in processes).toBe(false);
  });

  it("reuses each backend within an owner and isolates cwd/session scopes", () => {
    const host = owner(),
      scope = { cwd, sessionId: "same" };
    expect(host.getDetachedProcessSupervisor(scope)).toBe(
      host.getDetachedProcessSupervisor({ cwd: join(cwd, "."), sessionId: " same " }),
    );
    expect(host.getDetachedProcessSupervisor(scope)).not.toBe(
      host.getDetachedProcessSupervisor({ cwd, sessionId: "other" }),
    );
    expect(host.getDetachedProcessSupervisor(scope)).not.toBe(
      host.getDetachedProcessSupervisor(join(cwd, "other")),
    );
  });

  it("isolates two owners with the same cwd, session and execution id, including their log files", async () => {
    const first = owner(),
      second = owner(),
      scope = { cwd, sessionId: "same" };
    const a = first.getDetachedProcessSupervisor(scope),
      b = second.getDetachedProcessSupervisor(scope);
    const input = {
      id: "same",
      argv: [process.execPath, "-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
      cwd,
      description: "owned",
    };
    const [one, two] = await Promise.all([
      a.startShellExecution(input),
      b.startShellExecution(input),
    ]);
    expect(one.outputFile).not.toBe(two.outputFile);
    await vi.waitFor(() => expect(b.readOutput("same")).toBe("ready"));
    await first.close();
    expect(b.getExecution("same")?.status).toBe("running");
    expect(b.readOutput("same")).toBe("ready");
    expect(() => second.getDetachedProcessSupervisor(scope)).not.toThrow();
  });

  it("closes admission immediately, shares one shutdown promise and waits for every scope", async () => {
    const host = owner(),
      scope = { cwd, sessionId: "close" };
    const processes = host.getDetachedProcessSupervisor(scope);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = vi.spyOn(processes, "aclose").mockReturnValue(pending);
    const closing = host.close();
    expect(host.close()).toBe(closing);
    expect(() => host.getDetachedProcessSupervisor(scope)).toThrow(/closed/);
    expect(stop).toHaveBeenCalledOnce();
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await closing;
    expect(finished).toBe(true);
  });

  it("releases just the requested scope and waits for it before allowing reuse", async () => {
    const host = owner(),
      scope = { cwd, sessionId: "a" };
    const before = host.getDetachedProcessSupervisor(scope);
    const other = host.getDetachedProcessSupervisor({ cwd, sessionId: "b" });
    const closing = host.closeScope(scope);
    expect(() => host.getDetachedProcessSupervisor(scope)).toThrow(/closing/);
    await closing;
    expect(host.getDetachedProcessSupervisor(scope)).not.toBe(before);
    expect(host.getDetachedProcessSupervisor({ cwd, sessionId: "b" })).toBe(other);
  });

  it("preserves a previous log when a released scope reuses the same task id", async () => {
    const host = owner(),
      scope = { cwd, sessionId: "reused" };
    const first = host.getDetachedProcessSupervisor(scope);
    const one = await first.startShellExecution({
      cwd,
      id: "same",
      description: "first",
      argv: [process.execPath, "-e", "process.stdout.write('first')"],
    });
    await first.awaitExecution(one.id, { timeoutMs: 5000 });
    await host.closeScope(scope);
    const second = host.getDetachedProcessSupervisor(scope);
    const two = await second.startShellExecution({
      cwd,
      id: "same",
      description: "second",
      argv: [process.execPath, "-e", "process.stdout.write('second')"],
    });
    await second.awaitExecution(two.id, { timeoutMs: 5000 });
    expect(one.outputFile).not.toBe(two.outputFile);
    expect(readFileSync(one.outputFile!, "utf8")).toBe("first");
    expect(second.readOutput("same")).toBe("second");
  });


  it("waits for in-flight process creation and stops through its environment backend", async () => {
    const host = owner(),
      supervisor = host.getDetachedProcessSupervisor(cwd);
    let acquire!: (value: any) => void, exit!: (value: { exitCode: number }) => void;
    const acquired = new Promise<any>((resolve) => {
      acquire = resolve;
    });
    const exited = new Promise<{ exitCode: number }>((resolve) => {
      exit = resolve;
    });
    const signal = vi.fn(async () => {
      exit({ exitCode: 143 });
    });
    let requested!: () => void;
    const entered = new Promise<void>(resolve => { requested = resolve; });
    const starting = supervisor.startShellExecution({
      cwd,
      command: "pwd",
      description: "late",
      processExecutor: {
        execShell: () => { requested(); return acquired; },
        execProcess: () => { requested(); return acquired; },
      },
    });
    const rejected = expect(starting).rejects.toThrow(/closed during process creation/);
    await entered;
    let finished = false;
    const closing = host.close().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    acquire({ write() {}, end() {}, onOutput: () => () => {}, wait: () => exited, signal });
    await rejected;
    await closing;
    expect(signal).toHaveBeenCalledWith("terminate");
    await expect(
      supervisor.startShellExecution({ cwd, command: "pwd", description: "new" }),
    ).rejects.toThrow(/closed/);
  });

  it("waits for an active LSP operation and disconnects its client", async () => {
    const host = owner();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let client: any;
    const work = host.withLspClient({ command: "", args: [], cwd }, async (value) => {
      client = value;
      await value.connect();
      await pending;
      return "result";
    });
    await Promise.resolve();
    let closed = false;
    const closing = host.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect(await work).toBe("result");
    await closing;
    expect(client.isConnected()).toBe(false);
    expect(() => host.withLspClient({ command: "", args: [], cwd }, async () => "new")).toThrow(
      /closed/,
    );
  });

  it("attempts every cleanup even when one supervisor fails", async () => {
    const host = owner();
    const first = host.getDetachedProcessSupervisor({ cwd, sessionId: "a" });
    const second = host.getDetachedProcessSupervisor({ cwd, sessionId: "b" });
    const error = new Error("shutdown failure");
    vi.spyOn(first, "aclose").mockRejectedValue(error);
    const stop = vi.spyOn(second, "aclose");
    const closing = host.close();
    await expect(closing).rejects.toBe(error);
    expect(stop).toHaveBeenCalledOnce();
    owners.splice(owners.indexOf(host), 1); // The rejected close is already observed.
  });

  it("waits for LSP release before reporting a process cleanup failure", async () => {
    const host = owner();
    const failure = new Error("process cleanup failed");
    vi.spyOn(host.getDetachedProcessSupervisor(cwd), "aclose").mockRejectedValue(failure);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const request = host.withLspClient({ command: "", args: [], cwd }, async () => pending);
    await Promise.resolve();
    let finished = false;
    const result = host.close().catch(error => { finished = true; return error; });
    await new Promise(resolve => setImmediate(resolve));
    expect(finished).toBe(false);
    release(); await request;
    expect(await result).toBe(failure);
    owners.splice(owners.indexOf(host), 1);
  });
});
