import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import type { ModelAttemptAdmission, ModelAttemptSettlement } from "@vykor/agent-contracts";
import { createDefaultNodeAgent } from "./default-agent.js";

it("binds the host gate to actual Run and memory scopes and rejects foreign memory ownership", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vykor-attempt-gate-"));
  const previousConfig = process.env.VYKOR_CONFIG_DIR;
  process.env.VYKOR_CONFIG_DIR = cwd;
  const starts: ModelAttemptAdmission[] = [];
  const finishes: ModelAttemptSettlement[] = [];
  let calls = 0;
  const agent = await createDefaultNodeAgent({ cwd, sessionId: "actual-session", memoryRoot: cwd,
    settings: { model: "test", apiFormat: "anthropic", maxTurns: 2, permission: { mode: "default" }, sandbox: { enabled: false }, plugins: { enabled: false } },
    modelAttempts: { beforeDispatch: async input => { starts.push(input); }, settle: async input => { finishes.push(input); } },
    client: { async *streamMessage(request) {
      calls++;
      yield { type: "text_delta", delta: request.tools?.length === 0 ? '{"memories":[]}' : "answer" };
      yield { type: "complete", stopReason: "end_turn" };
    } },
  });
  try {
    await agent.runMessage("question", { ids: { runId: "actual-run", inputId: "input", traceId: "trace" } });
    expect(starts).toMatchObject([{ purpose: "generation", scope: { agentId: agent.id, sessionId: agent.id, runId: "actual-run", cwd: resolve(cwd) } }]);
    await agent.host.memory.remember({ execution: { scope: { sessionId: agent.id, runId: "actual-run", agentId: "forged", cwd: "/forged" } as never } });
    expect(starts).toMatchObject([{}, { purpose: "memory", scope: { agentId: agent.id, sessionId: agent.id, runId: "actual-run", cwd: resolve(cwd) } }]);
    expect(finishes.map(input => input.usageStatus)).toEqual(["unknown", "unknown"]);
    expect(calls).toBe(2);
    await expect(agent.host.memory.remember({ execution: { scope: { sessionId: "foreign", runId: "foreign-run" } } })).rejects.toThrow(/session/i);
    expect(calls).toBe(2);
    await agent.host.memory.remember();
    expect(calls).toBe(3);
    expect(starts).toHaveLength(2);
  } finally {
    await agent.close();
    if (previousConfig === undefined) delete process.env.VYKOR_CONFIG_DIR; else process.env.VYKOR_CONFIG_DIR = previousConfig;
    await rm(cwd, { recursive: true, force: true });
  }
});
