import { createJobTools } from "../../packages/tools/src/job/job-tools.js";
import type { AgentJobHost, JobSnapshot } from "@vykor/jobs";
import { QueryEngine, ToolRegistry } from "@vykor/core/engine";
import type { StreamEvent, ToolResult } from "@vykor/agent-contracts";
import { expect, it, vi } from "vitest";

const snapshot: JobSnapshot = {
  id: "terminal-1",
  kind: "terminal",
  label: "dev server",
  ownerSession: "session-1",
  status: "running",
  capabilities: { read: true, wait: true, send: true, cancel: true },
  cwd: "/repo",
  startedAt: 1,
  updatedAt: 2,
};


it("returns a running snapshot before the engine deadline without cancelling the job", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => snapshot);
      const wait = vi.fn(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, input.timeoutMs));
        return { text: "still working", cursor: 4, truncated: false, snapshot, timedOut: true };
      });
      const registry = new ToolRegistry();
      const jobs = context({ wait, cancel }).jobs;
      registry.register(createJobTools(jobs).find(tool => tool.name === "JobWait")!);
      let request = 0;
      const client = {
        async *streamMessage() {
          if (request++ === 0) {
            yield { type: "tool_use_start" as const, toolUse: {
              type: "tool_use" as const, id: "wait-1", name: "JobWait",
              input: { targets: [{ target: { kind: "terminal", jobId: "terminal-1" } }], timeoutSeconds: 420 },
            } };
            yield { type: "complete" as const, stopReason: "tool_use" };
          } else {
            yield { type: "text_delta" as const, delta: "The background job is still running." };
            yield { type: "complete" as const, stopReason: "end_turn" };
          }
        },
      };
      const engine = new QueryEngine(client, registry,
        { checkTool: async () => ({ action: "allow" as const }) },
        { execute: async () => ({ blocked: false }) },
        { sessionId: "session-1", toolTimeoutMs: 5_000 });

      const events: StreamEvent[] = [];
      const running = (async () => {
        for await (const event of engine.submitMessage("Wait for the existing job")) events.push(event);
      })();
      await vi.advanceTimersByTimeAsync(5_000);
      await running;
      const ended = events.find((event) => event.type === "tool_use_end");
      expect(ended?.type).toBe("tool_use_end");
      if (ended?.type !== "tool_use_end") throw new Error("Missing wait result");
      expect(ended.result.isError).not.toBe(true);
      expect(payload(ended.result)).toMatchObject({ results: [{ timedOut: true, snapshot: { status: "running" } }] });
      expect(wait).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 4_000 }));
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });


function context(overrides: Partial<AgentJobHost>) {
  const jobs: AgentJobHost = {
    list: async () => [],
    read: async () => ({ text: "", cursor: 0, truncated: false, snapshot }),
    wait: async () => ({ text: "", cursor: 0, truncated: false, snapshot, timedOut: false }),
    send: async () => undefined,
    cancel: async () => snapshot,
    ...overrides,
  };
  return { cwd: "/repo", sessionId: "session-1", jobs };
}

function payload(result: ToolResult): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("Expected text result");
  return JSON.parse(block.text) as Record<string, unknown>;
}
