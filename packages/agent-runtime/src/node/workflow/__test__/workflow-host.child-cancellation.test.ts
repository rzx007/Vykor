import type { AgentRunScope } from "@vykor/agent-contracts";
import { describe, expect, it } from "vitest";
import { AgentChildManager } from "../../../kernel/children/child-agent.js";
import { AgentEventBus } from "../../../kernel/event-source.js";
import {
  createAgentKernel,
  createBasicAgentKernelRuntime,
} from "../../../kernel/index.js";
import { MemoryWorkflowRunRepository } from "../memory-workflow-run-repository.js";
import { WorkflowHost } from "../workflow-host.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("custom WorkflowHost child cancellation", () => {
  it.each(["job", "parent", "owner", "host"] as const)(
    "%s cancellation pins the real child run without closing the reusable identity",
    async (source) => {
      const parent = new AbortController();
      const scope: AgentRunScope = {
        agentId: "agent",
        sessionId: "owner",
        runId: "parent",
        inputId: "input",
        traceId: "trace",
        cwd: "/work",
        signal: parent.signal,
      };
      const started = deferred();
      let releases = 0;
      let childId!: string;
      const manager = new AgentChildManager({
        cwd: scope.cwd,
        eventBus: new AgentEventBus(),
        resolveChild: ({ spawn, sessionId }) => ({
          spawn,
          createAgent: () =>
            createAgentKernel({
              cwd: scope.cwd,
              sessionId,
              engine: createBasicAgentKernelRuntime({
                model: "test",
                client: {
                  async *streamMessage({ abortSignal }) {
                    await new Promise<void>((resolve) => {
                      abortSignal!.addEventListener("abort", () => resolve(), {
                        once: true,
                      });
                      if (abortSignal!.aborted) resolve();
                    });
                    yield { type: "complete", stopReason: "end_turn" };
                  },
                },
              }),
              effects: {
                requestPermission: async () => ({ status: "approved" }),
              },
              preparation: {
                prepare: async () => ({
                  run: { tools: new Map() },
                  release() {},
                }),
              },
              release: async () => {
                releases += 1;
              },
            }),
        }),
      });
      const children = manager.createController(scope);
      const repository = new MemoryWorkflowRunRepository();
      const host = new WorkflowHost(repository);
      // Custom hosts supply the existing child directory, never a mirror controller.
      const bound = host.bind({
        cwd: scope.cwd,
        sessionId: scope.sessionId,
        children: manager,
        createRunner:
          () =>
          async ({ reportProgress }) => {
            const child = await children.spawnChildAgent({
              description: "worker",
              agent: "worker",
              prompt: "wait",
              cwd: scope.cwd,
            });
            childId = child.id;
            reportProgress?.({ metadata: { workerTaskId: child.id, workerRunId: child.runId } });
            started.resolve();
            await children.awaitChildAgent(child.id);
            return { summary: "worker stopped" };
          },
      });
      let stopping: Promise<void> | undefined;
      try {
        const created = await bound.invoke({
          input: { mode: "parallel", runId: "cancel", tasks: [{ id: "work" }] },
          scope,
          signal: scope.signal,
          children,
        });
        expect(created.isError).toBeUndefined();
        await started.promise;
        let settled = false;
        const stop = async () => {
          if (source === "job")
            await bound.jobs.cancel({
              sessionId: "owner",
              target: { kind: "workflow", jobId: "cancel" },
            });
          else if (source === "owner") await bound.close();
          else if (source === "host") await host.close();
          else {
            parent.abort(new Error("parent cancelled"));
            const result = await bound.jobs.wait({
              sessionId: "owner",
              target: { kind: "workflow", jobId: "cancel" },
              timeoutMs: 1_000,
            });
            expect(result.timedOut).toBe(false);
          }
        };
        stopping = stop().finally(() => {
          settled = true;
        });
        void stopping.catch(() => {});
        await expect(stopping).resolves.toBeUndefined();
        expect(settled).toBe(true);
        expect(children.hasChildAgent(childId)).toBe(true);
        expect(manager.get(childId)?.state).toBe("idle");
        expect(releases).toBe(0);
        expect(repository.load("cancel")).toMatchObject({
          status: "failed",
          termination: "cancelled",
          runningTaskIds: [],
        });
        expect(repository.loadEvents("cancel").at(-1)?.type).toBe(
          "workflow_cancelled",
        );
        await expect(bound.close()).resolves.toBeUndefined();
        await expect(host.close()).resolves.toBeUndefined();
        await expect(host.close()).resolves.toBeUndefined();
        expect(releases).toBe(0);
      } finally {
        await Promise.allSettled([stopping, host.close(), manager.closeAll()]);
      }
    },
  );
});
