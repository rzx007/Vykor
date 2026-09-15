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

describe("RunRepository write operations", () => {
    it("creates and updates runs with session status refresh, input alignment, terminal guards, and events", () => {
      const directory = mkdtempSync(join(tmpdir(), "ohs-run-repo-write-"));
      const store = new SessionStore({ path: join(directory, "store.db") });
      try {
        const repository = new RunRepository({
          storage: (store as any).storage,
          appendEvent: (input) => (store as any).appendEvent(input),
          save: () => (store as any).save(),
        });

        store.createSession({ id: "s1", cwd: directory, model: "m" });
        store.createSession({ id: "s2", cwd: directory, model: "m" });
        const input1 = store.admitPrompt({ id: "i1", sessionId: "s1", delivery: "queue", items: [{ type: "text", text: "prompt" }] });

        // 1. Input/session alignment check
        expect(() =>
          repository.createRun({ id: "r_misaligned", sessionId: "s2", inputId: "i1" }),
        ).toThrow("Session input does not belong to session: i1");

        // 2. Create run with default status pending, session becomes running
        const before = store.getSession("s1")!.updatedAt;
        const r1 = repository.createRun({
          id: "r1",
          sessionId: "s1",
          inputId: "i1",
          metadata: { initial: true },
        });
        expect(r1.id).toBe("r1");
        expect(r1.status).toBe("pending");
        expect(store.getSession("s1")!.status).toBe("running");
        expect(store.getSession("s1")!.updatedAt).toBeGreaterThanOrEqual(before);

        // returns clone
        r1.status = "failed";
        expect(repository.getRun("r1")!.status).toBe("pending");

        // Event emitted
        const events = store.listEvents({ sessionId: "s1" });
        const createdEvent = events.find((e) => e.type === "session.run.created");
        expect(createdEvent).toBeDefined();
        expect(createdEvent!.payload).toMatchObject({ run: { id: "r1" } });

        // 3. Reject duplicate run id
        expect(() => repository.createRun({ id: "r1", sessionId: "s1" })).toThrow(
          "Session run already exists: r1",
        );

        // 4. Update run: pending -> running
        const running = repository.updateRun("r1", {
          status: "running",
          metadata: { step: 1 },
        });
        expect(running.status).toBe("running");
        expect(running.startedAt).toBeDefined();
        expect(running.metadata).toEqual({ initial: true, step: 1 });

        // Event emitted with previousStatus
        const events2 = store.listEvents({ sessionId: "s1" });
        const updatedEvent = events2.find(
          (e) => e.type === "session.run.updated" && (e.payload as any).previousStatus === "pending",
        );
        expect(updatedEvent).toBeDefined();

        // 5. Update run: running -> completed, finishedAt set, session becomes idle
        const completed = repository.updateRun("r1", { status: "completed" });
        expect(completed.status).toBe("completed");
        expect(completed.finishedAt).toBeDefined();
        expect(store.getSession("s1")!.status).toBe("idle");

        // 6. Terminal guard
        expect(() => repository.updateRun("r1", { status: "running" })).toThrow(
          "Session run is already terminal: r1",
        );
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("creates and updates run attempts with auto sequence, terminal guards, tokens, and events", () => {
      const directory = mkdtempSync(join(tmpdir(), "ohs-run-repo-att-write-"));
      const store = new SessionStore({ path: join(directory, "store.db") });
      try {
        const repository = new RunRepository({
          storage: (store as any).storage,
          appendEvent: (input) => (store as any).appendEvent(input),
          save: () => (store as any).save(),
        });

        store.createSession({ id: "s1", cwd: directory, model: "m" });
        const r1 = repository.createRun({ id: "r1", sessionId: "s1" });

        // 1. Create first attempt auto sequence
        const a1 = repository.createRunAttempt({
          id: "a1",
          runId: "r1",
          provider: "openai",
          model: "gpt-4",
        });
        expect(a1.sequence).toBe(1);
        expect(a1.status).toBe("pending");

        // returns clone
        a1.status = "completed";
        expect(repository.getRunAttempt("a1")!.status).toBe("pending");

        // Event emitted
        const events = store.listEvents({ sessionId: "s1" });
        const createdEvent = events.find((e) => e.type === "session.run_attempt.created");
        expect(createdEvent).toBeDefined();
        expect(createdEvent!.payload).toMatchObject({ attempt: { id: "a1", sequence: 1 } });

        // 2. Reject duplicate sequence on same run
        expect(() =>
          repository.createRunAttempt({
            runId: "r1",
            sequence: 1,
          }),
        ).toThrow("Session run attempt sequence already exists: r1/1");

        // 3. Update attempt: pending -> running -> completed
        repository.updateRunAttempt("a1", { status: "running" });
        const updatedA1 = repository.updateRunAttempt("a1", {
          status: "completed",
          inputTokens: 200,
          outputTokens: 80,
        });
        expect(updatedA1.status).toBe("completed");
        expect(updatedA1.finishedAt).toBeDefined();
        expect(updatedA1.inputTokens).toBe(200);
        expect(updatedA1.outputTokens).toBe(80);

        // Event emitted with previousStatus
        const events2 = store.listEvents({ sessionId: "s1" });
        const updatedEvent = events2.find(
          (e) => e.type === "session.run_attempt.updated" && (e.payload as any).previousStatus === "running",
        );
        expect(updatedEvent).toBeDefined();

        // 4. Terminal attempt guard
        expect(() => repository.updateRunAttempt("a1", { status: "failed" })).toThrow(
          "Session run attempt is already terminal: a1",
        );

        // 5. If run is terminal, cannot create attempt
        repository.updateRun("r1", { status: "completed" });
        expect(() => repository.createRunAttempt({ runId: "r1" })).toThrow(
          "Session run is already terminal: r1",
        );
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
