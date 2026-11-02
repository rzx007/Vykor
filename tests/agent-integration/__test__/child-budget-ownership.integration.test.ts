import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentChildHandle, ToolResult } from "@vykor/agent-contracts";
import { createLifecycleFixture, invokeLifecycleTool } from "./fixtures/task-lifecycle-fixture.js";

function body(result: ToolResult) {
  const block = result.content.find(block => block.type === "text");
  if (block?.type !== "text") throw new Error("Missing tool response body");
  return JSON.parse(block.text);
}

describe.each(["sdk", "daemon"] as const)("child budget ownership: %s", mode => {
  it("finishes more than 40 work rounds without accepting a model turn cap", async () => {
    const f = await createLifecycleFixture(mode, { maxTurns: 0 });
    try {
      let results!: ToolResult[];
      await f.inRootRun(async execution => {
        results = f.scriptChild("long-work", Array.from({ length: 41 }, (_, index) => {
          const file = join(execution.scope.cwd, `read-${index}.txt`);
          writeFileSync(file, `evidence-${index}`);
          return { name: "Read", input: { file_path: file } };
        }));
      });
      const receipt = await invokeLifecycleTool(f, "Agent", {
        prompt: "long-work", description: "long-work", subagentType: "worker", maxTurns: 1,
      });
      const handle = f.agent.children.get(receipt.jobId)!;
      expect(handle.sessionId).toBe(receipt.childSessionId);
      expect((await handle.waitRun(receipt.runId)).result).toMatchObject({
        status: "completed", output: "completed:long-work",
      });
      expect(results).toHaveLength(41);
      expect(results.every(result => !result.isError)).toBe(true);
      expect(handle.activity?.modelTurns).toBe(42);
      expect(f.agent.host.inspect().childBudget).toMatchObject({ activeChildren: 0, totalChildren: 1 });
      if (f.store) expect(f.store.runs.getRun(receipt.runId)?.status).toBe("completed");
    } finally { await f.close(); }
  });

  it.each(["settings", "role"] as const)("enforces the host %s budget without automatic renewal", async source => {
    const label = "host-capped";
    const f = await createLifecycleFixture(mode, {
      maxTurns: source === "settings" ? 2 : 0,
      failure: { label, kind: "max_turns" },
    });
    try {
      let handle!: AgentChildHandle;
      let runId!: string;
      if (source === "settings") {
        const child = await f.spawn(label);
        handle = child.handle;
        runId = child.target.runId;
      } else {
        await f.inRootRun(async execution => {
          const receipt = await execution.children.spawnChildAgent({
            prompt: label, description: label, agent: "worker", cwd: execution.scope.cwd,
            allowedTools: ["Read"], maxTurns: 2, requestedMaxTurns: 100,
          });
          handle = f.agent.children.get(receipt.id)!;
          runId = receipt.runId;
        });
      }
      expect((await handle.waitRun(runId)).result).toMatchObject({
        status: "failed", failureKind: "max_turns", error: "Exceeded maximum agentic turns (2)",
        partialResult: { childSessionId: handle.sessionId, runId, source: "limit_finalization" },
      });
      const read = await f.read({ kind: "agent", jobId: handle.id, runId });
      expect(read.snapshot.metadata?.childFailure).toMatchObject({ failureKind: "max_turns" });
      expect(f.modelCalls(label)).toBe(2);
      expect(handle.runId).toBe(runId);
      expect(handle.state).toBe("idle");
      expect(f.agent.host.inspect().childBudget).toMatchObject({ activeChildren: 0, totalChildren: 1 });
      if (f.store) expect(f.store.runs.getRun(runId)?.status).toBe("failed");
    } finally { await f.close(); }
  });

  it("lets the built-in worker wait for its real Shell while denying a parent-owned target", async () => {
    const f = await createLifecycleFixture(mode);
    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('worker-wait-output')"`;
    try {
      const parentJob = await invokeLifecycleTool(f, "BackgroundShellCreate", { command, description: "parent-only" });
      const results = f.scriptChild("worker-wait", [
        { name: "BackgroundShellCreate", input: { command, description: "worker-owned" } },
        { name: "JobWait", input: results => ({
          targets: [{ target: body(results[0]!).target }], timeoutSeconds: 5,
        }) },
        { name: "JobWait", input: { targets: [{ target: parentJob.target }], timeoutSeconds: 0.01 } },
      ]);
      const { handle, target } = await f.spawn("worker-wait");
      expect((await handle.waitRun(target.runId)).result?.status).toBe("completed");
      expect(results).toHaveLength(3);
      expect(results.every(result => !result.isError), JSON.stringify(results)).toBe(true);
      const own = body(results[1]!).results[0];
      expect(own.timedOut).toBe(false);
      expect(own.snapshot).toMatchObject({ status: "completed", ownerSession: handle.sessionId });
      expect(own.text).toContain("worker-wait-output");
      expect(body(results[2]!).results[0].error).toContain("Job not found");
      if (f.store) expect(f.store.runs.getSessionTask(body(results[0]!).jobId)).toMatchObject({
        sessionId: handle.sessionId, status: "completed",
      });
    } finally { await f.close(); }
  });
});
