import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore } from "../session-runtime/store.js";

afterEach(() => vi.restoreAllMocks());

it("persists the original run finish time even when its terminal status is repeated", () => {
  const directory = mkdtempSync(join(tmpdir(), "vk-run-timing-"));
  const path = join(directory, "store.db");
  let store = new SessionStore({ path });
  try {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    store.sessions.create({ id: "session", cwd: directory, model: "test" });
    store.runs.createRun({ id: "run", sessionId: "session" });
    store.runs.updateRun("run", { status: "running" });
    clock.mockReturnValue(5_000);
    store.runs.updateRun("run", { status: "completed" });
    clock.mockReturnValue(20_000);
    store.runs.updateRun("run", {
      status: "completed",
      metadata: { inspected: true },
    });
    store.close();
    store = new SessionStore({ path });
    expect(store.runs.getRun("run")).toMatchObject({
      startedAt: 1_000,
      finishedAt: 5_000,
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps a task's finish stable but records a new interval when the task is restarted", () => {
  const directory = mkdtempSync(join(tmpdir(), "vk-task-timing-"));
  const store = new SessionStore({ path: join(directory, "store.db") });
  try {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    store.sessions.create({ id: "session", cwd: directory, model: "test" });
    store.runs.createSessionTask({
      id: "task",
      sessionId: "session",
      type: "agent",
      description: "check",
      cwd: directory,
    });
    clock.mockReturnValue(5_000);
    store.runs.updateSessionTask("task", { status: "completed" });
    clock.mockReturnValue(8_000);
    store.runs.updateSessionTask("task", { status: "completed" });
    expect(store.runs.getSessionTask("task")?.finishedAt).toBe(5_000);
    clock.mockReturnValue(10_000);
    store.runs.updateSessionTask("task", { status: "running" });
    clock.mockReturnValue(15_000);
    expect(
      store.runs.updateSessionTask("task", { status: "completed" }),
    ).toMatchObject({ startedAt: 10_000, finishedAt: 15_000 });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
