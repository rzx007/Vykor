import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
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
