import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentChildBudgetExceededError,
  type AgentEvent,
  type Settings,
  type StreamingMessageClient,
} from "@vykor/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentOperationConflictError } from "./agent.js";
import { AgentChildRegistry } from "./child-agent.js";
import { createDefaultNodeAgent } from "./default-agent.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vykor-post-run-child-"));
  tempDirs.push(dir);
  return dir;
}

const SETTINGS: Settings = {
  apiFormat: "openai",
  model: "test-model",
  maxTurns: 5,
  permission: { mode: "default" },
  plugins: { enabled: false },
  memory: { enabled: false },
  sandbox: { enabled: false },
  childBudget: { maxTotalChildren: 64, maxActiveChildren: 8, maxDepth: 4 },
};

function passingClient(onRequest?: (params: { tools?: unknown[]; messages: unknown[] }) => void): StreamingMessageClient {
  return {
    async *streamMessage(params) {
      onRequest?.(params as { tools?: unknown[]; messages: unknown[] });
      yield { type: "text_delta" as const, delta: '{"version":1,"verdict":"pass","summary":"ok","findings":[]}' };
      yield { type: "complete" as const, stopReason: "end_turn" };
    },
  };
}

const PARENT = { inputId: "root-input", runId: "root-run", traceId: "root-trace" };

function reviewInput(cwd: string) {
  return {
    description: "review the run",
    prompt: "Review one patch (summary only)",
    agent: "review",
    cwd,
    requestedMaxTurns: 10,
    requestedTimeoutSeconds: 120,
    scope: "packages/server/src/queue.ts",
    expectedResult: "one JSON verdict",
  };
}

describe("runChildForCompletedRun", () => {
  it("runs a strictly read-only child attributed to the completed parent run", async () => {
    const cwd = tempDir();
    const events: AgentEvent[] = [];
    const requests: Array<{ tools?: unknown[]; messages: unknown[] }> = [];
    const agent = await createDefaultNodeAgent({
      cwd,
      settings: SETTINGS,
      client: passingClient((params) => requests.push(params)),
      onEvent: (event) => events.push(event),
    });
    try {
      const { invocation, result } = await agent.runChildForCompletedRun(
        reviewInput(cwd),
        PARENT,
        "SECRET_PATCH_CONTENT",
      );

      expect(result.status).toBe("completed");
      expect(invocation.sessionId).toMatch(/^agent_session_/);

      const created = events.find((event) => event.type === "child.created");
      expect(created).toBeDefined();
      expect(created?.context.runId).toBe(PARENT.runId);
      expect(created?.context.traceId).toBe(PARENT.traceId);
      expect(JSON.stringify(created)).not.toContain("SECRET_PATCH_CONTENT");

      const accepted = events.filter((event) => event.type === "input.accepted");
      expect(accepted).toHaveLength(1);
      expect(JSON.stringify(accepted[0]?.data)).toContain("SECRET_PATCH_CONTENT");
      expect(JSON.stringify(events.filter((event) => event.type !== "input.accepted"))).not.toContain(
        "SECRET_PATCH_CONTENT",
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]!.tools ?? []).toEqual([]);
    } finally {
      await agent.close();
    }
  });

  it("rejects model input, maintenance, and a second review while one review is active", async () => {
    const cwd = tempDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: StreamingMessageClient = {
      async *streamMessage() {
        await gate;
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const agent = await createDefaultNodeAgent({ cwd, settings: SETTINGS, client });
    try {
      const review = agent.runChildForCompletedRun(reviewInput(cwd), PARENT, "patch");
      await vi.waitFor(() => expect(agent.state).toBe("maintaining"));

      expect(() => agent.submitMessage("hello")).toThrow(AgentOperationConflictError);
      expect(() => agent.compact()).toThrow(AgentOperationConflictError);
      expect(() => agent.remember()).toThrow(AgentOperationConflictError);
      expect(() => agent.runChildForCompletedRun(reviewInput(cwd), PARENT, "patch")).toThrow(
        AgentOperationConflictError,
      );

      release();
      await review;
    } finally {
      await agent.close();
    }
  });

  it("terminates the child when the parent signal aborts", async () => {
    const cwd = tempDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        markStarted();
        await gate;
        if (params.abortSignal?.aborted) throw new Error("aborted");
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const controller = new AbortController();
    const agent = await createDefaultNodeAgent({ cwd, settings: SETTINGS, client });
    try {
      const review = agent.runChildForCompletedRun(
        reviewInput(cwd),
        { ...PARENT, signal: controller.signal },
        "patch",
      );
      await started;
      controller.abort();
      release();
      const { result } = await review;
      expect(result.status).not.toBe("completed");
    } finally {
      await agent.close();
    }
  });

  it("does not consume the model-callable cumulative child budget", async () => {
    const cwd = tempDir();
    const agent = await createDefaultNodeAgent({
      cwd,
      settings: SETTINGS,
      client: passingClient(),
      childBudget: { maxTotalChildren: 1, maxActiveChildren: 8, maxDepth: 4 },
    });
    try {
      for (let index = 0; index < 65; index += 1) {
        const { result } = await agent.runChildForCompletedRun(reviewInput(cwd), PARENT, "patch");
        expect(result.status).toBe("completed");
      }
      expect(agent.inspect().childBudget).toMatchObject({ totalChildren: 0, activeChildren: 0 });
    } finally {
      await agent.close();
    }
  }, 120_000);
});

describe("AgentChildRegistry system reservations", () => {
  it("counts system children against depth and active limits but not the cumulative total", () => {
    const registry = new AgentChildRegistry({ maxDepth: 4, maxActiveChildren: 8, maxTotalChildren: 1 });
    const modelChild = registry.reserve("root", "model-child");
    modelChild.commit();

    expect(() => registry.reserve("root", "second-model-child")).toThrow(AgentChildBudgetExceededError);

    const systemChild = registry.reserve("root", "system-child", { system: true });
    systemChild.commit();
    expect(registry.snapshotBudget()).toMatchObject({ totalChildren: 1, activeChildren: 2 });

    systemChild.release();
    modelChild.release();
    expect(registry.snapshotBudget()).toMatchObject({ totalChildren: 1, activeChildren: 0 });
  });
});
