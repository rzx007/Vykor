import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
  type WorkflowSpec,
} from "@openharness/coordinator";
import {
  ApplicationOwnerConflictError,
  SessionStore,
} from "@openharness/services";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createApplicationBackup,
  restoreApplicationBackup,
} from "../backup/application-backup.js";
import { SessionWorkflowRunRepository } from "../workflow/session-workflow-run-repository.js";

function workflowRepository(store: SessionStore): SessionWorkflowRunRepository {
  return new SessionWorkflowRunRepository({
    workflows: store.workflows,
    events: {
      latestEventSeq: () => store.conversations.latestEventSeq(),
      appendEvent: (input) => store.conversations.appendEvent(input),
    },
    path: store.path,
  });
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable application long-running boundaries", () => {
  it("rejects a second live owner and fences the old generation after stale takeover", () => {
    const dir = temporaryDirectory();
    const path = join(dir, "sessions.db");
    const first = new SessionStore({ path });
    const second = new SessionStore({ path });
    try {
      const firstLease = first.acquireApplicationOwner({
        ownerId: "first",
        pid: 1,
        staleAfterMs: 100,
        now: 1_000,
      });
      first.sessions.create({ id: "owned-session", cwd: dir, model: "test" });

      expect(() =>
        second.acquireApplicationOwner({
          ownerId: "second",
          pid: 2,
          staleAfterMs: 100,
          now: 1_050,
        }),
      ).toThrow(ApplicationOwnerConflictError);

      const secondLease = second.acquireApplicationOwner({
        ownerId: "second",
        pid: 2,
        staleAfterMs: 100,
        now: 1_101,
      });
      expect(secondLease.generation).toBe(firstLease.generation + 1);
      expect(() => first.sessions.create({ cwd: dir, model: "test" })).toThrow(
        ApplicationOwnerConflictError,
      );
      expect(() =>
        first.channels.upsertConversation({
          connector: "test",
          accountId: "account",
          chatId: "chat",
          sessionId: "owned-session",
        }),
      ).toThrow(ApplicationOwnerConflictError);
      second.releaseApplicationOwner(secondLease);
    } finally {
      first.close();
      second.close();
    }
  });

  it("immediately takes over a fresh lease when its owner process is confirmed dead", () => {
    const dir = temporaryDirectory();
    const path = join(dir, "sessions.db");
    const first = new SessionStore({ path });
    const second = new SessionStore({ path });
    try {
      const firstLease = first.acquireApplicationOwner({
        ownerId: "stopped-dev-daemon",
        pid: 12_345,
        staleAfterMs: 30_000,
        now: 1_000,
      });

      const secondLease = second.acquireApplicationOwner({
        ownerId: "restarted-dev-daemon",
        pid: 67_890,
        staleAfterMs: 30_000,
        now: 1_001,
        canTakeOver: (current) => current.pid === 12_345,
      });

      expect(secondLease.generation).toBe(firstLease.generation + 1);
      expect(() => first.sessions.create({ cwd: dir, model: "test" })).toThrow(
        ApplicationOwnerConflictError,
      );
      second.releaseApplicationOwner(secondLease);
    } finally {
      first.close();
      second.close();
    }
  });

  it("stores Workflow facts directly in SQLite", () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    store.sessions.create({ id: "session-1", cwd: dir, model: "test" });
    const workflows = workflowRepository(store);
    workflows.save(workflowSnapshot("workflow-1", "session-1", "completed"));
    expect(workflows.load("workflow-1")).toMatchObject({
      ownerSession: "session-1",
      status: "completed",
    });
    store.close();
  });

  it("backs up the database and files, verifies checksums, and restores into an empty location", async () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({
      path: join(dir, "source", "sessions.db"),
    });
    store.sessions.create({ id: "session-1", cwd: dir, model: "test" });
    store.acquireApplicationOwner({
      ownerId: "source",
      pid: 1,
      staleAfterMs: 10_000,
    });
    const memory = join(dir, "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "fact.md"), "durable fact", "utf-8");
    const attachmentBytes = "attachment bytes";
    const attachmentHash = createHash("sha256").update(attachmentBytes).digest("hex");
    store.attachments.createImportingAttachment({
      id: "att-backup",
      displayName: "附件.txt",
      stagingName: "att-backup.part",
      createdAt: 1,
    });
    store.attachments.markAttachmentReady("att-backup", {
      sha256: attachmentHash,
      sizeBytes: Buffer.byteLength(attachmentBytes),
      mediaType: "text/plain",
      updatedAt: 2,
    });
    const attachments = join(dir, "attachments");
    const attachmentBucket = join(attachments, "blobs", attachmentHash.slice(0, 2));
    mkdirSync(attachmentBucket, { recursive: true });
    writeFileSync(join(attachmentBucket, attachmentHash), attachmentBytes);
    const backup = join(dir, "backup");
    const createdManifest = await createApplicationBackup({
      store,
      destination: backup,
      sources: { memory, attachments },
    });
    expect(createdManifest).toMatchObject({
      version: 2,
      directories: { attachments: true },
      attachments: {
        assets: 1,
        uniqueBlobs: 1,
        physicalBytes: 16,
        consistency: { errors: 0, warnings: 0, issueCounts: {} },
      },
    });

    const checksumsPath = join(backup, "checksums.json");
    const checksums = JSON.parse(
      readFileSync(checksumsPath, "utf-8"),
    ) as Record<string, string>;
    writeFileSync(
      checksumsPath,
      JSON.stringify(Object.fromEntries(Object.entries(checksums).reverse())),
    );

    const occupiedMemory = join(dir, "occupied-memory");
    mkdirSync(occupiedMemory);
    writeFileSync(join(occupiedMemory, "keep.txt"), "keep");
    const blockedStorePath = join(dir, "blocked", "sessions.db");
    expect(() =>
      restoreApplicationBackup({
        source: backup,
        storePath: blockedStorePath,
        destinations: { memory: occupiedMemory },
      }),
    ).toThrow("not empty");
    expect(existsSync(blockedStorePath)).toBe(false);

    expect(() =>
      restoreApplicationBackup({
        source: backup,
        storePath: join(dir, "duplicate", "sessions.db"),
        destinations: { memory: join(dir, "same-target"), attachments: join(dir, "same-target") },
      }),
    ).toThrow("distinct");
    expect(() =>
      restoreApplicationBackup({
        source: backup,
        storePath: join(backup, "nested-sessions.db"),
        destinations: { attachments: join(dir, "unused-attachments") },
      }),
    ).toThrow("inside the backup source");

    const restoredPath = join(dir, "restored", "sessions.db");
    const restoredMemory = join(dir, "restored-memory");
    const restoredAttachments = join(dir, "restored-attachments");
    const manifest = restoreApplicationBackup({
      source: backup,
      storePath: restoredPath,
      destinations: { memory: restoredMemory, attachments: restoredAttachments },
    });
    expect(manifest.recovery.reviveLiveProcesses).toBe(false);
    expect(
      readdirSync(dir).some((name) => name.includes(".restore-")),
    ).toBe(false);
    const restored = new SessionStore({ path: restoredPath });
    expect(restored.sessions.get("session-1")).toBeDefined();
    expect(existsSync(join(
      restoredAttachments,
      "blobs",
      attachmentHash.slice(0, 2),
      attachmentHash,
    ))).toBe(true);
    expect(
      restored.acquireApplicationOwner({
        ownerId: "restored",
        pid: 2,
        staleAfterMs: 10_000,
      }),
    ).toMatchObject({ generation: 1 });
    restored.close();
    store.close();
  });

  it("refuses to create an attachment backup when a ready blob is missing", async () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    try {
      store.attachments.createImportingAttachment({
        id: "att-missing",
        displayName: "missing.txt",
        stagingName: "att-missing.part",
        createdAt: 1,
      });
      store.attachments.markAttachmentReady("att-missing", {
        sha256: "f".repeat(64),
        sizeBytes: 7,
        mediaType: "text/plain",
        updatedAt: 2,
      });

      await expect(createApplicationBackup({
        store,
        destination: join(dir, "backup"),
        sources: { attachments: join(dir, "attachments") },
      })).rejects.toThrow("att-missing");
    } finally {
      store.close();
    }
  });

  it("retention keeps active Workflow facts and records an audit", () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    store.sessions.create({ id: "session-1", cwd: dir, model: "test" });
    const workflows = workflowRepository(store);
    const running = workflowSnapshot("running-1", "session-1", "running");
    running.updatedAt = 1;
    workflows.save(running);
    const result = store.applyRetention(
      {
        durableEventMaxAgeMs: 1,
        workflowEventMaxAgeMs: 1,
        workflowRunMaxAgeMs: 1,
        runAttemptMaxAgeMs: 1,
        projectionSettlementMaxAgeMs: 1,
        completedJobVisibleForMs: 1,
        terminalOutputMaxBytes: 1,
      },
      10_000,
    );
    expect(result.workflows).toBe(0);
    expect(workflows.load("running-1")).toBeDefined();
    expect(store.listRetentionAudits()).toHaveLength(1);
    store.close();
  });

  it("wakes Workflow waiters from repository changes without Store polling", async () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    store.sessions.create({ id: "session-1", cwd: dir, model: "test" });
    const workflows = workflowRepository(store);
    const running = workflowSnapshot("wait-1", "session-1", "running");
    workflows.save(running);
    const waiting = workflows.waitForChange("wait-1", running.updatedAt, {
      timeoutMs: 1_000,
    });
    workflows.save(workflowSnapshot("wait-1", "session-1", "completed"));
    await expect(waiting).resolves.toMatchObject({ status: "completed" });
    store.close();
  });

  it("does not miss a Workflow change between the first read and listener registration", async () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    store.sessions.create({ id: "session-1", cwd: dir, model: "test" });
    const workflows = workflowRepository(store);
    const running = workflowSnapshot("race-1", "session-1", "running");
    running.updatedAt = 100;
    workflows.save(running);
    const originalLoad = workflows.load.bind(workflows);
    let reads = 0;
    vi.spyOn(workflows, "load").mockImplementation((runId) => {
      reads += 1;
      if (reads === 2) {
        const completed = workflowSnapshot("race-1", "session-1", "completed");
        completed.updatedAt = 101;
        workflows.save(completed);
      }
      return originalLoad(runId);
    });

    await expect(
      workflows.waitForChange("race-1", 100, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ status: "completed", updatedAt: 101 });
    store.close();
  });

  it.each(["after registration", "during first load"])("wakes a Workflow waiter for an event-only change %s before timeout", async (timing) => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    store.sessions.create({ id: "session-1", cwd: dir, model: "test" });
    const workflows = workflowRepository(store);
    const running = workflowSnapshot("event-wait-1", "session-1", "running");
    workflows.save(running);
    const appendEvent = () => workflows.appendEvent({ runId: "event-wait-1", type: "workflow_started", timestamp: Date.now(), status: "running", summary: "started" } as any);
    const originalLoad = workflows.load.bind(workflows);
    const load = vi.spyOn(workflows, "load");
    vi.useFakeTimers();
    try {
      if (timing === "during first load") {
        load.mockImplementationOnce((runId) => {
          const snapshot = originalLoad(runId);
          appendEvent(); // No listener exists yet; only the change version can wake this wait.
          return snapshot;
        });
      }
      let settled = false;
      const waiting = workflows.waitForChange("event-wait-1", running.updatedAt, { timeoutMs: 1_000 }).then((snapshot) => {
        settled = true;
        return snapshot;
      });
      if (timing === "after registration") appendEvent();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await expect(waiting).resolves.toMatchObject({ status: "running", updatedAt: running.updatedAt });
    } finally {
      load.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
      store.close();
    }
  });

  it("keeps a Workflow event but does not notify after session event mirroring fails", async () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    store.sessions.create({ id: "session-1", cwd: dir, model: "test" });
    const onDurableEvent = vi.fn();
    const workflows = new SessionWorkflowRunRepository({
      workflows: store.workflows,
      path: store.path,
      events: {
        latestEventSeq: () => store.conversations.latestEventSeq(),
        appendEvent: () => { throw new Error("mirror failed"); },
      },
      onDurableEvent,
    });
    const running = workflowSnapshot("mirror-fail-1", "session-1", "running");
    workflows.save(running);
    let settled = false;
    const waiting = workflows.waitForChange("mirror-fail-1", running.updatedAt, { timeoutMs: 1_000 }).then((snapshot) => {
      settled = true;
      return snapshot;
    });
    expect(() => workflows.appendEvent({ runId: "mirror-fail-1", type: "workflow_started", timestamp: Date.now(), status: "running", summary: "started" } as any)).toThrow("mirror failed");
    expect(store.workflows.listEvents("mirror-fail-1")).toHaveLength(1);
    expect(onDurableEvent).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    workflows.save(workflowSnapshot("mirror-fail-1", "session-1", "completed"));
    await expect(waiting).resolves.toMatchObject({ status: "completed" });
    store.close();
  });

  it("rejects a duplicate Workflow claim in the same Application", () => {
    const dir = temporaryDirectory();
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    store.sessions.create({ id: "session-1", cwd: dir, model: "test" });
    const workflows = workflowRepository(store);
    workflows.save(workflowSnapshot("claimed-1", "session-1", "running"));
    workflows.claim("claimed-1");
    expect(() => workflows.claim("claimed-1")).toThrow("already claimed");
    workflows.finish("claimed-1", "failed");
    store.close();
  });
});

function workflowSnapshot(
  runId: string,
  ownerSession: string,
  status: "running" | "completed" | "failed",
) {
  const spec: WorkflowSpec = { mode: "sequential", tasks: [{ id: "one" }] };
  return createWorkflowRunSnapshot({
    runId,
    ownerSession,
    status,
    summary: runId,
    spec,
    plan: createWorkflowPlan(spec),
    results: new Map(),
    running: status === "running" ? new Set(["one"]) : new Set(),
    createdAt: Date.now(),
  });
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openharness-durability-"));
  temporaryDirectories.push(directory);
  return directory;
}
