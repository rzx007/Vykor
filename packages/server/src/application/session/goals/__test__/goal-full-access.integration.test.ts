import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import type { StreamingMessageClient, ToolExecutionResult } from "@vykor/agent-contracts";
import { SessionStore } from "@vykor/services";
import { DaemonApplication } from "../../../daemon-application.js";

it("executes two automatic Goal continuations with the conversation's full-access authorization", async () => {
  // Sandboxed Windows permits atomic file replacement within the writable workspace.
  const directory = mkdtempSync(join(process.cwd(), ".test-goal-full-access-"));
  for (let index = 1; index <= 3; index++) writeFileSync(join(directory, `turn-${index}.txt`), "before");
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  const approvals: string[] = [];
  const results: ToolExecutionResult[] = [];
  let turn = 0;
  const client: StreamingMessageClient = { async *streamMessage({ messages }) {
    const userIndex = messages.map(message => message.type).lastIndexOf("user");
    const currentResults = messages.slice(userIndex + 1).filter(message => message.type === "tool_result");
    if (currentResults.length === 0) {
      turn++;
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `goal-write-${turn}`, name: "Write",
        input: { file_path: join(directory, `turn-${turn}.txt`), content: `completed turn ${turn}` } } };
      yield { type: "complete", stopReason: "tool_use" };
    } else if (turn >= 3 && !currentResults.some(result => result.toolUseId === "goal-complete")) {
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "goal-complete", name: "GoalUpdate",
        input: { status: "completed", reason: "All three assigned files were written." } } };
      yield { type: "complete", stopReason: "tool_use" };
    } else {
      yield { type: "text_delta", delta: `Finished file ${turn}.` };
      yield { type: "complete", stopReason: "end_turn" };
    }
  } };
  const app = new DaemonApplication({ store,
    // Only this conversation has full access. A reload from the host default would ask.
    settings: { model: "offline", apiFormat: "openai", maxTurns: 5, permission: { mode: "ask" },
      sandbox: { enabled: false }, plugins: { enabled: false }, memory: { enabled: false, sessionMemoryEnabled: false } },
    createAgent: async ({ options }) => {
      const agent = await createDefaultNodeAgent({ ...options, client,
        capabilityOverrides: { ...options.capabilityOverrides, terminal: false, backgroundShell: false, memory: false },
        effects: { ...options.effects, requestPermission: async request => {
          approvals.push(request.toolName);
          return { status: "denied" };
        } },
        onEvent: async event => {
          if (event.type === "tool.completed") results.push(event.data.result);
          await options.onEvent?.(event);
        },
      });
      return { agent, host: agent.host };
    }, log: () => {},
  });
  try {
    await app.ready();
    const session = app.commands.createSession({ cwd: directory, model: "offline", metadata: {
      runtime: { model: "offline", approvalMode: "full_access", workMode: "execute" },
    } });
    const goal = await app.goals.create(session.id, { requestId: "full-access-goal", objective: "Write three assigned files.", maxAutoTurns: 2 });
    await vi.waitFor(() => expect(store.goals.getGoal(goal.id)?.status).toBe("completed"), { timeout: 10_000 });
    const runs = store.runs.listGoalRuns(goal.id).sort((left, right) => left.createdAt - right.createdAt);
    expect(runs).toHaveLength(3);
    expect(runs.map(run => ({ sessionId: run.sessionId, status: run.status, kind: run.metadata.goalRunKind }))).toEqual([
      { sessionId: session.id, status: "completed", kind: "initial" },
      { sessionId: session.id, status: "completed", kind: "continuation" },
      { sessionId: session.id, status: "completed", kind: "continuation" },
    ]);
    expect(store.conversations.listInputs(session.id)).toHaveLength(3);
    expect(approvals).toEqual([]);
    expect(store.permissions.list({ sessionId: session.id })).toEqual([]);
    expect(results.filter(result => result.toolName === "Write")).toHaveLength(3);
    expect(results.filter(result => result.isError)).toEqual([]);
    for (let index = 1; index <= 3; index++)
      expect(readFileSync(join(directory, `turn-${index}.txt`), "utf8")).toBe(`completed turn ${index}`);
  } finally {
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
