import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkflowHost } from "@vykor/agent-runtime/node/workflow";
import { SessionStore } from "@vykor/services";
import { expect, it } from "vitest";

import { workflowLifecycleScenarios } from "../../../../../../tests/workflow/lifecycle-scenarios.js";
import { DaemonJobService } from "../../../jobs/daemon-job-service.js";
import type { DaemonTerminalService } from "../../../terminal/index.js";
import { SessionWorkflowRunRepository } from "../session-workflow-run-repository.js";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "vykor-sqlite-workflow-host-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  for (const id of ["owner", "first", "second"]) {
    store.sessions.create({ id, cwd: directory, model: "test" });
  }
  store.conversationTransactions.admitPrompt({
    id: "input",
    sessionId: "owner",
    content: "workflow",
  });
  store.runs.createRun({ id: "run", sessionId: "owner", inputId: "input" });
  const repository = new SessionWorkflowRunRepository({
    workflows: store.workflows,
    events: {
      latestEventSeq: () => store.conversations.latestEventSeq(),
      appendEvent: (input) => store.conversations.appendEvent(input),
    },
    path: store.path,
    sessionExists: (id) => !!store.sessions.get(id),
  });
  return {
    directory,
    store,
    repository,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

workflowLifecycleScenarios("SQLite", fixture);

it("DaemonJobService cancels its shared live WorkflowHost and waits for worker cleanup", async () => {
  const { store, repository, cleanup: cleanupFixture } = fixture();
  const host = new WorkflowHost(repository);
  const jobs = new DaemonJobService({ getSession: id => store.sessions.get(id) }, sessionId => host.bind({ cwd: store.sessions.get(sessionId)!.cwd, sessionId }).jobs);
  const started = latch();
  const aborted = latch();
  const cleanup = latch();
  let workerClosed = false;
  let settled = false;
  const run = host.runPersistentWorkflow(
    { mode: "sequential", tasks: [{ id: "one" }] },
    async ({ signal }) => {
      signal!.addEventListener("abort", aborted.release, { once: true });
      if (signal!.aborted) aborted.release();
      started.release();
      await aborted.promise;
      await cleanup.promise;
      workerClosed = true;
      return { status: "killed", summary: "worker stopped" };
    },
    { runId: "active", ownerSession: "owner" },
  );
  try {
    await started.promise;
    const cancelling = jobs.cancel({
      sessionId: "owner",
      target: { kind: "workflow", jobId: "active" },
    });
    void cancelling.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await aborted.promise;
    await Promise.resolve();
    expect(workerClosed).toBe(false);
    expect(settled).toBe(false);
    expect(repository.load("active")?.status).toBe("running");
    cleanup.release();
    await expect(cancelling).resolves.toMatchObject({
      id: "active",
      status: "killed",
    });
    await run;
    expect(workerClosed).toBe(true);
    expect(repository.load("active")).toMatchObject({
      status: "failed",
      termination: "cancelled",
    });
    expect(repository.loadEvents("active")).toContainEqual(
      expect.objectContaining({ type: "workflow_cancelled" }),
    );
  } finally {
    cleanup.release();
    try {
      await host.close();
      await run;
    } finally {
      cleanupFixture();
    }
  }
});
