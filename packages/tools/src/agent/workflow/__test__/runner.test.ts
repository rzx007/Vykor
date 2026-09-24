import { describe, expect, it, vi } from "vitest";
import { runWorkflow, type WorkflowTaskRunResult } from "@vykor/coordinator";
import type { AwaitExecutionResult } from "@vykor/services";
import {
  createAgentWorkflowRunner,
  type WorkflowWorkerSpawnConfig,
  type WorkflowWorkerSpawnResult,
} from "../runner.js";

function completedDependency(taskId: string, result: string): WorkflowTaskRunResult {
  return {
    taskId,
    status: "completed",
    summary: `${taskId} summary`,
    result,
    attempts: 1,
    dependencies: [],
    startedAt: 1,
    finishedAt: 2,
  };
}

describe("createAgentWorkflowRunner", () => {
  it("spawns a child worker and waits for its execution", async () => {
    const spawnWorker = vi.fn(async (_config: WorkflowWorkerSpawnConfig): Promise<WorkflowWorkerSpawnResult> => ({
      success: true,
      agentId: "worker@alpha",
      taskId: "task_1",
      backendType: "subprocess",
      worktree: { path: "/wt/worker", branch: "worktree-worker" },
    }));
    const awaitTask = vi.fn(async (_taskId: string): Promise<AwaitExecutionResult> => ({
      status: "completed",
      output: "worker result",
      exitCode: 0,
    }));
    const getAgentDefinition = vi.fn(() => ({
      name: "worker",
      description: "Worker",
      systemPrompt: "system",
      tools: ["Read"],
      disallowedTools: ["Bash"],
      maxTurns: 5,
      effort: "high",
      permissionMode: "plan",
    }));

    const runner = createAgentWorkflowRunner({
      cwd: "/repo",
      team: "alpha",
      timeoutMs: 500,
      spawnWorker,
      awaitTask,
      getAgentDefinition,
    });

    const result = await runner({
      task: { id: "implement", prompt: "patch it", subagentType: "worker", isolate: true },
      attempt: 2,
      dependencyResults: {},
    });

    expect(spawnWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "worker",
        team: "alpha",
        prompt: "patch it",
        cwd: "/repo",
        model: undefined,
        systemPrompt: "system",
        permissionMode: "plan",
        isolate: true,
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
        maxTurns: 5,
        effort: "high",
      }),
    );
    expect(spawnWorker.mock.calls[0]![0].sessionId).toContain("wf-implement-2-");
    expect(awaitTask).toHaveBeenCalledWith("task_1", { timeoutMs: 500 });
    expect(result).toEqual({
      status: "completed",
      summary: "implement finished with exit code 0",
      result: "worker result",
      metadata: {
        agentId: "worker@alpha",
        workerTaskId: "task_1",
        backendType: "subprocess",
        worktree: { path: "/wt/worker", branch: "worktree-worker" },
      },
    });
  });

  it("injects dependency results and pipeline input into the worker prompt", async () => {
    const spawnWorker = vi.fn(async (_config: WorkflowWorkerSpawnConfig): Promise<WorkflowWorkerSpawnResult> => ({
      success: true,
      agentId: "worker@default",
      taskId: "task_2",
      backendType: "subprocess",
    }));
    const awaitTask = vi.fn(async (): Promise<AwaitExecutionResult> => ({
      status: "completed",
      output: "ok",
    }));
    const runner = createAgentWorkflowRunner({
      cwd: "/repo",
      spawnWorker,
      awaitTask,
      getAgentDefinition: () => undefined,
    });

    await runner({
      task: { id: "verify", prompt: "verify it" },
      attempt: 1,
      dependencyResults: {
        research: completedDependency("research", "found src/auth.ts"),
      },
      pipelineInput: completedDependency("implement", "changed src/auth.ts"),
    });

    const prompt = spawnWorker.mock.calls[0]![0].prompt;
    expect(prompt).toContain("verify it");
    expect(prompt).toContain("Dependency results:");
    expect(prompt).toContain("- research: completed - research summary");
    expect(prompt).toContain("found src/auth.ts");
    expect(prompt).toContain("Pipeline input:");
    expect(prompt).toContain("- previous: completed - implement summary");
    expect(prompt).toContain("changed src/auth.ts");
  });

  it("applies configurable worker behavior in budget conservation mode", async () => {
    const spawnWorker = vi.fn(async (_config: WorkflowWorkerSpawnConfig): Promise<WorkflowWorkerSpawnResult> => ({
      success: true,
      agentId: "worker@default",
      taskId: "task_conserve",
      backendType: "subprocess",
    }));
    const runner = createAgentWorkflowRunner({
      cwd: "/repo",
      spawnWorker,
      awaitTask: async () => ({ status: "completed", output: "ok" }),
      getAgentDefinition: () => undefined,
    });

    await runner({
      task: { id: "verify", prompt: "verify it" },
      attempt: 1,
      dependencyResults: {},
      budgetMode: "conserve",
      budgetConserve: {
        promptHint: "Only inspect the smallest relevant files.",
        permissionMode: "plan",
        maxTurns: 3,
      },
    });

    expect(spawnWorker.mock.calls[0]![0]).toEqual(expect.objectContaining({
      permissionMode: "plan",
      maxTurns: 3,
    }));
    expect(spawnWorker.mock.calls[0]![0].prompt).toContain("Only inspect the smallest relevant files.");
  });

  it("adds changed files and diff summary from the worker cwd to result metadata", async () => {
    const runner = createAgentWorkflowRunner({
      cwd: "/repo",
      spawnWorker: async () => ({
        success: true,
        agentId: "worker@default",
        taskId: "task_changed",
        backendType: "subprocess",
        worktree: { path: "/wt/worker", branch: "worktree-worker" },
      }),
      awaitTask: async () => ({ status: "completed", output: "ok", exitCode: 0 }),
      getDiffSummary: vi.fn(async (cwd) => {
        expect(cwd).toBe("/wt/worker");
        return {
          changedFiles: ["src/auth.ts", "docs\\plan.md"],
          files: [
            { path: "src/auth.ts", status: "modified", insertions: 10, deletions: 2 },
            { path: "docs\\plan.md", status: "added", insertions: 5, deletions: 0 },
          ],
          added: 0,
          modified: 0,
          deleted: 0,
          renamed: 0,
          untracked: 0,
          insertions: 0,
          deletions: 0,
        };
      }),
      getAgentDefinition: () => undefined,
    });

    const result = await runner({ task: { id: "implement" }, attempt: 1, dependencyResults: {} });

    expect(result.metadata?.changedFiles).toEqual(["docs/plan.md", "src/auth.ts"]);
    expect(result.metadata?.diff).toEqual(expect.objectContaining({
      added: 1,
      modified: 1,
      insertions: 15,
      deletions: 2,
    }));
  });

  it("maps spawn failures, stopped tasks, and timed-out waits to workflow statuses", async () => {
    const spawnFailure = createAgentWorkflowRunner({
      cwd: "/repo",
      spawnWorker: async () => ({
        success: false,
        agentId: "worker@default",
        taskId: "",
        backendType: "subprocess",
        error: "no backend",
      }),
      awaitTask: async () => ({ status: "completed", output: "unreachable" }),
      getAgentDefinition: () => undefined,
    });

    await expect(
      spawnFailure({ task: { id: "spawn" }, attempt: 1, dependencyResults: {} }),
    ).resolves.toMatchObject({ status: "failed", summary: "no backend" });

    const stopped = createAgentWorkflowRunner({
      cwd: "/repo",
      spawnWorker: async () => ({
        success: true,
        agentId: "worker@default",
        taskId: "task_stopped",
        backendType: "subprocess",
      }),
      awaitTask: async () => ({ status: "stopped", output: "stopped" }),
      getAgentDefinition: () => undefined,
    });

    await expect(
      stopped({ task: { id: "stop" }, attempt: 1, dependencyResults: {} }),
    ).resolves.toMatchObject({ status: "killed", result: "stopped" });

    const stopTask = vi.fn(async () => undefined);
    const timedOut = createAgentWorkflowRunner({
      cwd: "/repo",
      spawnWorker: async () => ({
        success: true,
        agentId: "worker@default",
        taskId: "task_timeout",
        backendType: "subprocess",
      }),
      awaitTask: async () => ({ status: "running", output: "still working", timedOut: true }),
      stopTask,
      getAgentDefinition: () => undefined,
    });

    await expect(
      timedOut({ task: { id: "slow" }, attempt: 1, dependencyResults: {} }),
    ).resolves.toMatchObject({
      status: "failed",
      summary: "slow did not finish before timeout",
      metadata: expect.objectContaining({ timedOut: true }),
    });
    expect(stopTask).toHaveBeenCalledWith("task_timeout");
  });

  it("preserves the framework child failure kind for workflow policy decisions", async () => {
    const runner = createAgentWorkflowRunner({
      cwd: "/repo",
      spawnWorker: async () => ({
        success: true,
        agentId: "worker@default",
        taskId: "task_failed",
        backendType: "framework",
      }),
      awaitTask: async () => ({
        status: "failed",
        failureKind: "failed",
        output: "lint failed",
      }),
      getAgentDefinition: () => undefined,
    });

    await expect(runner({
      task: { id: "lint" },
      attempt: 1,
      dependencyResults: {},
    })).resolves.toMatchObject({
      status: "failed",
      result: "lint failed",
      metadata: { failureKind: "failed" },
    });
  });

  it("workflow retry spawns a fresh child run for every visible attempt", async () => {
    const sessions: string[] = [];
    const spawnWorker = vi.fn(async (config: WorkflowWorkerSpawnConfig): Promise<WorkflowWorkerSpawnResult> => {
      sessions.push(config.sessionId);
      return {
        success: true,
        agentId: "worker@default",
        taskId: `task_${sessions.length}`,
        backendType: "framework",
      };
    });
    const awaitTask = vi.fn()
      .mockResolvedValueOnce({ status: "failed", failureKind: "failed", output: "temporary" })
      .mockResolvedValueOnce({ status: "completed", failureKind: "completed", output: "recovered" });
    const runner = createAgentWorkflowRunner({
      cwd: "/repo",
      spawnWorker,
      awaitTask,
      getAgentDefinition: () => undefined,
    });

    const result = await runWorkflow({
      mode: "parallel",
      tasks: [{ id: "flaky", retry: { maxAttempts: 2 } }],
    }, runner);

    expect(result.results.flaky).toMatchObject({ status: "completed", attempts: 2 });
    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(new Set(sessions).size).toBe(2);
    expect(sessions[0]).toContain("wf-flaky-1-");
    expect(sessions[1]).toContain("wf-flaky-2-");
  });

  it("requests stop when a resumed workflow task wait times out", async () => {
    const stopTask = vi.fn(async () => undefined);
    const runner = createAgentWorkflowRunner({
      cwd: "/repo",
      spawnWorker: async () => {
        throw new Error("should not spawn");
      },
      awaitTask: async () => ({ status: "running", output: "still working", timedOut: true }),
      stopTask,
      getAgentDefinition: () => undefined,
    });

    await expect(
      runner({
        task: { id: "slow" },
        attempt: 1,
        dependencyResults: {},
        resumeFrom: {
          taskId: "slow",
          attempt: 1,
          dependencies: [],
          startedAt: 1,
          summary: "old task",
          metadata: {
            agentId: "worker@default",
            workerTaskId: "task_resume_timeout",
            backendType: "subprocess",
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      metadata: expect.objectContaining({ timedOut: true }),
    });
    expect(stopTask).toHaveBeenCalledWith("task_resume_timeout");
  });

  it("waits for an existing execution when resuming a running workflow task", async () => {
    const spawnWorker = vi.fn(async (): Promise<WorkflowWorkerSpawnResult> => {
      throw new Error("should not spawn");
    });
    const awaitTask = vi.fn(async (_taskId: string): Promise<AwaitExecutionResult> => ({
      status: "completed",
      output: "resumed output",
      exitCode: 0,
    }));
    const progress: unknown[] = [];
    const runner = createAgentWorkflowRunner({
      cwd: "/repo",
      spawnWorker,
      awaitTask,
      getAgentDefinition: () => undefined,
    });

    const result = await runner({
      task: { id: "implement", prompt: "patch it" },
      attempt: 1,
      dependencyResults: {},
      resumeFrom: {
        taskId: "implement",
        attempt: 1,
        dependencies: [],
        startedAt: 1,
        summary: "old task",
        metadata: {
          agentId: "worker@default",
          workerTaskId: "task_existing",
          backendType: "subprocess",
        },
      },
      reportProgress: (update) => progress.push(update),
    });

    expect(spawnWorker).not.toHaveBeenCalled();
    expect(awaitTask).toHaveBeenCalledWith("task_existing", { timeoutMs: undefined });
    expect(result).toMatchObject({
      status: "completed",
      result: "resumed output",
      metadata: {
        agentId: "worker@default",
        workerTaskId: "task_existing",
        backendType: "subprocess",
      },
    });
    expect(progress).toContainEqual(expect.objectContaining({
      summary: "Waiting for existing task task_existing",
    }));
  });

  it("spawns a replacement worker when the resumed execution is unavailable", async () => {
    const spawnWorker = vi.fn(async (): Promise<WorkflowWorkerSpawnResult> => ({
      success: true,
      agentId: "worker@default",
      taskId: "task_new",
      backendType: "subprocess",
    }));
    const awaitTask = vi
      .fn()
      .mockRejectedValueOnce(new Error("Task not found: task_old"))
      .mockResolvedValueOnce({ status: "completed", output: "new output", exitCode: 0 } satisfies AwaitExecutionResult);
    const runner = createAgentWorkflowRunner({
      cwd: "/repo",
      spawnWorker,
      awaitTask,
      getAgentDefinition: () => undefined,
    });

    const result = await runner({
      task: { id: "implement", prompt: "patch it" },
      attempt: 1,
      dependencyResults: {},
      resumeFrom: {
        taskId: "implement",
        attempt: 1,
        dependencies: [],
        startedAt: 1,
        summary: "old task",
        metadata: { workerTaskId: "task_old" },
      },
    });

    expect(awaitTask).toHaveBeenNthCalledWith(1, "task_old", { timeoutMs: undefined });
    expect(awaitTask).toHaveBeenNthCalledWith(2, "task_new", { timeoutMs: undefined });
    expect(spawnWorker).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "completed",
      result: "new output",
      metadata: { workerTaskId: "task_new" },
    });
  });

  it("defaults to the framework child-agent controller", async () => {
    const agent = {
      scope: { agentId: "leader", sessionId: "s1", inputId: "i1", runId: "r1", traceId: "t1", cwd: "/repo", signal: new AbortController().signal },
      effects: { requestPermission: vi.fn(async () => ({ status: "approved" as const })) },
      emit: vi.fn(),
      takeSteeredInputs: async () => [],
      closeSteering: vi.fn(),
      children: {
        hasChildAgent: vi.fn((id: string) => id === "task_framework"),
        spawnChildAgent: vi.fn(async () => ({
          id: "task_framework",
          sessionId: "child-1",
          result: Promise.resolve({ status: "completed" as const, output: "ok" }),
        })),
        sendChildInput: vi.fn(async () => {}),
        interruptChildAgent: vi.fn(async () => {}),
        awaitChildAgent: vi.fn(async () => ({ status: "completed" as const, output: "ok" })),
      },
    };
    const runner = createAgentWorkflowRunner({
      cwd: "/repo",
      agent,
      getDiffSummary: async () => ({ changedFiles: [], insertions: 0, deletions: 0 }),
      getAgentDefinition: () => undefined,
    });

    const result = await runner({ task: { id: "default-mode" }, attempt: 1, dependencyResults: {} });

    expect(result.metadata?.backendType).toBe("framework");
    expect(result.metadata?.workerTaskId).toBe("task_framework");
    expect(agent.children.spawnChildAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: "worker",
      cwd: "/repo",
    }));
    expect(agent.children.awaitChildAgent).toHaveBeenCalledWith("task_framework");
  });

  it("can be used by runWorkflow as a real runner adapter", async () => {
    const spawnWorker = vi.fn(async (config: WorkflowWorkerSpawnConfig): Promise<WorkflowWorkerSpawnResult> => ({
      success: true,
      agentId: `${config.name}@${config.team}`,
      taskId: `task_${config.prompt.includes("implement") ? "implement" : "research"}`,
      backendType: "subprocess",
    }));
    const awaitTask = vi.fn(async (taskId: string): Promise<AwaitExecutionResult> => ({
      status: "completed",
      output: `${taskId} output`,
      exitCode: 0,
    }));
    const runner = createAgentWorkflowRunner({
      cwd: "/repo",
      spawnWorker,
      awaitTask,
      getAgentDefinition: () => undefined,
    });

    const result = await runWorkflow(
      {
        mode: "pipeline",
        tasks: [
          { id: "research", prompt: "research" },
          { id: "implement", prompt: "implement" },
        ],
      },
      runner,
    );

    expect(result.status).toBe("completed");
    expect(result.results.research?.metadata?.workerTaskId).toBe("task_research");
    expect(result.results.implement?.metadata?.workerTaskId).toBe("task_implement");
    expect(spawnWorker.mock.calls[1]![0].prompt).toContain("Pipeline input:");
  });
});
