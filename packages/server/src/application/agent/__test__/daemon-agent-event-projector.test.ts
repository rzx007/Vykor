import type { AgentEvent } from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import {
  DaemonAgentEventProjector,
  type DaemonAgentEventProjectorContext,
} from "../daemon-agent-event-projector.js";

function projectorStore(flat: Record<string, any>) {
  return {
    sessions: {
      get: flat.getSession ?? vi.fn(),
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
    },
    runs: {
      getRun: flat.getRun ?? vi.fn(),
      createRun: flat.createRun ?? vi.fn(),
      updateRun: flat.updateRun ?? vi.fn(),
      createRunAttempt: flat.createRunAttempt ?? vi.fn(),
      updateRunAttempt: flat.updateRunAttempt ?? vi.fn(),
      listRunAttempts: flat.listRunAttempts ?? vi.fn(() => []),
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

  it("accepts only assessments bound to the current nonterminal session run", async () => {
    const run = {
      id: "r1",
      sessionId: "s1",
      status: "running",
      metadata: { goalId: "g1", goalRevision: 2 },
    };
    const updateRun = vi.fn();
    const projector = new DaemonAgentEventProjector({
      store: projectorStore({
        getRun: () => run,
        updateRun,
        appendEvent: vi.fn(),
        listEvents: () => [],
      }),
      rootAgent: {} as any,
      transcriptProjection: {} as any,
      executionProjector: {} as any,
      liveChildren: {} as any,
      events: { checkpoint: () => 0, publish: vi.fn(), publishSince: vi.fn() },
      log: vi.fn(),
    });
    const payload = {
      goalId: "g1",
      revision: 2,
      runId: "r1",
      decision: "complete",
      progress: "done",
      progressAssessment: { kind: "progress", summary: "done" },
      evidence: [],
      evidenceRefs: [],
      requirements: [
        {
          requirement: "完成目标",
          source: "目标正文",
          status: "needs_user",
          evidenceRefs: [],
        },
      ],
      remainingWork: [],
    };
    for (const change of [{ goalId: "foreign" }, { revision: 1 }, { runId: "foreign" }]) {
      await projector.apply(
        event(
          "domain.event",
          { name: "goal.assessment", payload: { ...payload, ...change } },
          { sessionId: "s1", runId: "r1" },
        ),
      );
    }
    await projector.apply(
      event(
        "domain.event",
        { name: "goal.assessment", payload },
        { sessionId: "foreign", runId: "r1" },
      ),
    );
    expect(updateRun).not.toHaveBeenCalled();
    await projector.apply(
      event("domain.event", { name: "goal.assessment", payload }, { sessionId: "s1", runId: "r1" }),
    );
    expect(updateRun).toHaveBeenCalledOnce();
    run.status = "completed";
    await projector.apply(
      event("domain.event", { name: "goal.assessment", payload }, { sessionId: "s1", runId: "r1" }),
    );
    expect(updateRun).toHaveBeenCalledOnce();
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
      bridge: { completeChildExecution },
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
});

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
