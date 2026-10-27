import { describe, expect, it, vi } from "vitest";
import type { AgentChildSpawnInput, AgentRunScope } from "@vykor/agent-contracts";
import { AgentChildManager } from "../../../kernel/children/child-agent.js";
import { AgentEventBus } from "../../../kernel/event-source.js";
import { createAgentKernel, createBasicAgentKernelRuntime } from "../../../kernel/index.js";
import { createAgentWorkflowRunner } from "../agent-workflow-runner.js";

function fixture(failure = false) {
  const spawned: AgentChildSpawnInput[] = [];
  const manager = new AgentChildManager({ cwd: "/repo", eventBus: new AgentEventBus(),
    resolveChild: ({ spawn, sessionId }) => {
      spawned.push(spawn);
      return { spawn, createAgent: () => createAgentKernel({ cwd: spawn.cwd, sessionId,
        engine: createBasicAgentKernelRuntime({ model: "test", client: { async *streamMessage() {
          if (failure) throw new Error("actual model failure");
          yield { type: "text_delta", delta: "actual child output" };
          yield { type: "complete", stopReason: "end_turn" };
        } } }), effects: { requestPermission: async () => ({ status: "approved" }) },
        preparation: { prepare: async () => ({ run: { tools: new Map() }, release() {} }) },
      }) };
    },
  });
  const scope: AgentRunScope = { agentId: "parent", sessionId: "parent", inputId: "input", runId: "run", traceId: "trace", cwd: "/repo", signal: new AbortController().signal };
  const controller = manager.createController(scope);
  return { manager, controller, spawned };
}
describe("real child Workflow runner", () => {
  it("waits the receipt's real run and preserves role settings, inputs and changes", async () => {
    const f = fixture();
    try {
      const runner = createAgentWorkflowRunner({ cwd: "/repo", children: f.manager, agent: { children: f.controller },
        getAgentDefinition: () => ({ name: "worker", description: "worker", model: "inherit", effort: "high", tools: ["Read"], timeoutSeconds: 20, maxTurns: 3 }),
        getChangedFiles: async () => ["b.ts", "a.ts", "a.ts"],
      });
      const result = await runner({ task: { id: "work", prompt: "do it", isolate: true }, attempt: 1, dependencyResults: {}, pipelineInput: { taskId: "previous", status: "completed", summary: "prior", result: "evidence", attempts: 1, dependencies: [], startedAt: 1, finishedAt: 2 } });
      expect(f.spawned[0]).toMatchObject({ model: "inherit", effort: "high", allowedTools: ["Read"], timeoutSeconds: 20, maxTurns: 3, isolate: true });
      expect(f.spawned[0]!.prompt).toContain("Pipeline input:");
      expect(result).toMatchObject({ status: "completed", result: "actual child output", metadata: { workerTaskId: expect.any(String), workerRunId: expect.any(String), changedFiles: ["a.ts", "b.ts"] } });
      const child = f.manager.get(result.metadata!.workerTaskId as string)!;
      expect((await child.waitRun(result.metadata!.workerRunId as string)).result?.output).toBe(result.result);
      expect(child.state).toBe("suspended");
    } finally { await f.manager.closeAll(); }
  });
  it("does not create a substitute when querying the original receipt fails", async () => {
    const f = fixture();
    try {
      const child = await f.controller.spawnChildAgent({ description: "worker", prompt: "original", agent: "worker", cwd: "/repo" });
      await child.result;
      const handle = f.manager.get(child.id)!;
      const original = handle.waitRun.bind(handle);
      handle.waitRun = async () => { throw new Error("original query failed"); };
      const runner = createAgentWorkflowRunner({ cwd: "/repo", children: f.manager, agent: { children: f.controller } });
      const result = await runner({ task: { id: "work" }, attempt: 1, dependencyResults: {}, resumeFrom: { taskId: "work", attempt: 1, dependencies: [], startedAt: 1, metadata: { workerTaskId: child.id, workerRunId: child.runId } } });
      expect(result).toMatchObject({ status: "failed", summary: "Error: original query failed", metadata: { retryable: false, workerQueryFailed: true } });
      expect(f.spawned).toHaveLength(1);
      handle.waitRun = original;
    } finally { await f.manager.closeAll(); }
  });
  it("fails missing archived receipts without replay or another backend", async () => {
    const f = fixture();
    try {
      const runner = createAgentWorkflowRunner({ cwd: "/repo", children: f.manager, agent: { children: f.controller } });
      await expect(runner({ task: { id: "work" }, attempt: 1, dependencyResults: {}, resumeFrom: { taskId: "work", attempt: 1, dependencies: [], startedAt: 1, metadata: { workerTaskId: "missing", workerRunId: "original" } } })).rejects.toThrow("handle is unavailable");
      expect(f.spawned).toHaveLength(0);
    } finally { await f.manager.closeAll(); }
  });
  it("reports a stopped original whose identity was concurrently closed without claiming unknown cleanup", async () => {
    const f = fixture();
    try {
      const controller = { ...f.controller, spawnChildAgent: async (input: AgentChildSpawnInput) => {
        const child = await f.controller.spawnChildAgent(input);
        await child.result;
        await f.manager.close(child.id);
        return child;
      } };
      const runner = createAgentWorkflowRunner({ cwd: "/repo", children: f.manager, agent: { children: controller } });
      const result = await runner({ task: { id: "closed" }, attempt: 1, dependencyResults: {} });
      expect(result).toMatchObject({ status: "failed", result: "actual child output", metadata: { retryable: false, workerQueryFailed: true } });
      expect(result.metadata?.cleanupUnconfirmed).toBeUndefined();
      expect(f.spawned).toHaveLength(1);
    } finally { await f.manager.closeAll(); }
  });

  it("preserves the actual model failure kind", async () => {
    const f = fixture(true);
    try {
      const runner = createAgentWorkflowRunner({ cwd: "/repo", children: f.manager, agent: { children: f.controller } });
      const result = await runner({ task: { id: "work" }, attempt: 1, dependencyResults: {} });
      const actual = (await f.manager.get(result.metadata!.workerTaskId as string)!.waitRun(result.metadata!.workerRunId as string)).result!;
      expect(result).toMatchObject({ status: "failed", result: actual.output });
      expect(result.metadata?.failureKind).toBe(actual.failureKind);
    } finally { await f.manager.closeAll(); }
  });
});
