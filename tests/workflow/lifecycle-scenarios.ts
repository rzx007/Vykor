import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowHost } from "@vykor/agent-runtime/node/workflow";
import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
  type WorkflowRunRepository,
} from "@vykor/coordinator/workflow";
import type { AgentRunScope } from "@vykor/core";

export function workflowLifecycleScenarios(
  name: string,
  create: () => { repository: WorkflowRunRepository; cleanup?: () => void },
) {
  describe(`${name} workflow host lifecycle`, () => {
    const resources: Array<{ host: WorkflowHost; cleanup?: () => void }> = [];
    const setup = () => {
      const resource = create();
      const host = new WorkflowHost(resource.repository);
      resources.push({ host, cleanup: resource.cleanup });
      return host;
    };
    const scope = (
      sessionId = "owner",
      signal = new AbortController().signal,
    ): AgentRunScope => ({
      agentId: "agent",
      sessionId,
      runId: "run",
      inputId: "input",
      traceId: "trace",
      cwd: "/work",
      signal,
    });
    const spec = { mode: "parallel" as const, tasks: [{ id: "work" }] };
    afterEach(async () => {
      for (const resource of resources.splice(0)) {
        try {
          await resource.host.close();
        } finally {
          resource.cleanup?.();
        }
      }
    });
    it("saves before returning the job and serves history/timeline from the same owner view", async () => {
      const host = setup();
      let release!: () => void;
      const bound = host.bind({
        cwd: "/work",
        sessionId: "owner",
        createRunner: () => async () => {
          await new Promise<void>((yes) => {
            release = yes;
          });
          return { summary: "done" };
        },
      });
      const owner = scope();
      const request = new AbortController();
      const created = await bound.invoke({
        input: { ...spec, runId: "created" },
        scope: owner,
        signal: request.signal,
      });
      expect(created.isError).toBeUndefined();
      expect(host.repository.load("created")?.status).toBe("running");
      request.abort();
      expect(
        (
          await bound.jobs.read({
            sessionId: "owner",
            jobId: "workflow:created",
          })
        ).snapshot.status,
      ).toBe("running");
      release();
      await vi.waitFor(() =>
        expect(host.repository.load("created")?.status).toBe("completed"),
      );
      for (const action of ["history", "timeline"]) {
        const result = await bound.invoke({
          input: { action, runId: "created" },
          scope: owner,
          signal: owner.signal,
        });
        expect(result.isError).toBeUndefined();
        expect(JSON.stringify(result.content)).toContain("created");
      }
      await expect(
        bound.jobs.read({ sessionId: "other", jobId: "created" }),
      ).rejects.toThrow("owner");
    });
    it("resumes saved results without repeating completed work", async () => {
      const host = setup();
      const resumed = {
        mode: "pipeline" as const,
        tasks: [{ id: "first" }, { id: "second" }],
      };
      host.repository.save(
        createWorkflowRunSnapshot({
          runId: "resume",
          ownerSession: "owner",
          status: "running",
          summary: "saved",
          spec: resumed,
          plan: createWorkflowPlan(resumed),
          results: new Map([
            [
              "first",
              {
                taskId: "first",
                status: "completed",
                summary: "saved",
                attempts: 1,
                dependencies: [],
                startedAt: 1,
                finishedAt: 2,
              },
            ],
          ]),
          running: new Set(),
          createdAt: 1,
        }),
      );
      const runner = vi.fn(async () => ({ summary: "resumed" }));
      await host.resumePersistentWorkflow("resume", runner);
      expect(runner).toHaveBeenCalledOnce();
      expect(runner.mock.calls[0]?.[0]?.task.id).toBe("second");
      expect(host.repository.load("resume")?.status).toBe("completed");
    });
    it("cancel waits for worker cleanup before saving the terminal result", async () => {
      const host = setup();
      let release!: () => void;
      let interrupted = false;
      const work = host.runPersistentWorkflow(
        spec,
        async ({ signal }) => {
          await new Promise<void>((yes) => {
            release = yes;
            signal!.addEventListener(
              "abort",
              () => {
                interrupted = true;
              },
              { once: true },
            );
          });
          return { summary: "late result" };
        },
        { runId: "cancel", ownerSession: "owner" },
      );
      let finished = false;
      const cancel = host.cancelPersistentWorkflow("cancel").then((result) => {
        finished = true;
        return result;
      });
      await Promise.resolve();
      expect(interrupted).toBe(true);
      expect(finished).toBe(false);
      expect(host.repository.load("cancel")?.status).toBe("running");
      release();
      await Promise.all([work, cancel]);
      expect(host.repository.load("cancel")?.termination).toBe("cancelled");
      expect(host.repository.loadEvents("cancel").at(-1)?.type).toBe(
        "workflow_cancelled",
      );
    });
    it("parent cancellation and owner close do not close another owner's run", async () => {
      const host = setup();
      const parent = new AbortController();
      const runner = async ({ signal }: { signal?: AbortSignal }) => {
        await new Promise<void>((yes) => {
          signal!.addEventListener("abort", () => yes(), { once: true });
          if (signal!.aborted) yes();
        });
        return { summary: "settled" };
      };
      const first = host.runPersistentWorkflow(spec, runner, {
        runId: "first",
        ownerSession: "first",
        signal: parent.signal,
      });
      const second = host.runPersistentWorkflow(spec, runner, {
        runId: "second",
        ownerSession: "second",
      });
      parent.abort();
      await first;
      await vi.waitFor(() =>
        expect(host.repository.load("first")?.termination).toBe("cancelled"),
      );
      await host.bind({ cwd: "/work", sessionId: "first" }).close();
      expect(host.repository.load("second")?.status).toBe("running");
      await host.close();
      await second;
      expect(host.repository.load("second")?.termination).toBe("cancelled");
      expect(() => host.runPersistentWorkflow(spec, runner)).toThrow("closed");
    });
    it("request cancellation ends a wait without cancelling the owning run", async () => {
      const host = setup();
      let release!: () => void;
      const bound = host.bind({
        cwd: "/work",
        sessionId: "owner",
        createRunner: () => async () => {
          await new Promise<void>((yes) => {
            release = yes;
          });
          return { summary: "done" };
        },
      });
      const request = new AbortController();
      const owner = scope();
      const waiting = bound.invoke({
        input: { ...spec, runId: "wait", waitForCompletion: true },
        scope: owner,
        signal: request.signal,
      });
      request.abort(new Error("wait cancelled"));
      expect((await waiting).isError).toBe(true);
      expect(host.repository.load("wait")?.status).toBe("running");
      release();
      await vi.waitFor(() =>
        expect(host.repository.load("wait")?.status).toBe("completed"),
      );
    });
    it("non-persistent runs complete without adding durable snapshots", async () => {
      const host = setup();
      const bound = host.bind({
        cwd: "/work",
        sessionId: "owner",
        createRunner: () => async () => ({ summary: "ephemeral" }),
      });
      const owner = scope();
      expect(
        (
          await bound.invoke({
            input: { ...spec, persist: false },
            scope: owner,
            signal: owner.signal,
          })
        ).isError,
      ).toBeUndefined();
      expect(host.repository.list()).toEqual([]);
    });
  });
}
