import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SessionStore } from "../store.js";

describe("SessionStore task waiting & notification contracts", () => {
  it("wakes up waiters upon successful update, reserve, and transition, but avoids false wakeups", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-task-wait-"));
    const store = new SessionStore({ path: join(dir, "store.db") });

    try {
      store.sessions.create({ id: "s1", cwd: dir, model: "m" });

      // 1. Reserve creates pending task and notifies
      const res = store.reserveSessionTask({
        sessionId: "s1",
        requestNamespace: "ns1",
        requestId: "r1",
        type: "subagent",
        description: "Task 1",
        cwd: dir,
      });
      expect(res.created).toBe(true);
      const taskId = res.task.id;
      const initialUpdatedAt = res.task.updatedAt;

      // Waiter 1: should wake up when task is transitioned to running
      const waitPromise1 = store.waitForSessionTaskChange(taskId, initialUpdatedAt, {
        timeoutMs: 2000,
      });

      // Failed transition (e.g. invalid runId) should throw and NOT notify
      expect(() =>
        store.transitionPendingSessionTask(taskId, {
          runId: "non_existent_run",
        }),
      ).toThrow("Task run does not belong to task: non_existent_run");

      // reserve with same request (created: false) should NOT notify
      const duplicateReserve = store.reserveSessionTask({
        sessionId: "s1",
        requestNamespace: "ns1",
        requestId: "r1",
        type: "subagent",
        description: "Duplicate",
        cwd: dir,
      });
      expect(duplicateReserve.created).toBe(false);

      // Transition pending to running should succeed and wake up waitPromise1
      const transitionResult = store.transitionPendingSessionTask(taskId, {
        status: "running",
      });
      expect(transitionResult.transitioned).toBe(true);

      const waited1 = await waitPromise1;
      expect(waited1).toBeDefined();
      expect(waited1!.status).toBe("running");
      expect(waited1!.updatedAt).toBeGreaterThan(initialUpdatedAt);

      // Waiter 2: non-transition (already running, transitioned: false) does NOT wake up
      const runningUpdatedAt = waited1!.updatedAt;
      let spuriousWoken = false;
      const waitSpurious = store.waitForSessionTaskChange(taskId, runningUpdatedAt, {
        timeoutMs: 50,
      }).then(() => {
        spuriousWoken = true;
      });

      const failedTransition = store.transitionPendingSessionTask(taskId, {
        status: "failed",
      });
      expect(failedTransition.transitioned).toBe(false);
      // Give tick for potential microtask
      await new Promise((r) => setTimeout(r, 10));
      // waitSpurious should not have been woken by the failed transition
      expect(spuriousWoken).toBe(false);
      await waitSpurious; // completes via timeout

      // Waiter 3: updateSessionTask wakes up waiter
      const waitPromise3 = store.waitForSessionTaskChange(taskId, runningUpdatedAt, {
        timeoutMs: 2000,
      });
      store.updateSessionTask(taskId, {
        status: "completed",
        output: "done",
      });
      const waited3 = await waitPromise3;
      expect(waited3!.status).toBe("completed");
      expect(waited3!.output).toBe("done");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles double-read race condition when task is modified before or during wait registration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-task-race-"));
    const store = new SessionStore({ path: join(dir, "store.db") });

    try {
      store.sessions.create({ id: "s1", cwd: dir, model: "m" });
      const task = store.createSessionTask({
        sessionId: "s1",
        type: "subagent",
        description: "Task race",
        cwd: dir,
      });

      // If 'after' is older than current task.updatedAt, returns immediately without waiting
      const result = await store.waitForSessionTaskChange(task.id, task.updatedAt - 100, {
        timeoutMs: 5000,
      });
      expect(result).toBeDefined();
      expect(result!.id).toBe(task.id);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans up listener on abort signal and on timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-task-clean-"));
    const store = new SessionStore({ path: join(dir, "store.db") });

    try {
      store.sessions.create({ id: "s1", cwd: dir, model: "m" });
      const task = store.createSessionTask({
        sessionId: "s1",
        type: "subagent",
        description: "Task clean",
        cwd: dir,
      });

      // 1. Abort signal cleans up
      const controller = new AbortController();
      const abortPromise = store.waitForSessionTaskChange(task.id, task.updatedAt, {
        timeoutMs: 5000,
        signal: controller.signal,
      });

      const listenersBefore = (store as any).taskListeners.get(task.id);
      expect(listenersBefore).toBeDefined();
      expect(listenersBefore.size).toBe(1);

      controller.abort(new Error("Custom abort"));
      await expect(abortPromise).rejects.toThrow("Custom abort");

      const listenersAfterAbort = (store as any).taskListeners.get(task.id);
      expect(listenersAfterAbort).toBeUndefined();

      // 2. Timeout cleans up
      const timeoutPromise = store.waitForSessionTaskChange(task.id, task.updatedAt, {
        timeoutMs: 20,
      });
      const listenersBeforeTimeout = (store as any).taskListeners.get(task.id);
      expect(listenersBeforeTimeout).toBeDefined();
      expect(listenersBeforeTimeout.size).toBe(1);

      const timeoutResult = await timeoutPromise;
      expect(timeoutResult).toBeDefined();

      const listenersAfterTimeout = (store as any).taskListeners.get(task.id);
      expect(listenersAfterTimeout).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
