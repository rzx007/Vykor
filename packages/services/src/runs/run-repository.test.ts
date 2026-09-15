import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";
import { RunRepository } from "./run-repository.js";

describe("RunRepository read operations", () => {
  it("gets and lists runs with input ownership, promotion, sorting and clone protection", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-run-repo-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new RunRepository((store as any).storage);

      expect(repository.getRun("missing-run")).toBeUndefined();
      expect(() => repository.listRuns("missing-session")).toThrow(
        "Session not found: missing-session",
      );

      store.createSession({ id: "s1", cwd: directory, model: "m" });
      const in1 = store.admitPrompt({ id: "i1", sessionId: "s1", delivery: "queue", items: [{ type: "text", text: "1" }] });
      const in2 = store.admitPrompt({ id: "i2", sessionId: "s1", delivery: "queue", items: [{ type: "text", text: "2" }] });

      const r1 = store.createRun({ id: "r1", sessionId: "s1", inputId: "i1", metadata: { custom: "val" } });
      const r2 = store.createRun({ id: "r2", sessionId: "s1", inputId: "i1" });
      const r3 = store.createRun({ id: "r3", sessionId: "s1", inputId: "i2" });

      // getRun returns clone
      const fetchedR1 = repository.getRun("r1");
      expect(fetchedR1).toBeDefined();
      expect(fetchedR1!.id).toBe("r1");
      fetchedR1!.metadata.custom = "mutated";
      expect(repository.getRun("r1")!.metadata.custom).toBe("val");

      // listRuns sorted by createdAt asc
      expect(repository.listRuns("s1").map((r) => r.id)).toEqual(["r1", "r2", "r3"]);

      // listRunsByInput sorted by createdAt asc, id asc
      expect(repository.listRunsByInput("i1").map((r) => r.id)).toEqual(["r1", "r2"]);
      expect(repository.findOwningRunByInput("i1")?.id).toBe("r1");
      expect(repository.findRunByInput("i1")?.id).toBe("r1");

      // Promoted run through message
      const in3 = store.admitPrompt({ id: "i3", sessionId: "s1", delivery: "queue", items: [{ type: "text", text: "3" }] });
      store.createMessage({
        id: "m_promoted",
        sessionId: "s1",
        role: "assistant",
        inputId: "i3",
        runId: "r3",
      });
      expect(repository.findRunByInput("i3")?.id).toBe("r3");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("gets and lists run attempts with sequence sorting and error on missing run", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-run-repo-att-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new RunRepository((store as any).storage);

      expect(repository.getRunAttempt("missing")).toBeUndefined();
      expect(() => repository.listRunAttempts("missing-run")).toThrow(
        "Session run not found: missing-run",
      );

      store.createSession({ id: "s1", cwd: directory, model: "m" });
      const input = store.admitPrompt({ id: "i1", sessionId: "s1", delivery: "queue", items: [{ type: "text", text: "1" }] });
      store.createRun({ id: "r1", sessionId: "s1", inputId: input.id });

      store.createRunAttempt({ id: "att2", runId: "r1", sequence: 2 });
      store.createRunAttempt({ id: "att1", runId: "r1", sequence: 1 });

      // listRunAttempts sorted by sequence asc
      const attempts = repository.listRunAttempts("r1");
      expect(attempts.map((a) => a.id)).toEqual(["att1", "att2"]);

      // getRunAttempt returns clone
      const fetchedAtt = repository.getRunAttempt("att1");
      expect(fetchedAtt).toBeDefined();
      fetchedAtt!.retryReason = "mutated";
      expect(repository.getRunAttempt("att1")!.retryReason).not.toBe("mutated");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("gets and lists tasks with metadata matching for runtimeExecutionId and taskManagerId", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-run-repo-task-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new RunRepository((store as any).storage);

      expect(repository.getSessionTask("missing")).toBeUndefined();
      expect(() => repository.listSessionTasks("missing-session")).toThrow(
        "Session not found: missing-session",
      );
      expect(() =>
        repository.findSessionExecutionByRuntimeId("missing-session", "exec-1"),
      ).toThrow("Session not found: missing-session");

      store.createSession({ id: "s1", cwd: directory, model: "m" });

      const t1 = store.createSessionTask({
        id: "t1",
        sessionId: "s1",
        type: "process",
        description: "Task 1",
        cwd: directory,
        metadata: { runtimeExecutionId: "exec-1" },
      });
      const t2 = store.createSessionTask({
        id: "t2",
        sessionId: "s1",
        type: "process",
        description: "Task 2",
        cwd: directory,
        metadata: { taskManagerId: "mgr-2" },
      });

      // getSessionTask
      expect(repository.getSessionTask("t1")?.id).toBe("t1");

      // listSessionTasks sorted by createdAt asc
      expect(repository.listSessionTasks("s1").map((t) => t.id)).toEqual(["t1", "t2"]);

      // findSessionExecutionByRuntimeId by runtimeExecutionId
      expect(repository.findSessionExecutionByRuntimeId("s1", "exec-1")?.id).toBe("t1");

      // findSessionExecutionByRuntimeId by taskManagerId
      expect(repository.findSessionExecutionByRuntimeId("s1", "mgr-2")?.id).toBe("t2");

      expect(
        repository.findSessionExecutionByRuntimeId("s1", "nonexistent"),
      ).toBeUndefined();

      // clone protection
      const fetchedT1 = repository.getSessionTask("t1");
      fetchedT1!.metadata.runtimeExecutionId = "mutated";
      expect(
        repository.getSessionTask("t1")!.metadata.runtimeExecutionId,
      ).toBe("exec-1");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
