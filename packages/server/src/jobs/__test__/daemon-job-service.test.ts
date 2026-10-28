import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DaemonOperationGate } from "../../application/control/daemon-operation-gate.js";
import { SessionStore } from "@vykor/services";
import { createTaskArchive } from "../job-snapshots.js";
import { DaemonJobService } from "../daemon-job-service.js";
import { createNodeJobBindings } from "@vykor/agent-runtime";
import { DetachedProcessSupervisor } from "@vykor/execution-node";

it("reads persisted targets without opening a model and rejects unknown sessions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "daemon-job-archive-"));
  const store = new SessionStore({ path: join(cwd, "session.db") });
  const processes = new DetachedProcessSupervisor(join(cwd, "output"));
  try {
    store.sessions.create({ id: "session", cwd, model: "unconfigured" });
    store.createSessionTask({ id: "shell", sessionId: "session", cwd, type: "shell", description: "saved" });
    store.updateSessionTask("shell", { status: "completed", output: "stored output" });
    const bindings = createNodeJobBindings({ child: { sessionId: "session", cwd, processes, children: { get: () => undefined, getBySessionId: () => undefined, list: () => [] }, sendChildInput: async () => { throw new Error("No live child"); } }, process: { sessionId: "session", cwd, processes, archive: createTaskArchive(store, "session", "process") } });
    const service = new DaemonJobService({ getSession: id => store.sessions.get(id) }, () => bindings.jobs);
    const target = { kind: "shell", jobId: "shell" } as const;
    expect((await service.read({ sessionId: "session", target })).text).toBe("stored output");
    expect((await service.cancel({ sessionId: "session", target })).status).toBe("completed");
    expect((await service.list({ sessionId: "session" })).jobs[0]?.target).toEqual(target);
    expect(() => service.read({ sessionId: "missing", target })).toThrow(/Session not found/);
  } finally { await processes.aclose(); store.close(); rmSync(cwd, { recursive: true, force: true }); }
});


it("checks send admission before creating a host and releases its lease if host creation fails", async () => {
  const gate = new DaemonOperationGate();
  const session = { id: "session", cwd: "/workspace", status: "idle" } as any;
  const getJobs = vi.fn(() => { throw new Error("host creation failed"); });
  const service = new DaemonJobService({ getSession: () => session }, getJobs, gate);
  const input = { sessionId: session.id, target: { kind: "agent" as const, jobId: "child", runId: "run" }, data: "continue" };
  const barrier = gate.tryEnterBarrier({ kind: "global" }, () => true)!;
  await expect(service.send(input)).rejects.toThrow(/blocked/);
  expect(getJobs).not.toHaveBeenCalled();
  barrier.release();
  await expect(service.send(input)).rejects.toThrow("host creation failed");
  const afterFailure = gate.tryEnterBarrier({ kind: "global" }, () => true);
  expect(afterFailure).toBeDefined();
  afterFailure!.release();
  session.status = "archived";
  getJobs.mockClear();
  await expect(service.send(input)).rejects.toThrow("Session is not accepting new work");
  expect(getJobs).not.toHaveBeenCalled();
});
