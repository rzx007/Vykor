import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const children: ChildProcess[] = [];

vi.mock("@vykor/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vykor/sandbox")>()),
  createShellProcess: vi.fn(async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    children.push(child);
    return child;
  }),
}));

import { DetachedProcessSupervisor } from "../detached-process-supervisor.js";

const roots: string[] = [];

afterEach(() => {
  children.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DetachedProcessSupervisor output drain", () => {
  it("does not report completion until stdout emitted after process exit is drained", async () => {
    const root = mkdtempSync(join(tmpdir(), "oh-output-drain-"));
    roots.push(root);
    const supervisor = new DetachedProcessSupervisor(root);
    const task = await supervisor.startShellExecution("echo done", "test", process.cwd());
    const child = children[0]!;
    const resultPromise = supervisor.awaitExecution(task.id, { timeoutMs: 1_000 });

    child.emit("exit", 0, null);
    setTimeout(() => {
      child.stdout!.write("done\n");
      child.stdout!.end();
      child.stderr!.end();
      child.emit("close", 0, null);
    }, 0);

    const result = await resultPromise;
    expect(result.status).toBe("completed");
    expect(result.output).toContain("done");
    supervisor.close();
  });
});
