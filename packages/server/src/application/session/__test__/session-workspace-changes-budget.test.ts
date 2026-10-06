import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const slowGit = vi.hoisted(() => ({ children: new Set<any>(), started: undefined as (() => void) | undefined, marker: "", pidFile: "", overflow: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (command: string, args: string[], options: object) => {
    if (command !== "git") return actual.spawn(command, args, options);
    // Replace only the external Git program with a real slow child. Keep production
    // spawn options, tree termination, close delivery and the owner/inspector real.
    const body = slowGit.overflow
      ? "const fs = require('fs'); const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => require(\"fs\").writeFileSync(process.argv[1], \"orphan late write\"), 5000)', process.argv[1]], { stdio: 'ignore' }); fs.writeFileSync(process.argv[2], String(child.pid)); process.stdout.write('x'.repeat(3 * 1024 * 1024)); setTimeout(() => {}, 5000);"
      : "setTimeout(() => { require('fs').writeFileSync(process.argv[1], 'late write'); console.log('not-repository'); }, 5000)";
    const child = actual.spawn(process.execPath, ["-e", body, slowGit.marker, slowGit.pidFile], options);
    slowGit.children.add(child);
    child.once("spawn", () => slowGit.started?.());
    child.once("close", () => slowGit.children.delete(child));
    return child;
  } };
});

import { SessionStore } from "@vykor/services";
import { createGitRunChangeInspector } from "../../auto-review/git-run-change-inspector.js";
import { SessionWorkspaceChanges } from "../session-workspace-changes.js";
import { SessionEventPublisher } from "../session-event-publisher.js";
import { reviewAutoReview } from "../run-auto-review.js";
import { SessionRunCoordinator } from "../../../runtime/run-coordinator.js";

describe("bounded cancellable workspace observation", () => {
  let dir: string, store: SessionStore, sessionId: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "workspace-budget-"));
    store = new SessionStore({ path: join(dir, "sessions.db") });
    sessionId = store.sessions.create({ cwd: dir, model: "offline" }).id;
    slowGit.marker = join(dir, "late-marker");
    slowGit.pidFile = join(dir, "owned-child-pid"); slowGit.overflow = false;
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  function owner(captureBudgetMs: number, settleBudgetMs: number, settle = false) {
    const real = createGitRunChangeInspector();
    return new SessionWorkspaceChanges({ session: store,
      events: new SessionEventPublisher(store.conversations, { broadcastSince: () => {}, broadcastEvent: () => {} }),
      inspector: settle ? { capture: async () => ({ repositoryRoot: dir.replace(/\\/g, "/"), head: "a".repeat(40), dirty: {} }), compare: (cwd, baseline, signal) => real.compare(cwd, baseline, signal) } : real,
      captureBudgetMs, settleBudgetMs,
    } as any);
  }
  async function withinDeadline(work: Promise<unknown>): Promise<boolean> {
    let timer!: ReturnType<typeof setTimeout>;
    try { return await Promise.race([work.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 1500); })]); }
    finally { clearTimeout(timer); }
  }
  async function cleanOwnedChildren(pending: Promise<unknown>) {
    for (const child of slowGit.children) child.kill();
    await pending;
  }

  it.each(["capture", "settle"] as const)("ends the whole %s budget and waits for its child to close", async (phase) => {
    const id = store.runs.createRun({ sessionId }).id;
    const svc = owner(30, 30, phase === "settle");
    if (phase === "settle") await svc.capture(id, dir, dir);
    store.runs.updateRun(id, { status: "completed" }); const finishedAt = store.runs.getRun(id)!.finishedAt;
    const pending = phase === "capture" ? svc.capture(id, dir, dir) : svc.settle(id);
    try {
      expect(await withinDeadline(pending)).toBe(true);
      expect(slowGit.children.size).toBe(0);
      expect(existsSync(slowGit.marker)).toBe(false);
      expect(store.runs.getRun(id)).toMatchObject({ status: "completed", finishedAt, metadata: { workspaceChanges: { status: "unavailable", reason: "observation_budget_exceeded" } } });
    } finally { await cleanOwnedChildren(pending); }
  });

  it("cancels settlement, closes Git, and lets the next same-session input execute without a late write", async () => {
    const id = store.runs.createRun({ sessionId }).id; const svc = owner(1000, 5000, true);
    await svc.capture(id, dir, dir); store.runs.updateRun(id, { status: "completed" });
    const finishedAt = store.runs.getRun(id)!.finishedAt;
    let started!: () => void; const childStarted = new Promise<void>((resolve) => { started = resolve; }); slowGit.started = started;
    const coordinator = new SessionRunCoordinator();
    const first = coordinator.enqueue({ sessionId, runId: id, work: (context) => reviewAutoReview({
      workspaceChanges: svc, data: store, log: () => {}, traceIdForRun: () => "offline",
    }, { sessionId, inputId: "offline", runId: id, cwd: dir, agent: {} as any, signal: context.signal }) });
    let nextRan = false;
    const second = coordinator.enqueue({ sessionId, runId: "next", work: async () => { nextRan = true; } });
    await childStarted; coordinator.interruptRun(sessionId, id, "cancelled");
    try {
      expect(await withinDeadline(second.promise)).toBe(true);
      expect(nextRan).toBe(true);
      expect(slowGit.children.size).toBe(0);
      expect(existsSync(slowGit.marker)).toBe(false);
      expect(store.runs.getRun(id)).toMatchObject({ status: "completed", finishedAt, metadata: { workspaceChanges: { status: "unavailable", reason: "observation_cancelled" } } });
    } finally { await cleanOwnedChildren(first.promise); await second.promise; slowGit.started = undefined; }
  });

  it("stops the owned tree on output overflow instead of leaving the launcher's descendant alive", async () => {
    slowGit.overflow = true;
    const id = store.runs.createRun({ sessionId }).id; const svc = owner(5000, 5000);
    const pending = svc.capture(id, dir, dir);
    let descendant: number | undefined;
    try {
      await pending; descendant = Number(readFileSync(slowGit.pidFile, "utf8"));
      expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
      let alive = false;
      try { process.kill(descendant, 0); alive = true; } catch {}
      expect(alive).toBe(false);
      expect(slowGit.children.size).toBe(0);
      expect(existsSync(slowGit.marker)).toBe(false);
      expect(store.runs.getRun(id)?.metadata.workspaceChanges).toMatchObject({ status: "unavailable", reason: "git_inspection_failed" });
    } finally {
      if (descendant && Number.isSafeInteger(descendant)) { try { process.kill(descendant); } catch {} }
      await cleanOwnedChildren(pending);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
});
