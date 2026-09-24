import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";
import { RunRepository } from "./run-repository.js";

describe("RunRepository read operations", () => {
  it("gets and lists runs with input ownership, promotion, sorting and clone protection", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-run-repo-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new RunRepository((store as any).storage);

      expect(repository.getRun("missing-run")).toBeUndefined();
      expect(() => repository.listRuns("missing-session")).toThrow(
        "Session not found: missing-session",
      );

      store.sessions.create({ id: "s1", cwd: directory, model: "m" });
      const in1 = store.conversationTransactions.admitPrompt({ id: "i1", sessionId: "s1", delivery: "queue", items: [{ type: "text", text: "1" }] });
      const in2 = store.conversationTransactions.admitPrompt({ id: "i2", sessionId: "s1", delivery: "queue", items: [{ type: "text", text: "2" }] });

      const r1 = store.runs.createRun({ id: "r1", sessionId: "s1", inputId: "i1", metadata: { custom: "val" } });
      const r2 = store.runs.createRun({ id: "r2", sessionId: "s1", inputId: "i1" });
      const r3 = store.runs.createRun({ id: "r3", sessionId: "s1", inputId: "i2" });

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
      const in3 = store.conversationTransactions.admitPrompt({ id: "i3", sessionId: "s1", delivery: "queue", items: [{ type: "text", text: "3" }] });
      store.conversations.createMessage({
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
    const directory = mkdtempSync(join(tmpdir(), "vk-run-repo-att-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    try {
      const repository = new RunRepository((store as any).storage);

      expect(repository.getRunAttempt("missing")).toBeUndefined();
      expect(() => repository.listRunAttempts("missing-run")).toThrow(
        "Session run not found: missing-run",
      );

      store.sessions.create({ id: "s1", cwd: directory, model: "m" });
      const input = store.conversationTransactions.admitPrompt({ id: "i1", sessionId: "s1", delivery: "queue", items: [{ type: "text", text: "1" }] });
      store.runs.createRun({ id: "r1", sessionId: "s1", inputId: input.id });

      store.runs.createRunAttempt({ id: "att2", runId: "r1", sequence: 2 });
      store.runs.createRunAttempt({ id: "att1", runId: "r1", sequence: 1 });

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
    const directory = mkdtempSync(join(tmpdir(), "vk-run-repo-task-"));
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

      store.sessions.create({ id: "s1", cwd: directory, model: "m" });

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
      const directory = mkdtempSync(join(tmpdir(), "vk-run-repo-write-"));
      const store = new SessionStore({ path: join(directory, "store.db") });
      try {
        const repository = new RunRepository({
          storage: (store as any).storage,
          appendEvent: (input) => store.conversations.appendEvent(input),
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: directory, model: "m" });
        store.sessions.create({ id: "s2", cwd: directory, model: "m" });
        const input1 = store.conversationTransactions.admitPrompt({ id: "i1", sessionId: "s1", delivery: "queue", items: [{ type: "text", text: "prompt" }] });

        // 1. Input/session alignment check
        expect(() =>
          repository.createRun({ id: "r_misaligned", sessionId: "s2", inputId: "i1" }),
        ).toThrow("Session input does not belong to session: i1");

        // 2. Create run with default status pending, session becomes running
        const before = store.sessions.get("s1")!.updatedAt;
        const r1 = repository.createRun({
          id: "r1",
          sessionId: "s1",
          inputId: "i1",
          metadata: { initial: true },
        });
        expect(r1.id).toBe("r1");
        expect(r1.status).toBe("pending");
        expect(store.sessions.get("s1")!.status).toBe("running");
        expect(store.sessions.get("s1")!.updatedAt).toBeGreaterThanOrEqual(before);

        // returns clone
        r1.status = "failed";
        expect(repository.getRun("r1")!.status).toBe("pending");

        // Event emitted
        const events = store.conversations.listEvents({ sessionId: "s1" });
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
        const events2 = store.conversations.listEvents({ sessionId: "s1" });
        const updatedEvent = events2.find(
          (e) => e.type === "session.run.updated" && (e.payload as any).previousStatus === "pending",
        );
        expect(updatedEvent).toBeDefined();

        // 5. Update run: running -> completed, finishedAt set, session becomes idle
        const completed = repository.updateRun("r1", { status: "completed" });
        expect(completed.status).toBe("completed");
        expect(completed.finishedAt).toBeDefined();
        expect(store.sessions.get("s1")!.status).toBe("idle");

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
      const directory = mkdtempSync(join(tmpdir(), "vk-run-repo-att-write-"));
      const store = new SessionStore({ path: join(directory, "store.db") });
      try {
        const repository = new RunRepository({
          storage: (store as any).storage,
          appendEvent: (input) => store.conversations.appendEvent(input),
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: directory, model: "m" });
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
        const events = store.conversations.listEvents({ sessionId: "s1" });
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
        const events2 = store.conversations.listEvents({ sessionId: "s1" });
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

    it("creates, reserves, transitions and updates session tasks with validation, events and clone protection", () => {
      const directory = mkdtempSync(join(tmpdir(), "vk-run-repo-task-write-"));
      const store = new SessionStore({ path: join(directory, "store.db") });
      try {
        const repository = new RunRepository({
          storage: (store as any).storage,
          appendEvent: (input) => store.conversations.appendEvent(input),
          save: () => (store as any).save(),
        });

        store.sessions.create({ id: "s1", cwd: directory, model: "m" });
        store.sessions.create({ id: "s2", cwd: directory, model: "m" });
        store.sessions.create({ id: "child_s1", parentId: "s1", cwd: directory, model: "m" });
        const r1 = repository.createRun({ id: "r1", sessionId: "s1" });
        const r2 = repository.createRun({ id: "r2", sessionId: "s2" });

        // 1. requestNamespace and requestId pairing
        expect(() =>
          repository.createSessionTask({
            sessionId: "s1",
            type: "subagent",
            description: "d",
            cwd: directory,
            requestNamespace: "ns",
          }),
        ).toThrow("Session task requestNamespace and requestId must be provided together");

        // 2. Child session ownership
        expect(() =>
          repository.createSessionTask({
            sessionId: "s2",
            childSessionId: "child_s1", // child_s1 parent is s1, not s2
            type: "subagent",
            description: "d",
            cwd: directory,
          }),
        ).toThrow("Child session does not belong to task session: child_s1");

        // 3. Run ownership
        expect(() =>
          repository.createSessionTask({
            sessionId: "s1",
            runId: "r2", // r2 belongs to s2
            type: "subagent",
            description: "d",
            cwd: directory,
          }),
        ).toThrow("Task run does not belong to task session: r2");

        // 4. Default running status, startedAt set, clone returned, event emitted
        const before = store.sessions.get("s1")!.updatedAt;
        const task1 = repository.createSessionTask({
          id: "t1",
          sessionId: "s1",
          runId: "r1",
          childSessionId: "child_s1",
          type: "subagent",
          description: "Task 1",
          cwd: directory,
          metadata: { initial: 1 },
          requestNamespace: "ns1",
          requestId: "req1",
        });
        expect(task1.status).toBe("running");
        expect(task1.startedAt).toBeDefined();
        expect(store.sessions.get("s1")!.updatedAt).toBeGreaterThanOrEqual(before);

        // duplicate request check
        expect(() =>
          repository.createSessionTask({
            sessionId: "s1",
            type: "subagent",
            description: "d",
            cwd: directory,
            requestNamespace: "ns1",
            requestId: "req1",
          }),
        ).toThrow("Session task request already exists: t1");

        // duplicate task id check
        expect(() =>
          repository.createSessionTask({
            id: "t1",
            sessionId: "s1",
            type: "subagent",
            description: "d",
            cwd: directory,
          }),
        ).toThrow("Session task already exists: t1");

        // clone protection
        task1.status = "failed";
        expect(repository.getSessionTask("t1")!.status).toBe("running");

        // event emitted
        const events = store.conversations.listEvents({ sessionId: "s1" });
        const createdEvent = events.find((e) => e.type === "session.task.created");
        expect(createdEvent).toBeDefined();
        expect(createdEvent!.payload).toMatchObject({ task: { id: "t1" } });

        // 5. reserveSessionTask
        const res1 = repository.reserveSessionTask({
          sessionId: "s1",
          requestNamespace: "ns2",
          requestId: "req2",
          type: "subagent",
          description: "Reserve 1",
          cwd: directory,
        });
        expect(res1.created).toBe(true);
        expect(res1.task.status).toBe("pending");
        expect(res1.task.startedAt).toBeUndefined();

        const res2 = repository.reserveSessionTask({
          sessionId: "s1",
          requestNamespace: "ns2",
          requestId: "req2",
          type: "subagent",
          description: "Reserve 2",
          cwd: directory,
        });
        expect(res2.created).toBe(false);
        expect(res2.task.id).toBe(res1.task.id);

        // 6. transitionPendingSessionTask
        const trans1 = repository.transitionPendingSessionTask(res1.task.id, {
          status: "running",
        });
        expect(trans1.transitioned).toBe(true);
        expect(trans1.task.status).toBe("running");
        expect(trans1.task.startedAt).toBeDefined();

        // Already running, transition should return transitioned: false
        const trans2 = repository.transitionPendingSessionTask(res1.task.id, {
          status: "failed",
          error: "err",
        });
        expect(trans2.transitioned).toBe(false);
        expect(trans2.task.status).toBe("running");

        // 7. updateSessionTask: running -> completed, finishedAt set, metadata merged
        const updated = repository.updateSessionTask(res1.task.id, {
          status: "completed",
          output: "success output",
          metadata: { extra: true },
        });
        expect(updated.status).toBe("completed");
        expect(updated.finishedAt).toBeDefined();
        expect(updated.output).toBe("success output");
        expect(updated.metadata).toEqual({ extra: true });

        // Event emitted with previousStatus
        const events2 = store.conversations.listEvents({ sessionId: "s1" });
        const updatedEvent = events2.find(
          (e) =>
            e.type === "session.task.updated" &&
            (e.payload as any).task.id === res1.task.id &&
            (e.payload as any).previousStatus === "running",
        );
        expect(updatedEvent).toBeDefined();
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
