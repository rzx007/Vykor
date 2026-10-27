import { AgentChildManager } from "../../../kernel/children/child-agent.js";
import { AgentEventBus } from "../../../kernel/event-source.js";
import { createAgentKernel, createBasicAgentKernelRuntime } from "../../../kernel/index.js";
import type { AgentChildController, AgentExecutionContext } from "@vykor/agent-contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWorkflowNotification } from "@vykor/coordinator";

import { createAgentWorkflowRunner } from "../agent-workflow-runner.js";
import { FileWorkflowRunRepository } from "../file-workflow-run-repository.js";
import { WorkflowHost } from "../workflow-host.js";
import { createWorkflowTool as toolDefinition } from "@vykor/tools";

let tempDir: string | undefined;
let savedConfigDir: string | undefined;

beforeEach(() => {
  savedConfigDir = process.env.VYKOR_CONFIG_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "oh-workflow-smoke-"));
  process.env.VYKOR_CONFIG_DIR = join(tempDir, "config");
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
  else process.env.VYKOR_CONFIG_DIR = savedConfigDir;
  if (tempDir)
    rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  tempDir = undefined;
});

describe("Workflow tool smoke", () => {
  it("runs through Workflow and the real child run", async () => {
    const spawned: Array<
      Parameters<AgentChildController["spawnChildAgent"]>[0]
    > = [];
    const manager = new AgentChildManager({ cwd: tempDir!, eventBus: new AgentEventBus(),
      resolveChild: ({ spawn, sessionId }) => {
        spawned.push(spawn);
        const taskName = spawn.sessionId?.match(/^wf-(.+)-\d+-/)?.[1] ?? spawn.agent;
        return { spawn, createAgent: () => createAgentKernel({ cwd: tempDir!, sessionId,
          engine: createBasicAgentKernelRuntime({ model: "test", client: { async *streamMessage() {
            yield { type: "text_delta", delta: `worker:${taskName}` };
            yield { type: "complete", stopReason: "end_turn" };
          } } }), effects: { requestPermission: async () => ({ status: "approved" }) },
          preparation: { prepare: async () => ({ run: { tools: new Map() }, release() {} }) },
        }) };
      },
    });
    const scope = { agentId: "leader", sessionId: "s1", inputId: "i1", runId: "r1", traceId: "t1", cwd: tempDir!, signal: new AbortController().signal };
    const agent = { scope, children: manager.createController(scope), effects: { requestPermission: async () => ({ status: "approved" }) }, emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {} } as AgentExecutionContext;
    const host = new WorkflowHost(
      new FileWorkflowRunRepository({ cwd: tempDir! }),
    );
    const bound = host.bind({
      cwd: tempDir!,
      sessionId: "s1",
      children: manager,
      createRunner: (options) =>
        createAgentWorkflowRunner({
          ...options,
          getDiffSummary: async () => ({
            changedFiles: [],
            insertions: 0,
            deletions: 0,
          }),
          getAgentDefinition: () => undefined,
        }),
    });

    const tool = toolDefinition(bound);
    const result = await tool.execute(
      {
        mode: "pipeline",
        waitForCompletion: true,
        timeoutSeconds: 5,
        tasks: [
          { id: "research", prompt: "find relevant files" },
          { id: "verify", prompt: "verify using prior output" },
        ],
      },
      { cwd: tempDir!, agent },
    );

    const text = textOf(result);
    const notification = parseWorkflowNotification(text);
    expect(result.isError).toBeUndefined();
    expect(notification).toMatchObject({
      status: "completed",
      summary: "2/2 tasks completed",
      mode: "pipeline",
      totalTasks: 2,
      completedTasks: 2,
      failedTasks: 0,
    });
    expect(notification?.tasks.map((task) => task.taskId)).toEqual([
      "research",
      "verify",
    ]);
    expect(notification?.tasks[0]?.result).toContain("worker:research");
    expect(notification?.tasks[1]?.result).toContain("worker:verify");
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.prompt).toContain("Pipeline input:");
    expect(spawned[1]!.prompt).toContain("worker:research");

    const stored = new FileWorkflowRunRepository({ cwd: tempDir! }).list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("completed");
    await manager.closeAll();
    expect(stored[0]?.orderedResults.map((task) => task.taskId)).toEqual([
      "research",
      "verify",
    ]);
  });
});

function textOf(
  result: Awaited<ReturnType<ReturnType<typeof toolDefinition>["execute"]>>,
): string {
  const block = result.content[0];
  return block && "text" in block ? String(block.text) : "";
}
