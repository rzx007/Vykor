import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionStore } from "@vykor/services";
import { createTaskArchive } from "../job-snapshots.js";

it.each(["max_turns", "timeout", "unknown"])("reads the requested archived %s run without inheriting latest facts", async failureKind => {
  const directory = mkdtempSync(join(tmpdir(), "vk-child-archive-"));
  const store = new SessionStore({ path: join(directory, "store.db") });
  try {
    store.sessions.create({ id: "parent", cwd: directory, model: "m" });
    store.sessions.create({ id: "child-session", parentId: "parent", cwd: directory, model: "m" });
    const partialResult = { version: 1, childSessionId: "child-session", runId: "old-A", source: "limit_finalization", text: "old partial report", truncated: false };
    store.runs.createRun({ id: "old-A", sessionId: "child-session" });
    store.runs.updateRun("old-A", { status: "failed", error: "old technical error", metadata: { terminalOutput: partialResult.text, childFailure: { failureKind, partialResult } } });
    store.runs.createRun({ id: "new-B", sessionId: "child-session" });
    store.runs.updateRun("new-B", { status: "completed", metadata: { terminalOutput: "new report" } });
    store.createSessionTask({ id: "child-1", sessionId: "parent", childSessionId: "child-session", runId: "new-B", type: "agent", description: "check", cwd: directory, metadata: { executionBackend: "child_agent" } });
    store.updateSessionTask("child-1", { status: "completed", output: "new report" });
    const archive = createTaskArchive(store, "parent", "agent");
    const target = { kind: "agent" as const, jobId: "child-1", runId: "old-A" };
    const old = await archive.read({ sessionId: "parent", target, maxChars: 6 });
    expect(old.snapshot.target).toEqual(target);
    expect(old.snapshot).toMatchObject({ status: "failed", detail: "old technical error", capabilities: { send: false } });
    expect(old.snapshot.metadata?.childFailure).toEqual({ failureKind, partialResult });
    expect(old.details?.childFailure).toEqual(old.snapshot.metadata?.childFailure);
    expect(old.text).toBe("report");
    expect(old.truncated).toBe(true);
    expect(partialResult.truncated).toBe(false);
    expect((await archive.list({ sessionId: "parent" })).jobs[0]).toMatchObject({ status: "completed", target: { runId: "new-B" } });
    for (const badReport of [null, [], { ...partialResult, version: 2 }, { ...partialResult, runId: "new-B" }, { ...partialResult, childSessionId: "other" }, { ...partialResult, source: "unknown" }, { ...partialResult, text: " " }, { ...partialResult, truncated: "false" }]) {
      store.runs.updateRun("old-A", { metadata: { childFailure: { failureKind, partialResult: badReport } } });
      const invalid = await archive.read({ sessionId: "parent", target });
      expect(invalid.snapshot.metadata?.childFailure).toEqual({ failureKind });
      expect(invalid.details?.childFailure).toEqual({ failureKind });
      expect(invalid.text).toBe("old partial report");
    }
    store.runs.createRun({ id: "pending-C", sessionId: "child-session" });
    store.runs.updateRun("pending-C", { status: "running" });
    const pending = await archive.read({ sessionId: "parent", target: { ...target, runId: "pending-C" } });
    expect(pending.snapshot.status).toBe("running");
    expect(pending.snapshot.finishedAt).toBeUndefined();
    expect(pending.snapshot.detail).toBeUndefined();
    expect(pending.snapshot.metadata?.childFailure).toBeUndefined();
    await expect(archive.read({ sessionId: "parent", target: { ...target, runId: "missing" } })).rejects.toThrow("RUN_RESULT_NOT_RETAINED");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
