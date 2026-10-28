import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalTerminalProvider } from "@vykor/terminal-node";
import type { AgentChildHandle, ToolResult } from "@vykor/agent-contracts";
import { createLifecycleFixture } from "./fixtures/task-lifecycle-fixture.js";

function body(result: ToolResult) {
  const block = result.content.find(block => block.type === "text");
  if (block?.type !== "text") throw new Error("Missing tool response body");
  return JSON.parse(block.text);
}

describe.each(["sdk", "daemon"] as const)("child native execution ownership: %s", mode => {
  it.each([false, true])("persists the actual child Shell owner and output (different cwd: %s)", async differentCwd => {
    const f = await createLifecycleFixture(mode);
    const childCwd = differentCwd ? mkdtempSync(join(tmpdir(), "child-shell-cwd-")) : undefined;
    const label = "child-shell-owner";
    const results = f.scriptChild(label, [
      { name: "BackgroundShellCreate", input: { command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('child-shell-output')"`, description: label } },
      { name: "JobWait", input: results => ({ targets: [{ target: { kind: "shell", jobId: body(results[0]!).jobId } }], timeoutSeconds: 5 }) },
      { name: "JobRead", input: results => ({ target: { kind: "shell", jobId: body(results[0]!).jobId } }) },
    ]);
    try {
      let handle!: AgentChildHandle;
      let runId!: string;
      await f.inRootRun(async execution => {
        const receipt = await execution.children.spawnChildAgent({ prompt: label, description: label, agent: "worker", cwd: childCwd ?? execution.scope.cwd, allowedTools: ["BackgroundShellCreate", "JobWait", "JobRead"] });
        handle = f.agent.children.get(receipt.id)!;
        runId = receipt.runId;
      });
      await handle.waitRun(runId);
      expect(results).toHaveLength(3);
      expect(results.every(result => !result.isError), JSON.stringify(results)).toBe(true);
      const read = body(results[2]!);
      expect(read.snapshot.ownerSession).toBe(handle.sessionId);
      expect(read.text).toContain("child-shell-output");
      if (childCwd) expect(read.snapshot.cwd).toBe(childCwd);
      if (f.store) {
        const saved = f.store.runs.getSessionTask(body(results[0]!).jobId);
        expect(saved).toMatchObject({ sessionId: handle.sessionId, status: "completed" });
        expect(saved?.output).toContain("child-shell-output");
      }
    } finally {
      await f.close();
      if (childCwd) rmSync(childCwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("reads and stops the same actual child Terminal returned by TerminalOpen", async () => {
    const f = await createLifecycleFixture(mode);
    const label = "child-terminal-owner";
    const target = (results: ToolResult[]) => ({ kind: "terminal", jobId: body(results[0]!).jobId });
    const results = f.scriptChild(label, [
      { name: "TerminalOpen", input: { name: label } },
      { name: "JobRead", input: results => ({ target: target(results) }) },
      { name: "JobCancel", input: results => ({ target: target(results) }) },
      { name: "JobWait", input: results => ({ targets: [{ target: target(results) }], timeoutSeconds: 5 }) },
    ]);
    try {
      let handle!: AgentChildHandle;
      let runId!: string;
      await f.inRootRun(async execution => {
        const receipt = await execution.children.spawnChildAgent({ prompt: label, description: label, agent: "worker", cwd: execution.scope.cwd, allowedTools: ["TerminalOpen", "JobRead", "JobCancel", "JobWait"] });
        handle = f.agent.children.get(receipt.id)!;
        runId = receipt.runId;
      });
      await handle.waitRun(runId);
      expect(results).toHaveLength(4);
      expect(results.every(result => !result.isError), JSON.stringify(results)).toBe(true);
      expect(body(results[0]!).terminal.sessionId).toBe(handle.sessionId);
      expect(body(results[1]!).snapshot.ownerSession).toBe(handle.sessionId);
      expect(body(results[3]!).results[0].snapshot.status).toBe("killed");
    } finally { await f.close(); }
  }, 30_000);
});

it("denies a real child access to its session's manual PTY even when terminal listing fails", async () => {
  const f = await createLifecycleFixture("daemon");
  let listing: ReturnType<typeof vi.spyOn> | undefined;
  try {
    let handle!: AgentChildHandle;
    let firstRunId!: string;
    await f.inRootRun(async execution => {
      const receipt = await execution.children.spawnChildAgent({ prompt: "manual-child-seed", description: "manual-terminal-access", agent: "worker", cwd: execution.scope.cwd, allowedTools: ["JobList", "JobRead", "JobWait", "JobSend", "JobCancel"] });
      handle = f.agent.children.get(receipt.id)!;
      firstRunId = receipt.runId;
    });
    await handle.waitRun(firstRunId);
    const manual = await f.terminals!.create({ scope: { kind: "session", sessionId: handle.sessionId }, runtime: "local", source: "user", cols: 80, rows: 24 });
    const target = { kind: "terminal", jobId: manual.id };
    const results = f.scriptChild("manual-child-controls", [
      { name: "JobList", input: {} },
      { name: "JobRead", input: { target } },
      { name: "JobWait", input: { targets: [{ target }], timeoutSeconds: 0.01 } },
      { name: "JobSend", input: { target, data: "unauthorized\r" } },
      { name: "JobCancel", input: { target } },
    ]);
    let runId!: string;
    await f.inRootRun(async execution => {
      const receipt = await handle.send({ content: "manual-child-controls" }, execution.tools);
      runId = receipt.runId;
    });
    await handle.waitRun(runId);
    expect(results).toHaveLength(5);
    expect(body(results[0]!).jobs.some((job: { id: string }) => job.id === manual.id)).toBe(false);
    expect(body(results[2]!).results[0].error).toContain("Job not found");
    for (const index of [1, 3, 4]) {
      expect(results[index]!.isError).toBe(true);
      expect(results[index]!.content.some(block => block.type === "text" && block.text.includes("Job not found"))).toBe(true);
    }
    expect((await f.terminals!.get(manual.id)).status).toBe("running");
    listing = vi.spyOn(LocalTerminalProvider.prototype, "list").mockRejectedValue(new Error("listing unavailable"));
    // Same actual child and another real Run; point controls still reject
    // without consulting any unrelated terminal list.
    const direct = f.scriptChild("manual-child-direct", [
      { name: "JobRead", input: { target } },
      { name: "JobCancel", input: { target } },
    ]);
    await f.inRootRun(async execution => { const receipt = await handle.send({ content: "manual-child-direct" }, execution.tools); runId = receipt.runId; });
    await handle.waitRun(runId);
    expect(direct).toHaveLength(2);
    for (const result of direct) {
      expect(result.isError).toBe(true);
      expect(result.content.some(block => block.type === "text" && block.text.includes("Job not found"))).toBe(true);
    }
    expect((await f.terminals!.get(manual.id)).status).toBe("running");
  } finally { listing?.mockRestore(); await f.close(); }
}, 30_000);
