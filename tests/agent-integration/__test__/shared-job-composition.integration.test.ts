import { describe, expect, it, vi } from "vitest";
import { LocalTerminalProvider } from "@vykor/terminal-node";
import { createLifecycleFixture, invokeLifecycleTool } from "./fixtures/task-lifecycle-fixture.js";

describe.each(["sdk", "daemon"] as const)("shared composition: %s", mode => {
  it("reads a real child result repeatedly and pins old-run cancellation", async () => {
    const f = await createLifecycleFixture(mode);
    try {
      const first = await f.spawn("first");
      await first.handle.waitRun(first.target.runId);
      for (let n = 0; n < 3; n++) {
        await first.handle.result;
        expect((await f.read(first.target)).text).toContain("first");
      }
      f.hold("second");
      const receipt = await f.send(first.target, "second");
      const second = { ...first.target, runId: receipt.runId };
      expect(second.runId).not.toBe(first.target.runId);
      await f.entered("second");
      await f.cancel(first.target);
      expect((await f.read(second)).snapshot.status).toBe("running");
      f.release("second");
      expect((await f.wait(second)).snapshot.status).toBe("completed");
      expect(first.handle.state).not.toBe("closed");
    } finally { await f.close(); }
  });

  it("keeps direct child operations available when terminal listing fails", async () => {
    const f = await createLifecycleFixture(mode);
    const listing = vi.spyOn(LocalTerminalProvider.prototype, "list").mockRejectedValue(new Error("terminal listing failed"));
    try {
      const first = await f.spawn("direct");
      expect((await f.read(first.target)).snapshot.target).toEqual(first.target);
      expect((await f.wait(first.target)).snapshot.status).toBe("completed");
      expect((await f.cancel(first.target)).status).toBe("completed");
      const list = await f.list();
      expect(list.errors).toContainEqual({ kind: "terminal", message: "terminal listing failed" });
      expect(list.jobs.some(job => job.id === first.target.jobId)).toBe(true);
    } finally { listing.mockRestore(); await f.close(); }
  });

  it("runs one real Shell, native PTY and one-step Workflow through the common composition", async () => {
    const f = await createLifecycleFixture(mode);
    try {
      const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('shell-ok')"`;
      const shell = await invokeLifecycleTool(f, "BackgroundShellCreate", { command, description: "native shell" });
      const target = { kind: "shell", jobId: shell.jobId } as const;
      const finished = await f.wait(target);
      expect(finished.text).toContain("shell-ok");
      expect(finished.snapshot.exitCode).toBe(0);
      expect((await f.list()).jobs.filter(job => job.kind === "shell" && job.id === shell.jobId)).toHaveLength(1);
      const terminal = await invokeLifecycleTool(f, "TerminalOpen", { name: "native PTY" });
      const pty = { kind: "terminal", jobId: terminal.jobId } as const;
      expect((await f.read(pty)).snapshot.status).toBe("running");
      expect(["stopping", "killed"]).toContain((await f.cancel(pty)).status);
      expect((await f.wait(pty)).snapshot.status).toBe("killed");
      const workflow = await invokeLifecycleTool(f, "Workflow", { action: "run", mode: "sequential", detached: true, tasks: [{ id: "one", prompt: "workflow-ok", subagentType: "worker" }] });
      expect(workflow.target).toEqual({ kind: "workflow", jobId: workflow.jobId });
      const run = await f.wait(workflow.target);
      expect(run.snapshot.status).toBe("completed");
      expect(run.text).toContain("workflow-ok");
    } finally { await f.close(); }
  });
});

it("keeps the explicit daemon terminal provider available across cold reads", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SessionStore } = await import("@vykor/services");
  const { DaemonApplication } = await import("../../../packages/server/src/application/daemon-application.js");
  const cwd = mkdtempSync(join(tmpdir(), "cold-terminal-binding-"));
  const store = new SessionStore({ path: join(cwd, "store.db") });
  const provider = new LocalTerminalProvider({ resolveCwd: async input => input.cwd ?? cwd });
  const app = new DaemonApplication({ store, log() {}, terminalProviderForSession: () => provider });
  try {
    await app.ready();
    store.sessions.create({ id: "cold-session", cwd, model: "unconfigured" });
    const terminal = await provider.create({ scope: { kind: "session", sessionId: "cold-session" }, runtime: "local", source: "agent", cwd, cols: 80, rows: 24 });
    const target = { kind: "terminal", jobId: terminal.id } as const;
    expect((await app.jobs.read({ sessionId: "cold-session", target })).snapshot.status).toBe("running");
    expect((await app.jobs.read({ sessionId: "cold-session", target })).snapshot.status).toBe("running");
    expect((await provider.get(terminal.id))?.status).toBe("running");
    await app.jobs.cancel({ sessionId: "cold-session", target });
    expect((await app.jobs.wait({ sessionId: "cold-session", target, timeoutMs: 5_000 })).snapshot.status).toBe("killed");
  } finally { await app.close(); await provider.dispose(); store.close(); rmSync(cwd, { recursive: true, force: true }); }
});
