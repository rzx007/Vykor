import { isAgentExecutionLimitError, streamBufferedModelWithRetry, type AgentEvent } from "@vykor/core";
import { AgentEventBus } from "../../../../../agent-runtime/src/event-source.js";
import type { SessionEventRecord } from "@vykor/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "@vykor/services";
import { ChildAgentExecutionRegistry } from "@vykor/services/executions";
import { SessionExecutionProjector } from "../../session/session-execution-projector.js";
import { SessionTranscriptProjection } from "../../session/transcript-projection.js";

import {
  DaemonAgentEventProjector,
  type DaemonAgentEventProjectorContext,
} from "../daemon-agent-event-projector.js";

const compactionCleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of compactionCleanup.splice(0).reverse()) close();
});

function projectorStore(flat: Record<string, any>) {
  return {
    goals: { getGoal: flat.getGoal ?? vi.fn() },
    sessions: {
      get: flat.getSession ?? vi.fn(),
      update: flat.updateSession ?? vi.fn(),
      create: flat.createSession ?? vi.fn(),
      archive: flat.archiveSession ?? vi.fn(),
    },
    conversations: {
      getInput: flat.getInput ?? vi.fn(),
      createMessage: flat.createMessage ?? vi.fn(),
      upsertMessagePart: flat.upsertMessagePart ?? vi.fn(),
      appendEvent: flat.appendEvent ?? vi.fn(),
      listEvents: flat.listEvents ?? vi.fn(() => []),
    },
    conversationTransactions: {
      admitPrompt: flat.admitPrompt ?? vi.fn(),
      settleActiveRunAttempts: flat.settleActiveRunAttempts ?? vi.fn(),
      recordAppliedRequestConfiguration:
        flat.recordAppliedRequestConfiguration ??
        ((input: { sessionId: string; model: string }) => {
          const session = flat.getSession?.(input.sessionId);
          if (!session) return false;
          const previous =
            typeof session.metadata?.appliedRequestModel === "string"
              ? session.metadata.appliedRequestModel
              : undefined;
          if (previous === input.model) return false;
          (flat.updateSession ?? vi.fn())(session.id, {
            metadata: { ...session.metadata, appliedRequestModel: input.model },
          });
          return true;
        }),
    },
    runs: {
      getRun: flat.getRun ?? vi.fn(),
      createRun: flat.createRun ?? vi.fn(),
      updateRun: flat.updateRun ?? vi.fn(),
      createRunAttempt: flat.createRunAttempt ?? vi.fn(),
      updateRunAttempt: flat.updateRunAttempt ?? vi.fn(),
      listRunAttempts: flat.listRunAttempts ?? vi.fn(() => []),
      getSessionTask: flat.runsGetSessionTask ?? flat.getSessionTask ?? vi.fn(),
      updateSessionTask: flat.runsUpdateSessionTask ?? flat.updateSessionTask ?? vi.fn(),
    },
    createProjectionSettlement: flat.createProjectionSettlement ?? vi.fn(),
    failProjectionSettlement: flat.failProjectionSettlement ?? vi.fn(),
    getProjectionSettlement: flat.getProjectionSettlement ?? vi.fn(),
    getSessionTask: flat.getSessionTask ?? vi.fn(),
    listProjectionSettlements: flat.listProjectionSettlements ?? vi.fn(() => []),
    markProjectionSettlementRetrying: flat.markProjectionSettlementRetrying ?? vi.fn(),
    resolveProjectionSettlement: flat.resolveProjectionSettlement ?? vi.fn(),
    transaction: flat.transaction ?? (<T>(work: () => T) => work()),
    updateSessionTask: flat.updateSessionTask ?? vi.fn(),
  } satisfies DaemonAgentEventProjectorContext["store"];
}

describe("DaemonAgentEventProjector", () => {
  function goalProjector() {
    const directory = mkdtempSync(join(tmpdir(), "vk-child-goal-binding-"));
    const store = new SessionStore({ path: join(directory, "store.db") });
    compactionCleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    for (const id of ["parent", "child", "grandchild"]) store.sessions.create({ id, cwd: directory, model: "m", metadata: { runtime: { model: "m" } } });
    const goal = store.goals.createGoal({ sessionId: "parent", objective: "finish", maxAutoTurns: 2 });
    for (const id of ["P1", "P2"]) {
      store.runs.createRun({ id, sessionId: "parent", metadata: { goalId: goal.id, goalObjectiveVersion: 1 } });
      store.runs.updateRun(id, { status: "completed" });
    }
    const projector = new DaemonAgentEventProjector({
      store, rootAgent: { children: { get: () => undefined } } as any,
      transcriptProjection: new SessionTranscriptProjection(store), executionProjector: {} as any,
      liveChildren: { register: vi.fn(), unregister: vi.fn() },
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() }, log: vi.fn(),
    });
    const started = (runId: string, sessionId: string, parentRunId: string, parentSessionId = "parent") => {
      store.conversationTransactions.admitPrompt({ id: `input-${runId}`, sessionId, items: [{ type: "text", text: "work" }] });
      return event("run.started", {}, { sessionId, inputId: `input-${runId}`, runId, childId: `${sessionId}-handle`, parentRunId, parentSessionId });
    };
    return { store, goal, projector, started };
  }

  it("reports the actual goal stop reason instead of implying the token budget was exhausted", async () => {
    const { store, goal, projector, started } = goalProjector();
    await projector.apply(started("C-stopped", "child", "P1"));
    const reason = "目标自动续跑次数已用完";
    store.goals.updateGoal(goal.id, { expectedRevision: goal.revision, status: "paused", reason });
    await expect(projector.apply(event("model.attempt.started", {
      generationId: "denied", attempt: 1, model: "m", purpose: "generation",
    }, { runId: "C-stopped", sessionId: "child" }))).rejects.toThrow(reason);
  });

  it("passes Child budget rejection through the real EventBus without calling the model or compensating projection", async () => {
    const { store, goal, projector, started } = goalProjector();
    const bus = new AgentEventBus((value) => projector.apply(value));
    const initial = started("C-budget", "child", "P1");
    await bus.emit({ type: "run.started", data: {} }, initial.context);
    store.goals.updateGoal(goal.id, { expectedRevision: goal.revision, tokenBudget: 10 });
    const key = { runId: "C-budget", sessionId: "child", generationId: "spent", attempt: 1 };
    store.goals.beginGoalModelAttempt({ ...key, model: "m", purpose: "generation" });
    store.goals.recordGoalModelAttempt({ ...key, status: "completed", usageStatus: "complete", metering: {
      knownInputTokens: 8, knownOutputTokens: 3, completeness: "complete", inputIncludesCache: true, raw: { input: 8, output: 3 },
    } });
    const context = { runId: "C-budget", sessionId: "child", childId: "child-handle", parentRunId: "P1", parentSessionId: "parent" };
    const client = { streamMessage: vi.fn(async function* () { yield { type: "complete" as const, stopReason: "end_turn" }; }) };
    let error: unknown;
    try {
      for await (const _ of streamBufferedModelWithRetry(client, { model: "m", systemPrompt: "", messages: [], maxTokens: 10 }, {
        generationId: "next", onAttemptStarted: async (data) => { await bus.emit({ type: "model.attempt.started", data }, context); },
      })) { /* no result is possible after budget denial */ }
    } catch (caught) { error = caught; }
    expect(isAgentExecutionLimitError(error)).toBe(true);
    expect(client.streamMessage).not.toHaveBeenCalled();
    expect(store.listProjectionSettlements()).toHaveLength(0);
    await bus.emit({ type: "run.completed", data: { output: "already produced" } }, context);
    expect(store.runs.getRun("C-budget")?.status).toBe("completed");
  });

  it("accepts late complete usage before terminal and sequence text guards without reactivating a cancelled Goal", async () => {
    const { store, goal, projector, started } = goalProjector();
    await projector.apply(started("C-late", "child", "P1"));
    const context = { runId: "C-late", sessionId: "child", childId: "child-handle" };
    const begin = event("model.attempt.started", { generationId: "g", attempt: 1, model: "m", purpose: "generation" }, context);
    await projector.apply({ ...begin, sequence: 100 });
    store.runs.updateRun("C-late", { status: "completed" });
    const current = store.goals.getGoal(goal.id)!;
    store.goals.updateGoal(goal.id, { expectedRevision: current.revision, status: "cancelled" });
    const report = event("model.attempt.finished", { generationId: "g", attempt: 1, status: "completed", usageStatus: "complete", usage: {
      inputTokens: 10, outputTokens: 2, metering: { knownInputTokens: 10, knownOutputTokens: 2, completeness: "complete", inputIncludesCache: true, raw: { input: 10, output: 2 } },
    } }, context);
    await projector.apply({ ...report, sequence: 2 });
    const once = store.goals.getGoal(goal.id)!;
    expect(once).toMatchObject({ status: "cancelled", usage: { knownTokens: 12, incomplete: false, inFlightAttempts: 0 } });
    await projector.apply({ ...report, sequence: 2 });
    expect(store.goals.getGoal(goal.id)?.usage).toEqual(once.usage);
  });

  it("persists each reused Child Run's immediate parent and Goal binding, including pending and replay paths", async () => {
    const { store, goal, projector, started } = goalProjector();
    await projector.apply(started("C1", "child", "P1"));
    expect(store.runs.getRun("C1")?.metadata).toMatchObject({ parentRunId: "P1", goalId: goal.id, goalObjectiveVersion: 1 });
    const second = started("C2", "child", "P2");
    store.runs.createRun({ id: "C2", sessionId: "child", inputId: "input-C2" });
    await projector.apply(second);
    expect(store.runs.getRun("C2")?.metadata).toMatchObject({ parentRunId: "P2", goalId: goal.id, goalObjectiveVersion: 1 });
    await projector.apply({ ...second, sequence: second.sequence + 1 });
    await projector.apply({ ...started("C3", "grandchild", "C2", "child"), sequence: second.sequence + 2 });
    expect(store.runs.getRun("C3")?.metadata).toMatchObject({ parentRunId: "C2", goalId: goal.id, goalObjectiveVersion: 1 });
    await expect(projector.apply({ ...second, sequence: second.sequence + 100, context: { ...second.context, parentRunId: "P1" } }))
      .rejects.toThrow("parent run identity conflict");
    expect(store.runs.getRun("C2")?.metadata.parentRunId).toBe("P2");
  });

  it.each(["paused", "edited"])("rejects queued children before execution when the Goal was %s", async (change) => {
    const { store, goal, projector, started } = goalProjector();
    const pending = started("C1", "child", "P1");
    store.goals.updateGoal(goal.id, { expectedRevision: goal.revision,
      ...(change === "paused" ? { status: "paused" as const } : { objective: "new objective" }) });
    await expect(projector.apply(pending)).rejects.toThrow("Goal is stopped or objective version changed");
    expect(store.runs.getRun("C1")?.status).not.toBe("running");
  });

  it("releases child callbacks on close while keeping completed task results readable", async () => {
    const registry = new ChildAgentExecutionRegistry();
    const sessions = new Map<string, any>([["parent", {
      id: "parent", cwd: "/repo", model: "m", metadata: { runtime: { model: "m" } },
    }]]);
    const tasks = new Map<string, any>();
    const send = vi.fn(async () => {});
    const events = { checkpoint: () => 0, publish: () => {}, publishSince: () => {} };
    const executionProjector = new SessionExecutionProjector({
      store: {
        createSessionTask: input => { tasks.set(input.id, { ...input, status: "pending" }); },
        getSessionTask: id => tasks.get(id),
        updateSessionTask: (id, patch) => Object.assign(tasks.get(id), patch),
      },
      getChildAgentExecutionRegistry: () => registry,
      events, traceIdForRun: () => "trace", log: () => {},
    });
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: () => ({ send }) } } as any,
      store: projectorStore({
        getSession: (id: string) => sessions.get(id),
        createSession: (input: any) => { sessions.set(input.id, input); return input; },
        getSessionTask: (id: string) => tasks.get(id),
      }),
      transcriptProjection: {} as any, executionProjector,
      liveChildren: { register() {}, unregister() {} }, events, log() {},
    });
    await projector.apply(event("child.created", {
      childId: "child-1", sessionId: "child-session", cwd: "/repo",
      spawn: { description: "review", prompt: "inspect", agent: "review", cwd: "/repo" },
    }, { sessionId: "parent", childId: "child-1" }));
    await registry.completeExecution("child-1", { status: "completed", output: "first result" });
    await registry.writeInput("child-1", "follow up");
    expect(send).toHaveBeenCalledWith({ content: "follow up" });

    await projector.apply(event("child.closed", {
      childId: "child-1", sessionId: "child-session", result: { status: "completed", output: "done" },
    }, { sessionId: "parent", childId: "child-1" }));

    await expect(registry.writeInput("child-1", "late follow up")).rejects.toThrow("Child Agent callbacks not found");
    expect(send).toHaveBeenCalledTimes(1);
    expect(tasks.get("child-1")).toMatchObject({ status: "completed", output: "done" });
    await expect(registry.awaitExecution("child-1")).resolves.toMatchObject({ status: "completed" });
  });

  it("persists the applied parent model for a new child while the target has changed", async () => {
    const sessions = new Map<string, any>([["parent", {
      id: "parent", cwd: "/repo", model: "model-b",
      metadata: { runtime: { model: "model-b", effort: "high", sessionMode: "coordinator", baseUrl: "https://new.example/v1" }, appliedRequestModel: "model-a" },
    }]]);
    const projector = new DaemonAgentEventProjector({
      rootAgent: {} as any,
      store: projectorStore({
        getSession: (id: string) => sessions.get(id),
        createSession: (input: any) => { sessions.set(input.id, input); return input; },
      }),
      transcriptProjection: {} as any,
      executionProjector: { createBridge: () => ({ registerChildExecution: (input: any) => input, bindChildExecutionRun: async () => {} }) } as any,
      liveChildren: { register: () => {}, unregister: () => {} },
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });
    await projector.apply(event("child.created", {
      childId: "child", sessionId: "child-session", cwd: "/repo",
      spawn: { description: "work", prompt: "work", agent: "worker", cwd: "/repo" },
      parentRequestConfiguration: { model: "model-a", effort: "low", baseUrl: "" },
    }, { sessionId: "parent", runId: "root-run", childId: "child" }));
    expect(sessions.get("child-session")?.metadata.runtime).toMatchObject({
      model: "model-a", effort: "low", baseUrl: "", sessionMode: "direct",
    });
  });

  it("writes delegation scope and expected result into the parent task metadata", async () => {
    const sessions = new Map<string, any>([["parent", {
      id: "parent", cwd: "/repo", model: "model-b",
      metadata: { runtime: { model: "model-b" } },
    }]]);
    const updateSessionTask = vi.fn();
    const projector = new DaemonAgentEventProjector({
      rootAgent: {} as any,
      store: projectorStore({
        getSession: (id: string) => sessions.get(id),
        createSession: (input: any) => { sessions.set(input.id, input); return input; },
        updateSessionTask,
      }),
      transcriptProjection: {} as any,
      executionProjector: { createBridge: () => ({
        registerChildExecution: (input: any) => ({ id: input.id }),
        bindChildExecutionRun: async () => {},
        completeChildExecution: async () => {},
      }) } as any,
      liveChildren: { register: () => {}, unregister: () => {} },
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await projector.apply(event("child.created", {
      childId: "child-scoped", sessionId: "child-session-scoped", cwd: "/repo",
      spawn: {
        description: "review", prompt: "inspect", agent: "worker", cwd: "/repo",
        scope: "docs/report.md", expectedResult: "findings with evidence",
      },
    }, { sessionId: "parent", runId: "root-run", childId: "child-scoped" }));
    await projector.apply(event("child.created", {
      childId: "child-scope-only", sessionId: "child-session-scope-only", cwd: "/repo",
      spawn: {
        description: "review", prompt: "inspect", agent: "worker", cwd: "/repo",
        scope: "docs/report.md",
      },
    }, { sessionId: "parent", runId: "root-run", childId: "child-scope-only" }));

    expect(updateSessionTask).toHaveBeenCalledWith("child-scoped", {
      metadata: { scope: "docs/report.md", expectedResult: "findings with evidence" },
    });
    expect(updateSessionTask).toHaveBeenCalledWith("child-scope-only", {
      metadata: { scope: "docs/report.md" },
    });
  });

  it("does not write delegation metadata for child creation without scope or expected result", async () => {
    const sessions = new Map<string, any>([["parent", {
      id: "parent", cwd: "/repo", model: "model-b",
      metadata: { runtime: { model: "model-b" } },
    }]]);
    const updateSessionTask = vi.fn();
    const projector = new DaemonAgentEventProjector({
      rootAgent: {} as any,
      store: projectorStore({
        getSession: (id: string) => sessions.get(id),
        createSession: (input: any) => { sessions.set(input.id, input); return input; },
        updateSessionTask,
      }),
      transcriptProjection: {} as any,
      executionProjector: { createBridge: () => ({
        registerChildExecution: (input: any) => ({ id: input.id }),
        bindChildExecutionRun: async () => {},
        completeChildExecution: async () => {},
      }) } as any,
      liveChildren: { register: () => {}, unregister: () => {} },
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await projector.apply(event("child.created", {
      childId: "child-legacy", sessionId: "child-session-legacy", cwd: "/repo",
      spawn: { description: "review", prompt: "inspect", agent: "worker", cwd: "/repo" },
    }, { sessionId: "parent", runId: "root-run", childId: "child-legacy" }));

    expect(updateSessionTask).not.toHaveBeenCalled();
  });

  it("updates the applied model without writing a divider when a request starts", async () => {
    let session = {
      id: "s1", cwd: "/repo", model: "model-b",
      metadata: { runtime: { model: "model-b" }, appliedRequestModel: "model-a" },
    };
    const messages: Array<Record<string, unknown>> = [];
    const projector = new DaemonAgentEventProjector({
      rootAgent: {} as any,
      store: projectorStore({
        getSession: () => session,
        updateSession: (_id: string, patch: any) => {
          session = { ...session, ...patch };
          return session;
        },
        createMessage: (input: Record<string, unknown>) => {
          messages.push(input);
          return { id: `message-${messages.length}`, ...input };
        },
        upsertMessagePart: vi.fn(),
      }),
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await projector.apply(event("domain.event", {
      name: "request.configuration", payload: { revision: 0, model: "model-a" },
    }, { sessionId: "s1", runId: "r1" }));
    expect(messages).toEqual([]);
    await projector.apply(event("domain.event", {
      name: "request.configuration", payload: { revision: 1, model: "model-b" },
    }, { sessionId: "s1", runId: "r1" }));
    expect(messages).toEqual([]);
    expect(session.metadata.appliedRequestModel).toBe("model-b");
  });

  it("projects reasoning events and transacts when their source changes", async () => {
    const transaction = vi.fn((work: () => unknown) => work());
    const projectStreamEvent = vi.fn(() => ({}));
    const projector = new DaemonAgentEventProjector({
      rootAgent: {} as any,
      store: projectorStore({ transaction }),
      transcriptProjection: { projectStreamEvent } as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: vi.fn(() => 1), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });
    const state = {
      sessionId: "s1", runId: "r1", inputId: "i1", assistantTurnCompleted: false,
      activeReasoningPartId: "part-1", activeReasoningSource: "think", toolParts: new Map(),
    };
    (projector as any).transcripts.set("r1", state);

    await projector.apply(event("output.reasoning.delta", { delta: "replay", source: "reasoning_content" }, {
      sessionId: "s1", runId: "r1",
    }));
    expect(transaction).toHaveBeenCalledOnce();
    expect(projectStreamEvent).toHaveBeenCalledWith(state, {
      type: "reasoning_delta", delta: "replay", source: "reasoning_content",
    });
  });
  it("records a failed child startup run without ending the root run", async () => {
    const sessions = new Map<string, any>([["parent", { id: "parent", cwd: "/repo", model: "m", metadata: { runtime: { model: "m" } } }]]);
    const inputs = new Map<string, any>();
    const runs = new Map<string, any>([["root-run", { id: "root-run", sessionId: "parent", status: "running" }]]);
    let task: any;
    const projector = new DaemonAgentEventProjector({
      store: projectorStore({
        getSession: (id: string) => sessions.get(id),
        createSession: (input: any) => { sessions.set(input.id, input); return input; },
        getSessionTask: () => task,
        getInput: (id: string) => inputs.get(id),
        admitPrompt: (input: any) => { const row = { ...input, content: input.items.map((item: any) => item.text).join("") }; inputs.set(input.id, row); return row; },
        getRun: (id: string) => runs.get(id),
        createRun: (input: any) => { runs.set(input.id, input); return input; },
        updateRun: (id: string, patch: any) => Object.assign(runs.get(id), patch),
        appendEvent: () => {},
        transaction: (work: () => unknown) => work(),
      }),
      rootAgent: {} as any, transcriptProjection: {} as any,
      executionProjector: { createBridge: () => ({
        registerChildExecution: (input: any) => { task = { ...input, status: "pending" }; return task; },
        bindChildExecutionRun: async (_id: string, runId: string) => { task.runId = runId; },
        releaseChildExecution: () => {},
        completeChildExecution: async (_id: string, result: any) => Object.assign(task, result),
      }) } as any,
      liveChildren: { register: () => {}, unregister: () => {} },
      events: { checkpoint: () => 0, publish: () => {}, publishSince: () => {} }, log: () => {},
    });
    await projector.apply(event("child.created", {
      childId: "child", sessionId: "child-session", cwd: "/repo",
      spawn: { description: "review", prompt: "inspect", agent: "plugin:review", cwd: "/repo" },
    }, { sessionId: "parent", runId: "root-run", childId: "child" }));
    await projector.apply(event("child.closed", {
      childId: "child", sessionId: "child-session", result: { status: "failed", output: "creation failed", error: "creation failed" },
    }, { sessionId: "parent", runId: "root-run", childId: "child" }));
    expect([...runs.values()].filter((run) => run.sessionId === "child-session")).toEqual([
      expect.objectContaining({ status: "failed", error: "creation failed", metadata: expect.objectContaining({ parentRunId: "root-run" }) }),
    ]);
    expect([...inputs.values()]).toEqual([expect.objectContaining({ sessionId: "child-session", content: "inspect" })]);
    expect(runs.get("root-run").status).toBe("running");
    expect(task.status).toBe("failed");
  });

  it("advances the parent task activity cursor on each committed child turn", async () => {
    const sessions = new Map<string, any>([["parent", {
      id: "parent", cwd: "/repo", model: "m", metadata: { runtime: { model: "m" } },
    }]]);
    const inputs = new Map<string, any>();
    const tasks = new Map<string, any>();
    const runs = new Map<string, any>();
    const updateSessionTask = vi.fn((id: string, input: any) => {
      const row = tasks.get(id);
      Object.assign(row, {
        metadata: { ...row.metadata, ...(input.metadata ?? {}) },
        updatedAt: row.updatedAt + 1,
      });
      return row;
    });
    const projector = new DaemonAgentEventProjector({
      rootAgent: {} as any,
      store: projectorStore({
        getSession: (id: string) => sessions.get(id),
        createSession: (input: any) => { sessions.set(input.id, input); return input; },
        getSessionTask: (id: string) => tasks.get(id),
        getInput: (id: string) => inputs.get(id),
        admitPrompt: (input: any) => {
          const row = { ...input, content: input.items.map((item: any) => item.text).join("") };
          inputs.set(input.id, row);
          return row;
        },
        getRun: (id: string) => runs.get(id),
        createRun: (input: any) => {
          const row = { ...input, status: "pending", metadata: {} };
          runs.set(input.id, row);
          return row;
        },
        updateRun: (id: string, patch: any) => Object.assign(runs.get(id), patch),
        createRunAttempt: (input: any) => ({ id: input.id ?? "attempt-1", ...input }),
        updateRunAttempt: vi.fn(),
        listRunAttempts: () => [],
        updateSessionTask,
      }),
      transcriptProjection: {
        beginRun: vi.fn(() => ({})),
        projectStreamEvent: vi.fn(() => ({})),
        hasOpenTextPart: vi.fn(() => false),
        projectSteeredInputs: vi.fn(),
        completeOpenTextPart: vi.fn(),
        finalizeRunParts: vi.fn(),
      } as any,
      executionProjector: { createBridge: () => ({
        registerChildExecution: (input: any) => {
          tasks.set(input.id, { id: input.id, status: "pending", metadata: {}, updatedAt: 10 });
          return { id: input.id };
        },
        bindChildExecutionRun: async () => {},
        completeChildExecution: async () => {},
      }) } as any,
      liveChildren: { register: () => {}, unregister: () => {} },
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await projector.apply(event("child.created", {
      childId: "child-1", sessionId: "child-session", cwd: "/repo",
      spawn: { description: "review", prompt: "inspect", agent: "worker", cwd: "/repo" },
    }, { sessionId: "parent", runId: "root-run", childId: "child-1" }));
    await projector.apply(event("input.accepted", {
      content: "inspect", delivery: "queue",
    }, { sessionId: "child-session", inputId: "input-1", runId: "run-1", childId: "child-1" }));
    await projector.apply(event("run.started", {}, {
      sessionId: "child-session", inputId: "input-1", runId: "run-1", childId: "child-1",
    }));

    await projector.apply(event("output.text.delta", { delta: "SECRET PLANNING" }, {
      sessionId: "child-session", inputId: "input-1", runId: "run-1", childId: "child-1",
    }));
    expect(updateSessionTask).not.toHaveBeenCalled();

    const turn = event("output.turn.completed", { stopReason: "end_turn" }, {
      sessionId: "child-session", inputId: "input-1", runId: "run-1", childId: "child-1",
    });
    await projector.apply(turn);

    expect(updateSessionTask).toHaveBeenCalledTimes(1);
    expect(tasks.get("child-1").metadata.childActivity).toMatchObject({
      runId: "run-1", turns: 1, lastEventId: turn.id,
    });
    expect(JSON.stringify(tasks.get("child-1").metadata)).not.toContain("SECRET");

    await projector.apply(turn);
    expect(updateSessionTask).toHaveBeenCalledTimes(1);

    await projector.apply(event("output.turn.completed", { stopReason: "end_turn" }, {
      sessionId: "child-session", inputId: "input-1", runId: "run-1", childId: "child-1",
    }));
    expect(updateSessionTask).toHaveBeenCalledTimes(2);
    expect(tasks.get("child-1").metadata.childActivity.turns).toBe(2);

    // A follow-up Run becomes current, then a late event from run-1 must not
    // move the parent cursor or its counters.
    await projector.apply(event("input.accepted", { content: "again", delivery: "queue" }, {
      sessionId: "child-session", inputId: "input-2", runId: "run-2", childId: "child-1",
    }));
    await projector.apply(event("run.started", {}, {
      sessionId: "child-session", inputId: "input-2", runId: "run-2", childId: "child-1",
    }));
    await projector.apply(event("output.turn.completed", { stopReason: "end_turn" }, {
      sessionId: "child-session", inputId: "input-2", runId: "run-2", childId: "child-1",
    }));
    expect(updateSessionTask).toHaveBeenCalledTimes(3);
    expect(tasks.get("child-1").metadata.childActivity).toMatchObject({ runId: "run-2", turns: 3 });

    await projector.apply(event("output.turn.completed", { stopReason: "end_turn" }, {
      sessionId: "child-session", inputId: "input-1", runId: "run-1", childId: "child-1",
    }));
    expect(updateSessionTask).toHaveBeenCalledTimes(3);
    expect(tasks.get("child-1").metadata.childActivity).toMatchObject({ runId: "run-2", turns: 3 });
  });

  it("completes a child task with trusted failure detail on run.failed and ignores a later child.closed", async () => {
    const sessions = new Map<string, any>([["parent", {
      id: "parent", cwd: "/repo", model: "m", metadata: { runtime: { model: "m" } },
    }]]);
    const inputs = new Map<string, any>();
    const tasks = new Map<string, any>();
    const runs = new Map<string, any>();
    const completeChildExecution = vi.fn(async (id: string, result: any) => {
      Object.assign(tasks.get(id), {
        status: result.status,
        output: result.output,
        metadata: {
          ...tasks.get(id).metadata,
          ...(result.failureKind || result.partialResult
            ? {
                childFailure: {
                  ...(result.failureKind ? { failureKind: result.failureKind } : {}),
                  ...(result.partialResult ? { partialResult: result.partialResult } : {}),
                },
              }
            : {}),
        },
      });
    });
    const projector = new DaemonAgentEventProjector({
      rootAgent: {} as any,
      store: projectorStore({
        getSession: (id: string) => sessions.get(id),
        createSession: (input: any) => { sessions.set(input.id, input); return input; },
        getSessionTask: (id: string) => tasks.get(id),
        getInput: (id: string) => inputs.get(id),
        admitPrompt: (input: any) => {
          const row = { ...input, content: input.items.map((item: any) => item.text).join("") };
          inputs.set(input.id, row);
          return row;
        },
        getRun: (id: string) => runs.get(id),
        createRun: (input: any) => {
          const row = { ...input, status: "pending", metadata: {} };
          runs.set(input.id, row);
          return row;
        },
        updateRun: (id: string, patch: any) => Object.assign(runs.get(id), patch),
        createRunAttempt: (input: any) => ({ id: input.id ?? "attempt-1", ...input }),
        updateRunAttempt: vi.fn(),
        listRunAttempts: () => [],
      }),
      transcriptProjection: {
        beginRun: () => ({}),
        projectStreamEvent: () => ({}),
        hasOpenTextPart: () => false,
        projectSteeredInputs: vi.fn(),
        completeOpenTextPart: vi.fn(),
        completeOpenReasoningPart: vi.fn(),
        finalizeRunParts: vi.fn(),
      } as any,
      executionProjector: { createBridge: () => ({
        registerChildExecution: (input: any) => {
          tasks.set(input.id, { id: input.id, status: "pending", metadata: {}, updatedAt: 10 });
          return { id: input.id };
        },
        bindChildExecutionRun: async () => {},
        releaseChildExecution: () => {},
        completeChildExecution,
      }) } as any,
      liveChildren: { register: () => {}, unregister: () => {} },
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });
    const partialResult = {
      version: 1,
      childSessionId: "child-session",
      runId: "run-1",
      source: "limit_finalization",
      text: "final report",
      truncated: false,
    };

    await projector.apply(event("child.created", {
      childId: "child-1", sessionId: "child-session", cwd: "/repo",
      spawn: { description: "review", prompt: "inspect", agent: "worker", cwd: "/repo" },
    }, { sessionId: "parent", runId: "root-run", childId: "child-1" }));
    await projector.apply(event("input.accepted", {
      content: "inspect", delivery: "queue",
    }, { sessionId: "child-session", inputId: "input-1", runId: "run-1", childId: "child-1" }));
    await projector.apply(event("run.started", {}, {
      sessionId: "child-session", inputId: "input-1", runId: "run-1", childId: "child-1",
    }));

    await projector.apply(event("run.failed", {
      error: { name: "MaxTurnsExceeded", message: "Exceeded maximum agentic turns (2)" },
      output: "final report",
      failureKind: "max_turns",
      partialResult,
    }, { sessionId: "child-session", runId: "run-1", childId: "child-1" }));

    expect(completeChildExecution).toHaveBeenCalledWith("child-1", expect.objectContaining({
      status: "failed",
      failureKind: "max_turns",
      partialResult,
    }));

    await projector.apply(event("child.closed", {
      childId: "child-1", sessionId: "child-session",
      result: { status: "failed", output: "final report", failureKind: "max_turns", partialResult },
    }, { sessionId: "parent", runId: "root-run", childId: "child-1" }));

    expect(completeChildExecution).toHaveBeenCalledTimes(1);
  });

  it("keeps a historical goal.assessment event as ordinary history without updating Run metadata", async () => {
    const run = {
      id: "r1",
      sessionId: "s1",
      status: "running",
      metadata: { goalId: "g1", goalObjectiveVersion: 2 },
    };
    const updateRun = vi.fn();
    const appendEvent = vi.fn();
    const projector = new DaemonAgentEventProjector({
      store: projectorStore({
        getRun: () => run,
        updateRun,
        appendEvent,
        listEvents: () => [],
      }),
      rootAgent: {} as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });
    const historical = event("domain.event", { name: "goal.assessment", payload: { status: "completed" } }, { sessionId: "s1", runId: "r1" });
    await projector.apply(historical);
    expect(updateRun).not.toHaveBeenCalled();
    expect(run.metadata).toEqual({ goalId: "g1", goalObjectiveVersion: 2 });
    expect(appendEvent).toHaveBeenCalledWith({
      type: "agent.domain.event", sessionId: "s1",
      payload: { frameworkEventId: historical.id, name: "goal.assessment", payload: { status: "completed" } },
    });
  });

  it("accepts promoted structured input by its original items, and rejects changed identity", async () => {
    const items = [{ type: "skill", name: "review", path: "/review/SKILL.md" }];
    const input = {
      id: "input-1",
      sessionId: "s1",
      items,
      content: "$review",
      delivery: "queue",
      metadata: {},
      attachments: [],
    };
    const projector = new DaemonAgentEventProjector({
      store: projectorStore({
        transaction: (work: () => unknown) => work(),
        getInput: () => input,
        getRun: () => ({
          id: "queued",
          sessionId: "s1",
          inputId: "input-1",
          status: "pending",
        }),
      }),
      events: {
        checkpoint: () => 0,
        publishSince: () => {},
        publish: () => {},
      },
      rootAgent: {} as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      log: () => {},
    });
    const accepted = event(
      "input.accepted",
      {
        content: "Load review then handle the task",
        inputItems: items,
        delivery: "steer",
        metadata: {
          promotion: {
            kind: "queued_prompt",
            queuedRunId: "queued",
            expectedActiveRunId: "active",
          },
        },
      } as any,
      { sessionId: "s1", inputId: "input-1", runId: "active" },
    );
    await expect(projector.apply(accepted)).resolves.toBeUndefined();
    await expect(
      projector.apply({
        ...accepted,
        sequence: accepted.sequence + 1,
        data: {
          ...accepted.data,
          inputItems: [{ type: "skill", name: "review", path: "/other/SKILL.md" }],
        },
      } as any),
    ).rejects.toThrow("identity conflict");
  });

  it("persists original items from a live child instead of its model instruction", async () => {
    const items = [{ type: "skill", name: "review", path: "/review/SKILL.md" }];
    let persisted: unknown;
    const projector = new DaemonAgentEventProjector({
      store: projectorStore({
        transaction: (work: () => unknown) => work(),
        getInput: () => undefined,
        admitPrompt: (input: unknown) => {
          persisted = input;
          return input;
        },
      }),
      events: {
        checkpoint: () => 0,
        publishSince: () => {},
        publish: () => {},
      },
      rootAgent: {} as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      log: () => {},
    });
    await projector.apply(
      event(
        "input.accepted",
        {
          content: "Load review then handle the task",
          inputItems: items,
          delivery: "queue",
        } as any,
        { sessionId: "s1", inputId: "input-child" },
      ),
    );
    expect(persisted).toMatchObject({ items });
  });
  it("projects child and run facts without returning execution handles", async () => {
    const sessions = new Map<string, any>([
      [
        "parent",
        {
          id: "parent",
          cwd: "/repo",
          model: "gpt",
          metadata: { runtime: { model: "gpt" } },
        },
      ],
    ]);
    const inputs = new Map<string, any>();
    const runs = new Map<string, any>();
    const attempts = new Map<string, any>();
    const tasks = new Map<string, any>();
    const store = {
      transaction: <T>(work: () => T) => work(),
      getSession: vi.fn((id) => sessions.get(id)),
      createSession: vi.fn((input) => {
        const row = { ...input, status: "idle" };
        sessions.set(row.id, row);
        return row;
      }),
      getSessionTask: vi.fn((id) => tasks.get(id)),
      getInput: vi.fn((id) => inputs.get(id)),
      admitPrompt: vi.fn((input) => {
        const row = { ...input };
        inputs.set(row.id, row);
        return row;
      }),
      getRun: vi.fn((id) => runs.get(id)),
      createRun: vi.fn((input) => {
        const row = { ...input, status: "pending" };
        runs.set(row.id, row);
        return row;
      }),
      updateRun: vi.fn((id, update) => {
        const row = Object.assign(runs.get(id) ?? { id }, update);
        runs.set(id, row);
        return row;
      }),
      listRunAttempts: vi.fn((runId) =>
        [...attempts.values()].filter((attempt) => attempt.runId === runId),
      ),
      createRunAttempt: vi.fn((input) => {
        const row = { ...input, status: "pending" };
        attempts.set(row.id, row);
        return row;
      }),
      updateRunAttempt: vi.fn((id, update) => {
        const row = Object.assign(attempts.get(id), update);
        attempts.set(id, row);
        return row;
      }),
      settleActiveRunAttempts: vi.fn((runId, status, error) => {
        for (const attempt of attempts.values()) {
          if (
            attempt.runId === runId &&
            (attempt.status === "pending" || attempt.status === "running")
          ) {
            Object.assign(attempt, { status }, error ? { error } : {});
          }
        }
      }),
      appendEvent: vi.fn(),
    };
    const bridge = {
      registerChildExecution: vi.fn((input) => {
        tasks.set(input.id, { id: input.id, status: "pending" });
        return { id: input.id };
      }),
      bindChildExecutionRun: vi.fn(async (id, runId) => {
        Object.assign(tasks.get(id), { status: "running", runId });
      }),
      completeChildExecution: vi.fn(async (id, result) => {
        Object.assign(tasks.get(id), {
          status: result.status,
          output: result.output,
        });
      }),
    };
    const liveDelta = {
      id: "delta-1",
      seq: 9,
      type: "session.message.part.delta",
      sessionId: "child-session",
      payload: { delta: "done" },
      createdAt: 1,
    };
    const transcript = {
      beginRun: vi.fn(() => ({ active: true })),
      projectSteeredInputs: vi.fn(),
      hasOpenTextPart: vi.fn(() => false),
      projectStreamEvent: vi.fn(() => ({ liveEvent: liveDelta })),
      completeOpenTextPart: vi.fn(),
      finalizeRunParts: vi.fn(),
    };
    const liveChildren = { register: vi.fn(), unregister: vi.fn() };
    const rootAgent = { children: { get: vi.fn() } } as any;
    const events = {
      checkpoint: vi.fn(() => 1),
      publish: vi.fn(),
      publishSince: vi.fn(),
    };
    const projector = new DaemonAgentEventProjector({
      rootAgent,
      store: projectorStore(store),
      transcriptProjection: transcript as any,
      executionProjector: { createBridge: vi.fn(() => bridge) } as any,
      liveChildren,
      events,
      log: vi.fn(),
    });

    await projector.apply(
      event(
        "child.created",
        {
          childId: "child-1",
          sessionId: "child-session",
          spawn: {
            description: "Explore",
            prompt: "inspect",
            agent: "Explore",
            cwd: "/repo",
          },
          cwd: "/repo",
        },
        { sessionId: "parent", childId: "child-1" },
      ),
    );
    await projector.apply(
      event(
        "input.accepted",
        {
          content: "inspect",
          delivery: "queue",
          metadata: { requestedBy: "test" },
        },
        {
          sessionId: "child-session",
          inputId: "input-1",
          runId: "run-1",
          childId: "child-1",
        },
      ),
    );
    bridge.bindChildExecutionRun.mockRejectedValueOnce(new Error("bind failed"));
    const started = event(
      "run.started",
      {},
      {
        sessionId: "child-session",
        inputId: "input-1",
        runId: "run-1",
        childId: "child-1",
      },
    );
    await expect(projector.apply(started)).rejects.toThrow("bind failed");
    expect(transcript.finalizeRunParts).toHaveBeenCalledWith("child-session", "run-1", "failed");
    expect(store.updateRun).toHaveBeenCalledWith("run-1", {
      status: "failed",
      error: "bind failed",
    });
    expect(bridge.completeChildExecution).toHaveBeenCalledWith("child-1", {
      status: "failed",
      output: "bind failed",
    });
    await projector.apply(
      event(
        "input.accepted",
        {
          content: "continue",
          delivery: "queue",
        },
        {
          sessionId: "child-session",
          inputId: "input-2",
          runId: "run-2",
          childId: "child-1",
        },
      ),
    );
    await projector.apply(
      event(
        "run.started",
        {},
        {
          sessionId: "child-session",
          inputId: "input-2",
          runId: "run-2",
          childId: "child-1",
        },
      ),
    );
    await projector.apply(
      event(
        "output.text.delta",
        { delta: "done" },
        {
          sessionId: "child-session",
          inputId: "input-2",
          runId: "run-2",
          childId: "child-1",
        },
      ),
    );
    await projector.apply(
      event(
        "run.completed",
        { output: "done" },
        {
          sessionId: "child-session",
          inputId: "input-2",
          runId: "run-2",
          childId: "child-1",
        },
      ),
    );

    expect(store.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "child-session", parentId: "parent" }),
    );
    expect(store.admitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "input-1",
        metadata: expect.objectContaining({ requestedBy: "test" }),
      }),
    );
    expect(bridge.registerChildExecution).toHaveBeenCalledWith(
      expect.objectContaining({ id: "child-1" }),
    );
    expect(liveChildren.register).toHaveBeenCalledWith("child-session", "child-1", rootAgent);
    expect(transcript.projectStreamEvent).toHaveBeenCalledWith(expect.anything(), {
      type: "text_delta",
      delta: "done",
    });
    expect(events.publish).toHaveBeenCalledWith(liveDelta);
    expect(bridge.bindChildExecutionRun).toHaveBeenCalledTimes(2);
    expect(store.updateRun).toHaveBeenLastCalledWith("run-2", {
      status: "completed",
      metadata: { toolGeneration: [] },
    });
    expect([...attempts.values()]).toMatchObject([
      { id: "attempt_run-1_1", runId: "run-1", sequence: 1, status: "failed" },
      {
        id: "attempt_run-2_1",
        runId: "run-2",
        sequence: 1,
        status: "completed",
      },
    ]);
    expect(bridge.completeChildExecution).toHaveBeenCalledWith("child-1", {
      status: "completed",
      output: "done",
    });
  });

  it("compensates durable child state when live route registration fails", async () => {
    const sessions = new Map<string, any>([
      [
        "parent",
        {
          id: "parent",
          cwd: "/repo",
          model: "gpt",
          metadata: { runtime: { model: "gpt" } },
        },
      ],
    ]);
    const tasks = new Map<string, any>();
    const archiveSession = vi.fn((id) => {
      const session = sessions.get(id);
      Object.assign(session, { status: "archived" });
      return session;
    });
    const store = {
      getSession: vi.fn((id) => sessions.get(id)),
      createSession: vi.fn((input) => {
        const row = { ...input, status: "idle" };
        sessions.set(row.id, row);
        return row;
      }),
      archiveSession,
      getSessionTask: vi.fn((id) => tasks.get(id)),
      appendEvent: vi.fn(),
    };
    const completeChildExecution = vi.fn(async (id, result) => {
      Object.assign(tasks.get(id), {
        status: result.status,
        output: result.output,
      });
    });
    const bridge = {
      registerChildExecution: vi.fn((input) => {
        const task = { id: input.id, status: "pending" };
        tasks.set(task.id, task);
        return task;
      }),
      releaseChildExecution: vi.fn(),
      completeChildExecution,
    };
    const liveChildren = {
      register: vi.fn(() => {
        throw new Error("route conflict");
      }),
      unregister: vi.fn(),
    };
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: projectorStore(store),
      transcriptProjection: {} as any,
      executionProjector: { createBridge: vi.fn(() => bridge) } as any,
      liveChildren,
      events: {
        checkpoint: vi.fn(() => 1),
        publish: vi.fn(),
        publishSince: vi.fn(),
      },
      log: vi.fn(),
    });

    await expect(
      projector.apply(
        event(
          "child.created",
          {
            childId: "child-bad",
            sessionId: "child-session-bad",
            spawn: {
              description: "Explore",
              prompt: "inspect",
              agent: "Explore",
              cwd: "/repo",
            },
            cwd: "/repo",
          },
          { sessionId: "parent", childId: "child-bad" },
        ),
      ),
    ).rejects.toThrow("route conflict");

    expect(completeChildExecution).toHaveBeenCalledWith("child-bad", {
      status: "failed",
      output: "route conflict",
    });
    expect(bridge.releaseChildExecution).toHaveBeenCalledWith("child-bad");
    expect(archiveSession).toHaveBeenCalledWith("child-session-bad");
    expect(sessions.get("child-session-bad")?.status).toBe("archived");
  });

  it("rejects replayed input ids whose durable metadata differs", async () => {
    const store = {
      transaction: <T>(work: () => T) => work(),
      getInput: vi.fn(() => ({
        id: "input-1",
        sessionId: "s1",
        content: "hello",
        delivery: "queue",
        metadata: { source: "first", traceId: "old-trace" },
      })),
    };
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: projectorStore(store),
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: vi.fn(), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await expect(
      projector.apply(
        event(
          "input.accepted",
          {
            content: "hello",
            delivery: "queue",
            metadata: { source: "second" },
          },
          { sessionId: "s1", inputId: "input-1", runId: "run-1" },
        ),
      ),
    ).rejects.toThrow("Agent input identity conflict");
  });

  it("accepts model-facing content transformed from an admitted attachment input", async () => {
    const input = {
      id: "input-1",
      sessionId: "s1",
      content: "内容",
      delivery: "queue",
      metadata: { origin: { client: "desktop" } },
      attachments: [{ assetId: "image-1" }],
    };
    const store = {
      transaction: <T>(work: () => T) => work(),
      getInput: vi.fn(() => input),
      getRun: vi.fn(() => ({
        id: "run-1",
        sessionId: "s1",
        inputId: input.id,
        metadata: { attachmentRouting: { status: "completed" } },
      })),
    };
    const events = {
      checkpoint: vi.fn(),
      publish: vi.fn(),
      publishSince: vi.fn(),
    };
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: projectorStore(store),
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events,
      log: vi.fn(),
    });

    await expect(
      projector.apply(
        event(
          "input.accepted",
          {
            content: [
              { type: "text", text: "内容" },
              { type: "image", image: "data:image/png;base64,aW1hZ2U=" },
            ],
            delivery: "queue",
            metadata: input.metadata,
          },
          { sessionId: "s1", inputId: input.id, runId: "run-1" },
        ),
      ),
    ).resolves.toBeUndefined();

    expect(events.publishSince).toHaveBeenCalled();
  });

  it("accepts model-facing content transformed from an admitted structured skill input", async () => {
    const input = {
      id: "input-1",
      sessionId: "s1",
      content: "这是什么技能",
      delivery: "queue",
      metadata: {},
      items: [
        {
          type: "skill",
          name: "agent-reach",
          path: "/repo/agent-reach/SKILL.md",
        },
      ],
      attachments: [],
    };
    const store = {
      transaction: <T>(work: () => T) => work(),
      getInput: vi.fn(() => input),
    };
    const events = {
      checkpoint: vi.fn(),
      publish: vi.fn(),
      publishSince: vi.fn(),
    };
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: projectorStore(store),
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events,
      log: vi.fn(),
    });

    await expect(
      projector.apply(
        event(
          "input.accepted",
          {
            content:
              "用户显式选择了以下技能，请按出现顺序使用 Skill 工具的 { name, path } 加载并遵循：\n1. agent-reach (path: /repo/agent-reach/SKILL.md)\n\n用户输入：\n$agent-reach",
            inputItems: input.items,
            delivery: "queue",
            metadata: input.metadata,
          },
          { sessionId: "s1", inputId: input.id, runId: "run-1" },
        ),
      ),
    ).resolves.toBeUndefined();

    expect(events.publishSince).toHaveBeenCalled();
  });

  it("rejects reuse of a durable child session by a different child identity", async () => {
    const store = {
      getSession: vi.fn((id) =>
        id === "parent"
          ? {
              id: "parent",
              cwd: "/repo",
              model: "gpt",
              metadata: { runtime: { model: "gpt" } },
            }
          : {
              id: "child-session",
              parentId: "parent",
              cwd: "/repo",
              metadata: { childId: "old-child" },
            },
      ),
    };
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: projectorStore(store),
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: vi.fn(), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await expect(
      projector.apply(
        event(
          "child.created",
          {
            childId: "new-child",
            sessionId: "child-session",
            spawn: {
              description: "Explore",
              prompt: "inspect",
              agent: "Explore",
              cwd: "/repo",
            },
            cwd: "/repo",
          },
          { sessionId: "parent", childId: "new-child" },
        ),
      ),
    ).rejects.toThrow("Child session identity conflict");
  });

  it("rejects child creation after the parent session starts closing", async () => {
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: projectorStore({
        getSession: vi.fn(() => ({
          id: "parent",
          cwd: "/repo",
          model: "gpt",
          status: "closing",
          metadata: { runtime: { model: "gpt" } },
        })),
      }),
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: vi.fn(), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await expect(
      projector.apply(
        event(
          "child.created",
          {
            childId: "late-child",
            sessionId: "late-child-session",
            spawn: {
              description: "Explore",
              prompt: "inspect",
              agent: "Explore",
              cwd: "/repo",
            },
            cwd: "/repo",
          },
          { sessionId: "parent", childId: "late-child" },
        ),
      ),
    ).rejects.toThrow("Parent session is not accepting child agents");
  });

  it("retains and retries child close projection state after durable completion fails", async () => {
    const completeChildExecution = vi
      .fn()
      .mockRejectedValueOnce(new Error("store unavailable"))
      .mockRejectedValueOnce(new Error("store still unavailable"))
      .mockResolvedValueOnce(undefined);
    const liveChildren = { unregister: vi.fn() };
    let settlement: any;
    const store = {
      getSessionTask: vi.fn(() => ({ id: "child-1", status: "running" })),
      appendEvent: vi.fn(),
      createProjectionSettlement: vi.fn((input) => {
        settlement ??= {
          ...input,
          id: "settlement-1",
          status: "pending",
          attemptCount: 0,
          createdAt: 1,
          updatedAt: 1,
        };
        return settlement;
      }),
      listProjectionSettlements: vi.fn(() =>
        settlement && (settlement.status === "pending" || settlement.status === "retrying")
          ? [settlement]
          : [],
      ),
      markProjectionSettlementRetrying: vi.fn(() => {
        Object.assign(settlement, {
          status: "retrying",
          attemptCount: settlement.attemptCount + 1,
        });
        return settlement;
      }),
      failProjectionSettlement: vi.fn((_id, error) => {
        Object.assign(settlement, { status: "pending", lastError: error });
        return settlement;
      }),
      resolveProjectionSettlement: vi.fn(() => {
        Object.assign(settlement, { status: "resolved" });
        return settlement;
      }),
    };
    const projector = new DaemonAgentEventProjector({
      projectorId: "daemon-agent:agent-1",
      rootSessionId: "parent",
      rootAgent: { children: { get: vi.fn() } } as any,
      store: projectorStore(store),
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: liveChildren as any,
      events: { checkpoint: vi.fn(), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });
    (projector as any).children.set("child-1", {
      childId: "child-1",
      sessionId: "child-session",
      parentSessionId: "parent",
      taskId: "child-1",
      bridge: { completeChildExecution, releaseChildExecution: vi.fn() },
    });

    const closed = event(
      "child.closed",
      {
        childId: "child-1",
        sessionId: "child-session",
        result: { status: "completed", output: "done" },
      },
      { sessionId: "parent", childId: "child-1" },
    );
    await expect(projector.apply(closed)).rejects.toThrow("store unavailable");

    expect(liveChildren.unregister).toHaveBeenCalledWith("child-session", "child-1");
    expect((projector as any).children.size).toBe(1);

    await projector.apply(closed);

    expect(completeChildExecution).toHaveBeenCalledTimes(3);
    expect(store.appendEvent).toHaveBeenCalledOnce();
    expect((projector as any).children.size).toBe(0);
    expect(store.createProjectionSettlement).toHaveBeenCalledOnce();
    expect(settlement).toMatchObject({ status: "resolved", attemptCount: 2 });
  });

  it("does not hide the original projection error when settlement persistence also fails", async () => {
    const projector = new DaemonAgentEventProjector({
      projectorId: "daemon-agent:agent-1",
      rootSessionId: "parent",
      rootAgent: { children: { get: vi.fn() } } as any,
      store: projectorStore({
        listProjectionSettlements: vi.fn(() => []),
        getSession: vi.fn(() => undefined),
        createProjectionSettlement: vi.fn(() => {
          throw new Error("sqlite unavailable");
        }),
      }),
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: vi.fn(), publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    const failure = await projector
      .apply(
        event(
          "child.created",
          {
            childId: "child-1",
            sessionId: "child-session",
            spawn: {
              description: "Explore",
              prompt: "inspect",
              agent: "Explore",
              cwd: "/repo",
            },
            cwd: "/repo",
          },
          { sessionId: "parent", childId: "child-1" },
        ),
      )
      .catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toContain("settlement could not be persisted");
    expect((failure as AggregateError).errors.map((error) => error.message)).toEqual([
      expect.stringContaining("Parent session not found"),
      "sqlite unavailable",
    ]);
  });

  it("does not reopen a terminal durable run", async () => {
    const updateRun = vi.fn();
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: projectorStore({
        transaction: <T>(work: () => T) => work(),
        getInput: vi.fn(() => ({
          id: "input-1",
          sessionId: "s1",
          content: "hello",
        })),
        getRun: vi.fn(() => ({
          id: "run-1",
          sessionId: "s1",
          inputId: "input-1",
          status: "failed",
        })),
        updateRun,
      }),
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: {
        checkpoint: vi.fn(() => 1),
        publish: vi.fn(),
        publishSince: vi.fn(),
      },
      log: vi.fn(),
    });

    await expect(
      projector.apply(
        event(
          "run.started",
          {},
          {
            sessionId: "s1",
            inputId: "input-1",
            runId: "run-1",
          },
        ),
      ),
    ).rejects.toThrow("Agent run is already terminal");
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("stores domain events under one registered type and keeps the domain name in the payload", async () => {
    const durableEvents: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    const appendEvent = vi.fn((input) => {
      durableEvents.push(input);
    });
    const projector = new DaemonAgentEventProjector({
      rootAgent: { children: { get: vi.fn() } } as any,
      store: projectorStore({ appendEvent, listEvents: vi.fn(() => durableEvents) }),
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: {
        checkpoint: vi.fn(() => 1),
        publish: vi.fn(),
        publishSince: vi.fn(),
      },
      log: vi.fn(),
    });

    const domainEvent = event(
      "domain.event",
      {
        name: "provider.rate_limited",
        payload: { retryAfterMs: 1_000 },
      },
      { sessionId: "s1" },
    );
    await projector.apply(domainEvent);

    expect(appendEvent).toHaveBeenCalledWith({
      type: "agent.domain.event",
      sessionId: "s1",
      payload: {
        frameworkEventId: domainEvent.id,
        name: "provider.rate_limited",
        payload: { retryAfterMs: 1_000 },
      },
    });

    // Simulate durable projection succeeding just before settlement resolution failed.
    (projector as any).lastAppliedSequence = 0;
    await projector.apply(domainEvent);
    expect(appendEvent).toHaveBeenCalledOnce();
  });

  it.each([
    ["compact_start", "started", "正在压缩上下文"],
    ["compact_end", "completed", "已压缩上下文"],
    ["compact_failed", "failed", "上下文压缩失败"],
  ])("commits the %s notice and domain event together before publishing", async (phase, presentationPhase, text) => {
    const h = compactionHarness();
    const compaction = event("domain.event", {
      name: "context_compaction", payload: { phase },
    }, { sessionId: h.sessionId });

    await h.projector.apply(compaction);

    const committed = h.readCommitted();
    expect(h.commitCount()).toBe(1);
    expect(committed.messages).toHaveLength(1);
    expect(committed.messages[0]).toMatchObject({
      role: "system", metadata: { presentation: { kind: "context_compaction", phase: presentationPhase } },
    });
    expect(committed.parts).toHaveLength(1);
    expect(committed.parts[0]).toMatchObject({
      messageId: committed.messages[0].id, type: "text", status: "completed", text,
    });
    expect(committed.events.map(record => record.type)).toEqual([
      "session.message.created", "session.message.part.updated", "agent.domain.event",
    ]);
    expect(committed.events[2].payload).toEqual({
      frameworkEventId: compaction.id, name: "context_compaction", payload: { phase },
    });
    expect(h.published).toEqual(committed.events);
  });

  it("rolls back a compaction notice when commit fails and retries without publishing partial records", async () => {
    const h = compactionHarness();
    const compaction = event("domain.event", {
      name: "context_compaction", payload: { phase: "compact_end" },
    }, { sessionId: h.sessionId });
    h.rejectNextCommit();

    await expect(h.projector.apply(compaction)).rejects.toThrow("commit failed");

    expect(h.readCommitted()).toEqual({ messages: [], parts: [], events: [] });
    expect(h.store.conversations.listMessages(h.sessionId)).toEqual([]);
    expect(h.store.conversations.listMessageParts(h.sessionId)).toEqual([]);
    expect(h.published).toEqual([]);

    await h.projector.apply(compaction);

    const committed = h.readCommitted();
    expect(h.commitCount()).toBe(2);
    expect(committed.messages).toHaveLength(1);
    expect(committed.parts).toHaveLength(1);
    expect(committed.events).toHaveLength(3);
    expect(h.published).toEqual(committed.events);
  });

  it("does not duplicate a compaction notice when its durable domain event is replayed", async () => {
    const h = compactionHarness();
    const compaction = event("domain.event", {
      name: "context_compaction", payload: { phase: "compact_start" },
    }, { sessionId: h.sessionId });
    await h.projector.apply(compaction);
    const committed = h.readCommitted();

    // Simulate durable projection succeeding just before settlement resolution failed.
    (h.projector as any).lastAppliedSequence = 0;
    await h.projector.apply(compaction);

    expect(h.readCommitted()).toEqual(committed);
    expect(h.commitCount()).toBe(1);
    expect(h.published).toEqual(committed.events);
  });

  it("persists a retry wait on run metadata and keeps the run running", async () => {
    const run = { id: "r1", sessionId: "s1", status: "running", metadata: {} };
    const updateRun = vi.fn((_id: string, patch: any) => {
      run.metadata = { ...run.metadata, ...(patch.metadata ?? {}) };
      return run;
    });
    const projector = new DaemonAgentEventProjector({
      rootAgent: {} as any,
      store: projectorStore({ getRun: () => run, updateRun }),
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    await projector.apply(event("model.retry.scheduled", {
      generationId: "g1",
      attempt: 1,
      retryNumber: 1,
      maxRetries: 5,
      reason: "network",
      nextRetryAt: 2_000,
      recoveryDeadlineAt: 180_000,
    }, { sessionId: "s1", runId: "r1" }));

    expect(run.status).toBe("running");
    expect(run.metadata.modelRetry).toMatchObject({
      generationId: "g1", attempt: 1, retryNumber: 1, reason: "network",
    });
  });

  it("settles each model attempt once and tracks usage completeness", async () => {
    const run = { id: "r1", sessionId: "s1", status: "running", metadata: {} };
    const events: any[] = [];
    const updateRun = vi.fn((_id: string, patch: any) => {
      run.metadata = { ...run.metadata, ...(patch.metadata ?? {}) };
      return run;
    });
    const projector = new DaemonAgentEventProjector({
      rootAgent: {} as any,
      store: projectorStore({
        getGoal: () => ({ id: "g1", sessionId: "s1", status: "active", objectiveVersion: 2, currentRunId: "r1" }),
        getRun: () => run,
        updateRun,
        appendEvent: (input: any) => {
          const record = { ...input, seq: events.length + 1 };
          events.push(record);
          return record;
        },
        listEvents: () => events,
      }),
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });

    const finished = (usageStatus: string, attempt: number) => event("model.attempt.finished", {
      generationId: "g1", attempt, status: "completed", usageStatus,
    }, { sessionId: "s1", runId: "r1" });

    await projector.apply(finished("unknown", 1));
    await projector.apply(finished("complete", 2));
    // Replaying the first settlement must not double count.
    await projector.apply(finished("unknown", 1));

    expect(events.filter((e) => e.type === "session.model.attempt.finished")).toHaveLength(2);
    expect(run.metadata.modelUsage).toEqual({
      incomplete: true,
      unknownAttempts: 1,
      partialAttempts: 0,
    });
  });

  it("accumulates known usage once across partial and complete attempts", async () => {
    const run: any = { id: "r1", sessionId: "s1", status: "running", metadata: { purpose: "keep" } };
    const attempt: any = { id: "ra1", status: "running", inputTokens: 0, outputTokens: 0 };
    const records: any[] = [];
    const store = projectorStore({
      getRun: () => run,
      updateRun: (_id: string, patch: any) => { run.metadata = { ...run.metadata, ...patch.metadata }; return run; },
      listRunAttempts: () => [attempt],
      updateRunAttempt: (_id: string, patch: any) => Object.assign(attempt, patch),
      appendEvent: (record: any) => { records.push(record); return record; },
      listEvents: () => records,
    });
    const projector = new DaemonAgentEventProjector({
      rootAgent: {} as any, store, transcriptProjection: {} as any,
      executionProjector: {} as any, liveChildren: {} as any,
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() }, log: vi.fn(),
    });
    const finish = (attemptNumber: number, usageStatus: string, inputTokens: number, outputTokens: number) =>
      event("model.attempt.finished", {
        generationId: "g1", attempt: attemptNumber, status: usageStatus === "partial" ? "failed" : "completed",
        usageStatus, usage: { inputTokens, outputTokens },
      }, { sessionId: "s1", runId: "r1" });
    await projector.apply(finish(1, "partial", 4, 1));
    await projector.apply(finish(2, "complete", 8, 3));
    await projector.apply(finish(1, "partial", 4, 1));
    expect(run.metadata).toMatchObject({
      purpose: "keep", usage: { inputTokens: 12, outputTokens: 4 },
      modelUsage: { incomplete: true, partialAttempts: 1, unknownAttempts: 0 },
    });
    expect(attempt).toMatchObject({ inputTokens: 12, outputTokens: 4 });
  });

  it("begins a new generation and clears stale retry metadata", async () => {
    const run = { id: "r1", sessionId: "s1", status: "running", metadata: { modelRetry: { generationId: "g1" } } };
    const beginGeneration = vi.fn();
    const updateRun = vi.fn((_id: string, patch: any) => {
      run.metadata = { ...run.metadata, ...(patch.metadata ?? {}) };
      return run;
    });
    const projector = new DaemonAgentEventProjector({
      rootAgent: {} as any,
      store: projectorStore({ getRun: () => run, updateRun }),
      transcriptProjection: { beginGeneration } as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });
    const state = {
      sessionId: "s1", runId: "r1", inputId: "i1", assistantTurnCompleted: false,
      toolParts: new Map(), generationParts: new Map(),
    };
    (projector as any).transcripts.set("r1", state);

    await projector.apply(event("output.generation.started", {
      generationId: "g2", attempt: 1,
    }, { sessionId: "s1", runId: "r1" }));

    expect(beginGeneration).toHaveBeenCalledWith(state, "g2", 1);
    expect(run.metadata.modelRetry).toBeNull();
  });
});

function compactionHarness() {
  const directory = mkdtempSync(join(tmpdir(), "vykor-compaction-"));
  compactionCleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "session.db");
  let sessionId: string | undefined;
  let commitCount = 0;
  let rejectNextCommit = false;
  const store = new SessionStore({ path, transactionHooks: { beforeCommit() {
    if (!sessionId) return;
    commitCount += 1;
    if (rejectNextCommit && store.conversations.listEvents({ sessionId }).some(record => record.type === "agent.domain.event")) {
      rejectNextCommit = false;
      throw new Error("commit failed");
    }
  } } });
  compactionCleanup.push(() => store.close());
  sessionId = store.sessions.create({ cwd: directory, model: "test" }).id;
  const initialSeq = store.conversations.latestEventSeq();
  const readCommitted = () => {
    const reader = new SessionStore({ path });
    try {
      return {
        messages: reader.conversations.listMessages(sessionId!),
        parts: reader.conversations.listMessageParts(sessionId!),
        events: reader.conversations.listEvents({ sessionId, afterSeq: initialSeq }),
      };
    } finally { reader.close(); }
  };
  const published: SessionEventRecord[] = [];
  const projector = new DaemonAgentEventProjector({
    rootAgent: {} as any, store, transcriptProjection: {} as any,
    executionProjector: {} as any, liveChildren: { register() {}, unregister() {} },
    events: {
      checkpoint: () => store.conversations.latestEventSeq(),
      publish: record => { published.push(record); },
      publishSince: afterSeq => {
        published.push(...readCommitted().events.filter(record => record.seq > afterSeq));
      },
    },
    log() {},
  });
  return { projector, store, sessionId, published, readCommitted,
    commitCount: () => commitCount, rejectNextCommit: () => { rejectNextCommit = true; } };
}

let sequence = 0;

function event(
  type: AgentEvent["type"],
  data: Record<string, unknown>,
  context: Partial<AgentEvent["context"]>,
): AgentEvent {
  sequence += 1;
  return {
    id: `event-${sequence}`,
    sequence,
    occurredAt: new Date().toISOString(),
    type,
    data,
    context: {
      agentId: "agent-1",
      sessionId: "parent",
      traceId: "trace-1",
      ...context,
    },
  } as AgentEvent;
}
