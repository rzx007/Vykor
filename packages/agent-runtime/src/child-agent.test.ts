import { AgentChildBudgetExceededError, AgentRunNotAcceptingInputError, MaxTurnsExceeded } from "@vykor/core";
import type { AgentChildResult, AgentInputReceipt, AgentRunHandle, AgentRunResult, AgentRunScope } from "@vykor/core";
import { describe, expect, it, vi } from "vitest";

import { AgentChildManager, AgentChildRegistry } from "./child-agent.js";
import { AgentEventBus } from "./event-source.js";
import { createRunCapabilityView } from "./run-capability-view.js";
import { ToolRegistry } from "@vykor/core";

describe("AgentChildManager", () => {
  it("uses the parent's applied selection for a newly created child", async () => {
    let appliedModel = "old-model";
    const models: string[] = [];
    const events: any[] = [];
    const bus = new AgentEventBus();
    bus.subscribe((event) => { events.push(event); });
    const manager = createManager(
      bus,
      async (options) => {
        models.push(options.model);
        return fakeAgent(() => completedRun("done"));
      },
      undefined,
      undefined,
      false,
      { model: "old-model" },
      undefined,
      () => ({ model: appliedModel, baseUrl: "" }),
    );
    const controller = manager.createController(parentScope());
    try {
      await controller.spawnChildAgent({
        description: "first", prompt: "first", agent: "worker", cwd: "/repo",
      });
      appliedModel = "new-model";
      await controller.spawnChildAgent({
        description: "second", prompt: "second", agent: "worker", cwd: "/repo",
      });
      expect(models).toEqual(["old-model", "new-model"]);
      expect(events.filter((item) => item.type === "child.created")
        .map((item) => item.data.parentRequestConfiguration.baseUrl)).toEqual(["", ""]);
    } finally {
      await manager.closeAll();
    }
  });

  it("rejects plugin Child follow-ups from another Run before idempotency or metadata can bypass authorization", async () => {
    const submitted: string[] = [];
    const manager = createManager(new AgentEventBus(), async () => fakeAgent((content: string) => {
      submitted.push(content);
      return completedRun("done");
    }));
    const view = (pluginId?: string) => createRunCapabilityView({
      toolRegistry: new ToolRegistry(), pluginIds: new Set(["P", "Q"]),
    }, pluginId);
    const first = manager.createController(parentScope(), view("P"));
    try {
      const child = await first.spawnChildAgent({ description: "d", prompt: "initial", agent: "worker", cwd: "/repo" });
      await child.result;
      const input = { id: "followup", content: "continue", metadata: { pluginId: "P" } };
      await first.sendChildInput(child.id, input);
      for (const pluginId of [undefined, "Q"]) {
        const later = manager.createController({ ...parentScope(), runId: "later" }, view(pluginId));
        await expect(later.sendChildInput(child.id, input)).rejects.toThrow("not authorized for this Run");
      }
      await expect(manager.get(child.id)!.send(input)).rejects.toThrow("not authorized for this Run");
      await expect(manager.send(child.id, input)).rejects.toThrow("not authorized for this Run");
      expect(submitted).toEqual(["initial", "continue"]);
    } finally { await manager.closeAll(); }
  });

  it("announces a failed child when its environment cannot be created", async () => {
    const events: any[] = [];
    const bus = new AgentEventBus((event) => { events.push(event); });
    const manager = createManager(bus, async () => fakeAgent(vi.fn()), undefined, undefined, false, {}, async () => { throw new Error("environment unavailable"); });
    await expect(manager.createController(parentScope()).spawnChildAgent({ description: "d", prompt: "p", agent: "worker", cwd: "/other" })).rejects.toThrow("environment unavailable");
    expect(events.map((event) => event.type)).toEqual(["child.created", "child.closed"]);
    expect(events[1].data.result).toMatchObject({ status: "failed", error: "environment unavailable" });
    expect(manager.list()).toEqual([]);
    expect(manager.getBudgetSnapshot().activeChildren).toBe(0);
  });

  it("submits every child run with its inherited view after changing cwd, without attachments", async () => {
    const bus = new AgentEventBus();
    const emitted: any[] = [];
    bus.subscribe((event) => { emitted.push(event); });
    const submitted: any[] = [];
    const manager = createManager(bus, async (childOptions) => fakeAgent((content: unknown, options: unknown) => {
      submitted.push({ content, options, cwd: childOptions.cwd });
      return completedRun("done");
    }));
    const pluginId = "dev.quality";
    const toolRegistry = new ToolRegistry();
    for (const name of ["Selected", "NarrowedOut", "OtherPlugin"]) {
      toolRegistry.register({
        name, description: name, inputSchema: { type: "object" },
        execute: async (_input, context) => ({ content: [{ type: "text", text: `${name}:${context.cwd}` }] }),
      }, { kind: "plugin", id: name === "OtherPlugin" ? "dev.other" : pluginId });
    }
    const parent = createRunCapabilityView({ toolRegistry, pluginIds: new Set([pluginId, "dev.other"]) }, pluginId);
    const controller = manager.createController(parentScope(), parent);
    const child = await controller.spawnChildAgent({
      description: "d", prompt: "task only", agent: "worker", cwd: "/other",
      allowedTools: ["Selected", "OtherPlugin"],
    });
    await child.result;
    await controller.sendChildInput(child.id, { content: "follow up" });
    expect(submitted.map(({ content }) => content)).toEqual(["task only", "follow up"]);
    for (const { options, cwd } of submitted) {
      expect(cwd).toBe("/other");
      expect(options.capabilityView?.pluginId).toBe(pluginId);
      expect([...options.capabilityView.tools.keys()]).toEqual(["Selected"]);
      expect(options.capabilityView.tools.get("Selected")).toBe(parent.tools.get("Selected"));
      await expect(options.capabilityView.tools.get("Selected").invoke({}, { cwd })).resolves.toEqual({
        content: [{ type: "text", text: "Selected:/other" }],
      });
      expect(options.capabilityView?.agents.size).toBe(0);
      expect(options.inputItems).toBeUndefined();
    }
    expect([...parent.tools.keys()]).toEqual(["Selected", "NarrowedOut"]);
    expect(emitted.find((event) => event.type === "child.created").data.spawn.capabilityView).toBeUndefined();
    await manager.closeAll();
  });

  it("lends the original host overrides and effects to a child session without cleaning them up", async () => {
    const readText = vi.fn(async (_input, context) => ({
      text: context.sessionId,
      offset: 0,
      nextOffset: 0,
      done: true,
    }));
    const hostCleanup = vi.fn(async () => {});
    const attachments = { readText, close: hostCleanup };
    const producerCleanup = vi.fn(async () => {});
    const terminal = { open: vi.fn(), close: producerCleanup };
    const terminalJobs = {};
    const capabilityOverrides = {
      attachments,
      terminal: { value: terminal, jobs: terminalJobs },
    } as any;
    const effects = { requestPermission: vi.fn() } as any;
    const createAgent = vi.fn(async (options) => ({
      ...fakeAgent(vi.fn()),
      submitMessage: vi.fn((_content, submitOptions) => {
        void options.capabilityOverrides.attachments.readText(
          { assetId: "asset-1" },
          { sessionId: options.sessionId },
        );
        const run = completedRun("done");
        return {
          ...run,
          id: submitOptions.ids.runId,
          inputId: submitOptions.ids.inputId,
          sessionId: options.sessionId,
          started: Promise.resolve({
            sessionId: options.sessionId,
            inputId: submitOptions.ids.inputId,
            runId: submitOptions.ids.runId,
          }),
        };
      }),
    }));
    const manager = new AgentChildManager({
      settings: {} as any,
      configuration: {},
      capabilityOverrides,
      effects,
      cwd: "/repo",
      eventBus: new AgentEventBus(),
      environment: { acquire: async (input) => ({ cwd: input.cwd, release: async () => {} }) },
      createAgent,
    });

    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "Borrow host overrides",
      prompt: "read the attachment",
      agent: "worker",
      cwd: "/repo/child",
      sessionId: "child-session-borrowed-host",
    });
    await invocation.result;

    const childOptions = createAgent.mock.calls[0]?.[0];
    expect(childOptions.capabilityOverrides).toBe(capabilityOverrides);
    expect(childOptions.effects).toBe(effects);
    expect(childOptions.capabilityOverrides.attachments).toBe(attachments);
    expect(childOptions.capabilityOverrides.terminal).toBe(capabilityOverrides.terminal);
    expect(readText).toHaveBeenCalledWith(
      { assetId: "asset-1" },
      { sessionId: "child-session-borrowed-host" },
    );

    await manager.closeAll();
    expect(hostCleanup).not.toHaveBeenCalled();
    expect(producerCleanup).not.toHaveBeenCalled();
  });

  it("inherits root configuration unless the child explicitly overrides it", async () => {
    const createAgent = vi.fn(async () => fakeAgent(vi.fn(() => completedRun("done"))));
    const manager = createManager(
      new AgentEventBus(),
      createAgent,
      undefined,
      undefined,
      false,
      {
        model: "root-model",
        systemPrompt: "root prompt",
        permissionMode: "plan",
        maxTurns: 9,
      },
    );

    await manager.createController(parentScope()).spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });

    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({
      model: "root-model",
      systemPrompt: "root prompt",
      permissionMode: "plan",
      maxTurns: 9,
    });
    await manager.closeAll();
  });

  it("passes the parent tool allowlist as the child host ceiling", async () => {
    const createAgent = vi.fn(async () => fakeAgent(vi.fn(() => completedRun("done"))));
    const manager = createManager(
      new AgentEventBus(),
      createAgent,
      undefined,
      undefined,
      false,
      {
        hostToolCeiling: ["Agent", "JobWait", "Workflow"],
        disallowedTools: ["Write"],
      },
    );

    await manager.createController(parentScope()).spawnChildAgent({
      description: "Worker",
      prompt: "patch",
      agent: "worker",
      cwd: "/repo",
    });

    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({
      hostToolCeiling: ["Agent", "JobWait", "Workflow"],
      roleAllowedTools: undefined,
      disallowedTools: ["Write"],
    });
    await manager.closeAll();
  });

  it("treats explicit child tools as role tools and merges inherited denies", async () => {
    const createAgent = vi.fn(async () => fakeAgent(vi.fn(() => completedRun("done"))));
    const manager = createManager(
      new AgentEventBus(),
      createAgent,
      undefined,
      undefined,
      false,
      {
        hostToolCeiling: ["Agent"],
        disallowedTools: ["Write"],
      },
    );

    await manager.createController(parentScope()).spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Shell"],
    });

    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({
      hostToolCeiling: ["Agent"],
      roleAllowedTools: ["Read", "Grep"],
      disallowedTools: ["Write", "Shell"],
    });
    await manager.closeAll();
  });

  it("owns child identity, execution, events and live directory", async () => {
    const bus = new AgentEventBus();
    const eventTypes: string[] = [];
    bus.subscribe((event) => { eventTypes.push(event.type); });
    const close = vi.fn(async () => {});
    const submitMessage = vi.fn(() => completedRun("child output"));
    const manager = createManager(bus, async () => fakeAgent(submitMessage, close));
    const controller = manager.createController(parentScope());

    const invocation = await controller.spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });

    await expect(invocation.result).resolves.toEqual({ status: "completed", output: "child output" });
    expect(invocation.id).toMatch(/^child_/);
    expect(manager.get(invocation.id)?.sessionId).toBe(invocation.sessionId);
    expect(manager.getBySessionId(invocation.sessionId)?.id).toBe(invocation.id);
    expect(eventTypes).toContain("child.created");

    await manager.closeAll();
    expect(close).toHaveBeenCalledOnce();
    expect(eventTypes).toContain("child.closed");
    expect(manager.list()).toEqual([]);
  });

  it("composes the child's initial task with its delegation scope and expected result", async () => {
    const bus = new AgentEventBus();
    const events: any[] = [];
    bus.subscribe((event) => { events.push(event); });
    const submitted: unknown[] = [];
    const manager = createManager(bus, async () => fakeAgent((content: unknown) => {
      submitted.push(content);
      return completedRun("done");
    }));
    try {
      const invocation = await manager.createController(parentScope()).spawnChildAgent({
        description: "review",
        prompt: "inspect the report",
        agent: "worker",
        cwd: "/repo",
        scope: "docs/plugin-mechanism-report.md",
        expectedResult: "findings with evidence",
      });
      await invocation.result;

      expect(submitted).toEqual([
        "inspect the report\n\nTask scope:\ndocs/plugin-mechanism-report.md\n\nExpected result:\nfindings with evidence",
      ]);
      const created = events.find((event) => event.type === "child.created");
      expect(created?.data.spawn).toMatchObject({
        scope: "docs/plugin-mechanism-report.md",
        expectedResult: "findings with evidence",
      });
    } finally {
      await manager.closeAll();
    }
  });

  it("resolves the child run turn budget from role, current configuration and delegation for every run", async () => {
    const observed: any[] = [];
    let requestConfiguration: Record<string, unknown> = { maxTurns: 5 };
    const manager = createManager(
      new AgentEventBus(),
      async () => fakeAgent((_content: unknown, options: any) => {
        observed.push(options);
        return completedRun("done");
      }),
      undefined,
      undefined,
      false,
      {},
      undefined,
      () => requestConfiguration,
    );
    const controller = manager.createController(parentScope());
    try {
      const scoped = await controller.spawnChildAgent({
        description: "d",
        prompt: "work",
        agent: "worker",
        cwd: "/repo",
        maxTurns: 30,
        requestedMaxTurns: 10,
      });
      await scoped.result;
      expect(observed.at(-1)?.hardMaxTurns).toBe(10);
      requestConfiguration = { maxTurns: 50 };
      await controller.sendChildInput(scoped.id, { content: "more" });
      await controller.awaitChildAgent(scoped.id);
      expect(observed.at(-1)?.hardMaxTurns).toBe(10);

      requestConfiguration = { maxTurns: 5 };
      const configured = await controller.spawnChildAgent({
        description: "d",
        prompt: "work",
        agent: "worker",
        cwd: "/repo",
      });
      await configured.result;
      expect(observed.at(-1)?.hardMaxTurns).toBe(5);
      requestConfiguration = { maxTurns: 8 };
      await controller.sendChildInput(configured.id, { content: "more" });
      await controller.awaitChildAgent(configured.id);
      expect(observed.at(-1)?.hardMaxTurns).toBe(8);

      const tightened = await controller.spawnChildAgent({
        description: "d",
        prompt: "work",
        agent: "worker",
        cwd: "/repo",
        requestedMaxTurns: 90,
      });
      await tightened.result;
      expect(observed.at(-1)?.hardMaxTurns).toBe(8);
    } finally {
      await manager.closeAll();
    }
  });

  it("steers an active child through its framework run handle", async () => {
    const pending = deferred<AgentRunResult>();
    const steer = vi.fn(async (input) => ({ sessionId: "child-session", inputId: input.id!, runId: "run-1" }));
    const submitMessage = vi.fn(() => runHandle(pending.promise, steer));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    const controller = manager.createController(parentScope());
    const invocation = await controller.spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
      sessionId: "child-session",
    });

    const receipt = await controller.sendChildInput(invocation.id, { id: "steer-1", content: "nudge" });

    expect(receipt).toEqual({ sessionId: "child-session", inputId: "steer-1", runId: "run-1" });
    expect(steer).toHaveBeenCalledWith({ id: "steer-1", content: "nudge" });
    pending.resolve(completedResult("done"));
    await invocation.result;
    await manager.closeAll();
  });

  it("returns a partial max-turns result carrying the finalization reply", async () => {
    const pending = deferred<AgentRunResult>();
    const submitMessage = vi.fn(() => runHandle(pending.promise, vi.fn()));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "d",
      prompt: "p",
      agent: "worker",
      cwd: "/repo",
    });

    pending.reject(new MaxTurnsExceeded(2, "final report"));

    await expect(invocation.result).resolves.toMatchObject({
      status: "failed",
      failureKind: "max_turns",
      partialResult: {
        version: 1,
        childSessionId: invocation.sessionId,
        runId: invocation.runId,
        source: "limit_finalization",
        text: "final report",
        truncated: false,
      },
    });
    await manager.closeAll();
  });

  it("bounds a max-turns finalization partial at 12,000 characters", async () => {
    const pending = deferred<AgentRunResult>();
    const submitMessage = vi.fn(() => runHandle(pending.promise, vi.fn()));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "d",
      prompt: "p",
      agent: "worker",
      cwd: "/repo",
    });

    pending.reject(new MaxTurnsExceeded(2, "x".repeat(12_001)));

    const result = await invocation.result;
    expect(result.partialResult).toMatchObject({ source: "limit_finalization", truncated: true });
    expect(result.partialResult?.text).toHaveLength(12_000);
    await manager.closeAll();
  });

  it("returns committed child text as a partial result after a mid-run failure", async () => {
    const bus = new AgentEventBus();
    const pending = deferred<AgentRunResult>();
    const submitMessage = vi.fn(() => runHandle(pending.promise, vi.fn()));
    const manager = createManager(bus, async () => fakeAgent(submitMessage));
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "d",
      prompt: "p",
      agent: "worker",
      cwd: "/repo",
    });
    const context = activityContext(invocation);

    await bus.emit({ type: "output.text.delta", data: { delta: "draft-" } }, context);
    await bus.emit({ type: "output.text.delta", data: { delta: "evidence" } }, context);
    await bus.emit({ type: "output.turn.completed", data: { stopReason: "end_turn" } }, context);
    pending.reject(new Error("model down"));

    await expect(invocation.result).resolves.toMatchObject({
      status: "failed",
      failureKind: "unknown",
      partialResult: {
        source: "committed_assistant_text",
        text: "draft-evidence",
      },
    });
    await manager.closeAll();
  });

  it("does not create an empty partial result when nothing was committed", async () => {
    const pending = deferred<AgentRunResult>();
    const submitMessage = vi.fn(() => runHandle(pending.promise, vi.fn()));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "d",
      prompt: "p",
      agent: "worker",
      cwd: "/repo",
    });

    pending.reject(new Error("model down"));

    const result = await invocation.result;
    expect(result.failureKind).toBe("unknown");
    expect(result.partialResult).toBeUndefined();
    await manager.closeAll();
  });

  it("propagates parent abort to the child", async () => {
    const pending = deferred<AgentRunResult>();
    const interrupt = vi.fn(async () => pending.reject(new Error("interrupted")));
    const submitMessage = vi.fn(() => runHandle(pending.promise, vi.fn(), interrupt));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    const parent = new AbortController();
    const invocation = await manager.createController(parentScope(parent.signal)).spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });

    parent.abort();

    await expect(invocation.result).resolves.toMatchObject({
      status: "interrupted",
      failureKind: "parent_interrupted",
    });
    expect(interrupt).toHaveBeenCalled();
  });

  it("fails a child run whose wall-clock budget expires with a trusted timeout source", async () => {
    vi.useFakeTimers();
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(signalAwareHangingRun()));
    try {
      const invocation = await manager.createController(parentScope()).spawnChildAgent({
        description: "d",
        prompt: "p",
        agent: "worker",
        cwd: "/repo",
        timeoutSeconds: 30,
      });
      let outcome: AgentChildResult | "pending" = "pending";
      invocation.result.then((result) => { outcome = result; });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(outcome).toMatchObject({ status: "failed", failureKind: "timeout" });
      expect((outcome as AgentChildResult).error).toContain("time budget");
      await manager.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fail a child run without a configured time budget", async () => {
    vi.useFakeTimers();
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(vi.fn(() => completedRun("done"))));
    try {
      const invocation = await manager.createController(parentScope()).spawnChildAgent({
        description: "d",
        prompt: "p",
        agent: "worker",
        cwd: "/repo",
      });
      await expect(invocation.result).resolves.toEqual({ status: "completed", output: "done" });

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      await expect(invocation.result).resolves.toEqual({ status: "completed", output: "done" });
      await manager.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a settled deadline and re-arms it for the next run", async () => {
    vi.useFakeTimers();
    let call = 0;
    const submitMessage = vi.fn((_content: unknown, options: any) => {
      call++;
      if (call === 1) {
        const pending = deferred<AgentRunResult>();
        pending.resolve(completedResult("first"));
        return runHandle(pending.promise, vi.fn());
      }
      return signalAwareHangingRun()(_content, options);
    });
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    try {
      const controller = manager.createController(parentScope());
      const invocation = await controller.spawnChildAgent({
        description: "d",
        prompt: "p",
        agent: "worker",
        cwd: "/repo",
        timeoutSeconds: 30,
      });
      await expect(invocation.result).resolves.toMatchObject({ status: "completed" });

      await vi.advanceTimersByTimeAsync(31_000);
      await expect(invocation.result).resolves.toMatchObject({ status: "completed" });

      await controller.sendChildInput(invocation.id, { content: "more" });
      let second: AgentChildResult | "pending" = "pending";
      controller.awaitChildAgent(invocation.id).then((result) => { second = result; });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(second).toMatchObject({ status: "failed", failureKind: "timeout" });
      await manager.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an explicit cancellation distinct from a deadline", async () => {
    const pending = deferred<AgentRunResult>();
    const interrupt = vi.fn(async () => pending.reject(new Error("User cancelled")));
    const submitMessage = vi.fn(() => runHandle(pending.promise, vi.fn(), interrupt));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    const controller = manager.createController(parentScope());
    const invocation = await controller.spawnChildAgent({
      description: "d",
      prompt: "p",
      agent: "worker",
      cwd: "/repo",
      timeoutSeconds: 600,
    });

    await controller.interruptChildAgent(invocation.id, "User cancelled");

    const result = await invocation.result;
    expect(result.status).toBe("interrupted");
    expect(result.failureKind).toBe("user_cancelled");
    expect(result.error).toContain("User cancelled");
  });

  it("exposes only committed assistant text and successful turns in the child activity snapshot", async () => {
    const bus = new AgentEventBus();
    const manager = createManager(bus, async () => fakeAgent(vi.fn(() => completedRun("done"))));
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "d",
      prompt: "p",
      agent: "worker",
      cwd: "/repo",
    });
    const context = activityContext(invocation);

    await bus.emit({ type: "output.text.delta", data: { delta: "partial answer" } }, context);
    expect(manager.get(invocation.id)?.activity?.latestAssistantText).toBeUndefined();

    await bus.emit({ type: "output.turn.completed", data: { stopReason: "end_turn" } }, context);
    expect(manager.get(invocation.id)?.activity).toMatchObject({
      version: 1,
      runId: invocation.runId,
      modelTurns: 1,
      latestAssistantText: "partial answer",
    });

    await bus.emit({ type: "output.text.delta", data: { delta: "final" } }, context);
    await bus.emit({ type: "output.turn.completed", data: { stopReason: "end_turn" } }, context);
    expect(manager.get(invocation.id)?.activity).toMatchObject({
      modelTurns: 2,
      latestAssistantText: "final",
    });
    await manager.closeAll();
  });

  it("caps committed activity text at 2,000 characters", async () => {
    const bus = new AgentEventBus();
    const manager = createManager(bus, async () => fakeAgent(vi.fn(() => completedRun("done"))));
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "d",
      prompt: "p",
      agent: "worker",
      cwd: "/repo",
    });
    const context = activityContext(invocation);

    await bus.emit({ type: "output.text.delta", data: { delta: "x".repeat(2_500) } }, context);
    await bus.emit({ type: "output.turn.completed", data: { stopReason: "end_turn" } }, context);

    expect(manager.get(invocation.id)?.activity?.latestAssistantText).toHaveLength(2_000);
    await manager.closeAll();
  });

  it("discards staged text on retry and failure without losing committed text", async () => {
    const bus = new AgentEventBus();
    const manager = createManager(bus, async () => fakeAgent(vi.fn(() => completedRun("done"))));
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "d",
      prompt: "p",
      agent: "worker",
      cwd: "/repo",
    });
    const context = activityContext(invocation);

    await bus.emit({ type: "output.text.delta", data: { delta: "stale" } }, context);
    await bus.emit({ type: "output.generation.started", data: { generationId: "g1", attempt: 1 } }, context);
    await bus.emit({ type: "output.turn.completed", data: { stopReason: "end_turn" } }, context);
    expect(manager.get(invocation.id)?.activity?.latestAssistantText).toBeUndefined();

    await bus.emit({ type: "output.text.delta", data: { delta: "fresh" } }, context);
    await bus.emit({ type: "output.turn.completed", data: { stopReason: "end_turn" } }, context);
    expect(manager.get(invocation.id)?.activity?.latestAssistantText).toBe("fresh");

    await bus.emit({ type: "output.text.delta", data: { delta: "doomed" } }, context);
    await bus.emit({
      type: "run.failed",
      data: { error: { name: "Error", message: "boom" } },
    }, context);
    expect(manager.get(invocation.id)?.activity?.latestAssistantText).toBe("fresh");
    await manager.closeAll();
  });

  it("never exposes reasoning or tool payloads in the child activity snapshot", async () => {
    const bus = new AgentEventBus();
    const manager = createManager(bus, async () => fakeAgent(vi.fn(() => completedRun("done"))));
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "d",
      prompt: "p",
      agent: "worker",
      cwd: "/repo",
    });
    const context = activityContext(invocation);

    await bus.emit({ type: "output.reasoning.delta", data: { delta: "SECRET REASONING", source: "think" } }, context);
    await bus.emit({
      type: "tool.started",
      data: { toolUse: { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/secret/path" } } },
    }, context);
    expect(manager.get(invocation.id)?.activity).toMatchObject({
      toolCalls: 1,
      latestTool: { name: "Read", status: "running" },
    });
    await bus.emit({
      type: "tool.completed",
      data: { toolUseId: "t1", result: { content: [{ type: "text", text: "SECRET BODY" }] } },
    }, context);
    expect(manager.get(invocation.id)?.activity?.latestTool).toMatchObject({ name: "Read", status: "completed" });

    await bus.emit({
      type: "tool.started",
      data: { toolUse: { type: "tool_use", id: "t2", name: "Shell", input: { command: "echo secret" } } },
    }, context);
    await bus.emit({
      type: "tool.completed",
      data: { toolUseId: "t2", result: { content: [{ type: "text", text: "SECRET" }], isError: true } },
    }, context);
    expect(manager.get(invocation.id)?.activity?.latestTool).toMatchObject({ name: "Shell", status: "failed" });

    const serialized = JSON.stringify(manager.get(invocation.id)?.activity);
    expect(serialized).not.toContain("SECRET REASONING");
    expect(serialized).not.toContain("SECRET BODY");
    expect(serialized).not.toContain("/secret/path");
    expect(serialized).not.toContain("echo secret");
    expect(manager.get(invocation.id)?.activity?.toolCalls).toBe(2);
    await manager.closeAll();
  });

  it("isolates the activity snapshot per run", async () => {
    const bus = new AgentEventBus();
    const manager = createManager(bus, async () => fakeAgent(vi.fn((_content, options) => runHandle(
      Promise.resolve(completedResult("done")),
      vi.fn(),
      vi.fn(async () => {}),
      Promise.resolve({ sessionId: "child-session", ...options.ids }),
    ))));
    const controller = manager.createController(parentScope());
    const invocation = await controller.spawnChildAgent({
      description: "d",
      prompt: "p",
      agent: "worker",
      cwd: "/repo",
    });
    const first = activityContext(invocation);

    await bus.emit({ type: "output.text.delta", data: { delta: "first run text" } }, first);
    await bus.emit({ type: "output.turn.completed", data: { stopReason: "end_turn" } }, first);
    await bus.emit({
      type: "tool.started",
      data: { toolUse: { type: "tool_use", id: "t1", name: "Read", input: {} } },
    }, first);
    expect(manager.get(invocation.id)?.activity).toMatchObject({ modelTurns: 1, toolCalls: 1 });

    await invocation.result;
    const receipt = await controller.sendChildInput(invocation.id, { content: "follow up" });
    const second = activityContext(invocation, receipt.runId);
    await bus.emit({
      type: "tool.started",
      data: { toolUse: { type: "tool_use", id: "t2", name: "Grep", input: {} } },
    }, second);

    await bus.emit({ type: "output.text.delta", data: { delta: "stale text" } }, first);
    await bus.emit({ type: "output.turn.completed", data: { stopReason: "end_turn" } }, first);

    expect(manager.get(invocation.id)?.activity).toMatchObject({
      runId: receipt.runId,
      modelTurns: 0,
      toolCalls: 1,
      latestTool: { name: "Grep", status: "running" },
    });
    expect(manager.get(invocation.id)?.activity?.latestAssistantText).toBeUndefined();
    await manager.closeAll();
  });

  it("returns the durable terminal partial instead of the shorter activity preview", async () => {
    const bus = new AgentEventBus();
    const pending = deferred<AgentRunResult>();
    const manager = createManager(bus, async () => fakeAgent(vi.fn((_content, options) => runHandle(
      pending.promise,
      vi.fn(),
      vi.fn(async () => {}),
      Promise.resolve({ sessionId: "child-session", ...options.ids }),
    ))));
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "d", prompt: "p", agent: "worker", cwd: "/repo",
    });
    const partialResult = {
      version: 1 as const,
      childSessionId: invocation.sessionId,
      runId: invocation.runId!,
      source: "committed_assistant_text" as const,
      text: "x".repeat(3_000),
      truncated: false,
    };
    await bus.emit({
      type: "run.failed",
      data: { error: { name: "Error", message: "boom" }, partialResult },
    }, activityContext(invocation));
    pending.reject(new Error("boom"));

    expect((await invocation.result).partialResult).toEqual(partialResult);
    await manager.closeAll();
  });

  it("queues a new run when an active run has stopped accepting steer", async () => {
    const first = deferred<AgentRunResult>();
    const firstRun = runHandle(
      first.promise,
      vi.fn(async () => { throw new AgentRunNotAcceptingInputError("run-1"); }),
    );
    const submitMessage = vi.fn()
      .mockReturnValueOnce(firstRun)
      .mockReturnValueOnce({ ...completedRun("second"), id: "run-2", inputId: "input-2" });
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    const controller = manager.createController(parentScope());
    const invocation = await controller.spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });

    const followUp = controller.sendChildInput(invocation.id, { content: "second" });
    first.resolve(completedResult("first"));

    const receipt = await followUp;
    expect(receipt.runId).toMatch(/^run_/);
    expect(receipt.inputId).toMatch(/^input_/);
    expect(submitMessage).toHaveBeenCalledTimes(2);
    expect(submitMessage.mock.calls[1]?.[1]).toMatchObject({
      ids: { runId: receipt.runId, inputId: receipt.inputId },
    });
    await manager.closeAll();
  });

  it("does not expose a child receipt until run.started has been delivered", async () => {
    const started = deferred<void>();
    const submitMessage = vi.fn((_content, options) => runHandle(
      Promise.resolve(completedResult("done")),
      vi.fn(),
      vi.fn(async () => {}),
      started.promise.then(() => ({
        sessionId: "child-session",
        inputId: options.ids.inputId,
        runId: options.ids.runId,
      })),
    ));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    let settled = false;
    const spawn = manager.createController(parentScope()).spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    started.resolve();
    await expect(spawn).resolves.toMatchObject({
      inputId: expect.stringMatching(/^input_/),
      runId: expect.stringMatching(/^run_/),
    });
    await manager.closeAll();
  });

  it("rejects a child run whose started receipt changes framework identity", async () => {
    const interrupt = vi.fn(async () => {});
    const submitMessage = vi.fn(() => runHandle(
      Promise.resolve(completedResult("done")),
      vi.fn(),
      interrupt,
      Promise.resolve({ sessionId: "wrong-session", inputId: "wrong-input", runId: "wrong-run" }),
    ));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage), undefined, undefined, true);

    await expect(manager.createController(parentScope()).spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
      sessionId: "child-session",
    })).rejects.toThrow("Child run identity conflict");
    expect(interrupt).toHaveBeenCalledWith("Child run started with unexpected identity");
    expect(manager.list()).toEqual([]);
  });

  it("indexes descendants from multiple managers in one tree-wide directory", async () => {
    const directory = new AgentChildRegistry();
    const first = createManager(new AgentEventBus(), async () => fakeAgent(vi.fn(() => completedRun("first"))), undefined, directory);
    const second = createManager(new AgentEventBus(), async () => fakeAgent(vi.fn(() => completedRun("second"))), undefined, directory);

    const parent = await first.createController(parentScope()).spawnChildAgent({
      description: "Parent",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
      sessionId: "child-parent",
    });
    const descendant = await second.createController({ ...parentScope(), sessionId: parent.sessionId }).spawnChildAgent({
      description: "Descendant",
      prompt: "second",
      agent: "Explore",
      cwd: "/repo",
      sessionId: "child-descendant",
    });

    expect(directory.get(parent.id)?.sessionId).toBe("child-parent");
    expect(directory.get(descendant.id)?.sessionId).toBe("child-descendant");
    expect(directory.list()).toHaveLength(2);
    await first.closeAll();
    await second.closeAll();
    expect(directory.list()).toEqual([]);
  });

  it("rejects a tree-wide child session collision before creating another agent", async () => {
    const directory = new AgentChildRegistry();
    const firstFactory = vi.fn(async () => fakeAgent(vi.fn(() => completedRun("first"))));
    const secondFactory = vi.fn(async () => fakeAgent(vi.fn(() => completedRun("second"))));
    const first = createManager(new AgentEventBus(), firstFactory, undefined, directory);
    const second = createManager(new AgentEventBus(), secondFactory, undefined, directory);

    await first.createController(parentScope()).spawnChildAgent({
      description: "First",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
      sessionId: "shared-child-session",
    });

    await expect(second.createController(parentScope()).spawnChildAgent({
      description: "Second",
      prompt: "inspect again",
      agent: "Explore",
      cwd: "/repo",
      sessionId: "shared-child-session",
    })).rejects.toThrow("Child agent session is already live");
    expect(secondFactory).not.toHaveBeenCalled();
    expect(directory.getBySessionId("shared-child-session")).toBeDefined();
    await first.closeAll();
  });

  it("suspends idle resources and restores history for the next run", async () => {
    const bus = new AgentEventBus();
    const events: string[] = [];
    bus.subscribe((event) => { events.push(event.type); });
    const firstAgent = fakeAgent(vi.fn(() => completedRun("first")));
    firstAgent.getHistory.mockReturnValue([{ type: "assistant", content: "remembered" }]);
    const secondAgent = fakeAgent(vi.fn(() => ({ ...completedRun("second"), id: "run-2", inputId: "input-2" })));
    const createAgent = vi.fn()
      .mockResolvedValueOnce(firstAgent)
      .mockResolvedValueOnce(secondAgent);
    const manager = createManager(bus, createAgent, 5);
    const controller = manager.createController(parentScope());
    const invocation = await controller.spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });
    await invocation.result;
    await waitUntil(() => events.includes("child.suspended"));

    await controller.sendChildInput(invocation.id, {
      content: "continue",
      delivery: "queue",
      metadata: { requestedBy: "test" },
    });

    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(secondAgent.loadHistory).toHaveBeenCalledWith([{ type: "assistant", content: "remembered" }]);
    expect(secondAgent.submitMessage.mock.calls[0]?.[1]).toMatchObject({
      metadata: { requestedBy: "test" },
    });
    expect(events).toContain("child.resumed");
    await manager.closeAll();
  });

  it("closes an agent created by an in-flight resume without starting an orphan run", async () => {
    const bus = new AgentEventBus();
    const events: string[] = [];
    bus.subscribe((event) => { events.push(event.type); });
    const firstAgent = fakeAgent(vi.fn(() => completedRun("first")));
    const resumedAgent = fakeAgent(vi.fn(() => completedRun("orphan")));
    const resumed = deferred<any>();
    const createAgent = vi.fn()
      .mockResolvedValueOnce(firstAgent)
      .mockImplementationOnce(async () => await resumed.promise);
    const manager = createManager(bus, createAgent, 5);
    const controller = manager.createController(parentScope());
    const invocation = await controller.spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });
    await invocation.result;
    await waitUntil(() => events.includes("child.suspended"));

    const followUp = controller.sendChildInput(invocation.id, { content: "continue", delivery: "queue" });
    await waitUntil(() => createAgent.mock.calls.length === 2);
    const closing = manager.close(invocation.id);
    resumed.resolve(resumedAgent);

    await expect(closing).resolves.toBeUndefined();
    await expect(followUp).rejects.toThrow("Child agent is closing or closed");
    expect(resumedAgent.submitMessage).not.toHaveBeenCalled();
    expect(resumedAgent.close).toHaveBeenCalled();
    expect(events.at(-1)).toBe("child.closed");
    expect(manager.list()).toEqual([]);
  });

  it("deduplicates cleanup when a child is closed during its initial agent creation", async () => {
    const bus = new AgentEventBus();
    const events: string[] = [];
    bus.subscribe((event) => { events.push(event.type); });
    const created = deferred<any>();
    const childAgent = fakeAgent(vi.fn(() => completedRun("unexpected")));
    const createAgent = vi.fn(async () => await created.promise);
    const manager = createManager(bus, createAgent);
    const spawn = manager.createController(parentScope()).spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });
    await waitUntil(() => createAgent.mock.calls.length === 1);
    const childId = manager.list()[0]!.id;

    const closing = manager.close(childId);
    created.resolve(childAgent);

    await expect(closing).resolves.toBeUndefined();
    await expect(spawn).rejects.toThrow("Child agent is closing or closed");
    expect(childAgent.submitMessage).not.toHaveBeenCalled();
    expect(childAgent.close).toHaveBeenCalledOnce();
    expect(events.filter((type) => type === "child.closed")).toHaveLength(1);
    expect(manager.list()).toEqual([]);
  });

  it("treats reordered metadata keys as the same idempotent child input", async () => {
    const submitMessage = vi.fn(() => completedRun("done"));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    const controller = manager.createController(parentScope());
    const invocation = await controller.spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });
    await invocation.result;

    const first = await controller.sendChildInput(invocation.id, {
      id: "same-input",
      content: "continue",
      delivery: "queue",
      metadata: { outer: { first: 1, second: 2 }, tail: true },
    });
    const replay = await controller.sendChildInput(invocation.id, {
      id: "same-input",
      content: "continue",
      delivery: "queue",
      metadata: { tail: true, outer: { second: 2, first: 1 } },
    });

    expect(replay).toEqual(first);
    expect(submitMessage).toHaveBeenCalledTimes(2);
    await manager.closeAll();
  });

  it("rejects new input as soon as child close begins", async () => {
    const pending = deferred<AgentRunResult>();
    const interrupt = vi.fn(async () => pending.reject(new Error("interrupted")));
    const submitMessage = vi.fn(() => runHandle(pending.promise, vi.fn(), interrupt));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    const controller = manager.createController(parentScope());
    const invocation = await controller.spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });

    const closing = manager.close(invocation.id);

    expect(manager.get(invocation.id)?.state).toBe("closing");
    await expect(controller.sendChildInput(invocation.id, {
      content: "must not start",
      delivery: "queue",
    })).rejects.toThrow("Child agent is closing or closed");
    await closing;
    expect(submitMessage).toHaveBeenCalledOnce();
  });

  it("surfaces required child.closed delivery failures and still removes the handle", async () => {
    const bus = new AgentEventBus((event) => {
      if (event.type === "child.closed") throw new Error("projection unavailable");
    });
    const manager = createManager(bus, async () => fakeAgent(vi.fn(() => completedRun("done"))));
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });
    await invocation.result;

    await expect(manager.closeAll()).rejects.toThrow("projection unavailable");
    expect(manager.list()).toEqual([]);
  });

  it("finishes child cleanup when run interruption fails", async () => {
    const interruptError = new Error("interrupt failed");
    const close = vi.fn(async () => {});
    const run = runHandle(new Promise<AgentRunResult>(() => {}), vi.fn(), vi.fn(async () => {
      throw interruptError;
    }));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(vi.fn(() => run), close));
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });

    await expect(manager.close(invocation.id)).rejects.toBe(interruptError);
    expect(close).toHaveBeenCalledOnce();
    expect(manager.list()).toEqual([]);
  });

  it("reports agent cleanup failure after releasing the child handle", async () => {
    const closeError = new Error("agent close failed");
    const events: string[] = [];
    const bus = new AgentEventBus();
    bus.subscribe((event) => { events.push(event.type); });
    const manager = createManager(
      bus,
      async () => fakeAgent(vi.fn(() => completedRun("done")), vi.fn(async () => { throw closeError; })),
    );
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });
    await invocation.result;

    await expect(manager.closeAll()).rejects.toBe(closeError);
    expect(events).toContain("child.closed");
    expect(manager.list()).toEqual([]);
  });

  it("removes a child whose idle suspension cannot close its Agent", async () => {
    const events: string[] = [];
    const bus = new AgentEventBus();
    bus.subscribe((event) => { events.push(event.type); });
    const close = vi.fn(async () => { throw new Error("suspend close failed"); });
    const manager = createManager(
      bus,
      async () => fakeAgent(vi.fn(() => completedRun("done")), close),
      5,
    );
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });
    await invocation.result;

    await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 3_000 });
    await vi.waitFor(() => expect(manager.list()).toEqual([]), { timeout: 3_000 });
    expect(events).not.toContain("child.suspended");
    expect(events).toContain("child.closed");
    const failure = await manager.closeAll().catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).errors.every((error) => error.message === "suspend close failed")).toBe(true);
    await expect(manager.closeAll()).resolves.toBeUndefined();
  });

  it("bounds settled child input idempotency history", async () => {
    const manager = createManager(
      new AgentEventBus(),
      async () => fakeAgent(vi.fn(() => completedRun("done"))),
    );
    const controller = manager.createController(parentScope());
    const invocation = await controller.spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });

    for (let index = 0; index < 270; index++) {
      await controller.sendChildInput(invocation.id, {
        id: `request-${index}`,
        content: `follow up ${index}`,
        delivery: "queue",
      });
    }

    const record = (manager as any).records.get(invocation.id);
    expect(record.requests.size).toBe(256);
    await manager.closeAll();
  });
  it("rejects depth, active, and total limits before allocating another environment", async () => {
    const budget = { maxDepth: 1, maxActiveChildren: 1, maxTotalChildren: 1 };
    const directory = new AgentChildRegistry(budget);
    const acquire = vi.fn(async (input: any) => ({ cwd: input.cwd, release: async () => {} }));
    const configuration = { childBudget: budget };
    const root = createManager(
      new AgentEventBus(),
      async () => fakeAgent(vi.fn(() => completedRun("root child"))),
      undefined,
      directory,
      false,
      configuration,
      acquire,
    );

    const first = await root.createController(parentScope()).spawnChildAgent({
      description: "first",
      prompt: "work",
      agent: "worker",
      cwd: "/repo",
      sessionId: "level-one",
    });

    await expect(root.createController(parentScope()).spawnChildAgent({
      description: "active overflow",
      prompt: "work",
      agent: "worker",
      cwd: "/repo",
    })).rejects.toMatchObject({
      name: "AgentChildBudgetExceededError",
      dimension: "activeChildren",
      current: 1,
      limit: 1,
    });
    expect(acquire).toHaveBeenCalledTimes(1);

    const descendant = createManager(
      new AgentEventBus(),
      async () => fakeAgent(vi.fn(() => completedRun("descendant"))),
      undefined,
      directory,
      false,
      configuration,
      acquire,
    );
    await expect(descendant.createController({ ...parentScope(), sessionId: first.sessionId }).spawnChildAgent({
      description: "too deep",
      prompt: "work",
      agent: "worker",
      cwd: "/repo",
    })).rejects.toMatchObject({ dimension: "depth", current: 2, limit: 1 });
    expect(acquire).toHaveBeenCalledTimes(1);

    await root.closeAll();
    await expect(root.createController(parentScope()).spawnChildAgent({
      description: "total overflow",
      prompt: "work",
      agent: "worker",
      cwd: "/repo",
    })).rejects.toMatchObject({ dimension: "totalChildren", current: 1, limit: 1 });
    expect(directory.snapshotBudget()).toEqual({ ...budget, activeChildren: 0, totalChildren: 1 });
  });

  it("reserves the shared active budget atomically across concurrent spawns", async () => {
    const budget = { maxDepth: 2, maxActiveChildren: 1, maxTotalChildren: 4 };
    const directory = new AgentChildRegistry(budget);
    const acquired = deferred<void>();
    const acquire = vi.fn(async (input: any) => {
      await acquired.promise;
      return { cwd: input.cwd, release: async () => {} };
    });
    const manager = createManager(
      new AgentEventBus(),
      async () => fakeAgent(vi.fn(() => completedRun("done"))),
      undefined,
      directory,
      false,
      { childBudget: budget },
      acquire,
    );

    const first = manager.createController(parentScope()).spawnChildAgent({
      description: "first",
      prompt: "work",
      agent: "worker",
      cwd: "/repo",
    });
    await expect(manager.createController(parentScope()).spawnChildAgent({
      description: "second",
      prompt: "work",
      agent: "worker",
      cwd: "/repo",
    })).rejects.toBeInstanceOf(AgentChildBudgetExceededError);
    expect(acquire).toHaveBeenCalledTimes(1);
    acquired.resolve();
    await first;
    await manager.closeAll();
  });

  it("rolls budget reservations back when environment allocation fails", async () => {
    const budget = { maxDepth: 2, maxActiveChildren: 1, maxTotalChildren: 1 };
    const directory = new AgentChildRegistry(budget);
    const acquire = vi.fn()
      .mockRejectedValueOnce(new Error("environment unavailable"))
      .mockImplementationOnce(async (input: any) => ({ cwd: input.cwd, release: async () => {} }));
    const manager = createManager(
      new AgentEventBus(),
      async () => fakeAgent(vi.fn(() => completedRun("done"))),
      undefined,
      directory,
      false,
      { childBudget: budget },
      acquire,
    );

    await expect(manager.createController(parentScope()).spawnChildAgent({
      description: "fails",
      prompt: "work",
      agent: "worker",
      cwd: "/repo",
    })).rejects.toThrow("environment unavailable");
    expect(directory.snapshotBudget()).toEqual({ ...budget, activeChildren: 0, totalChildren: 0 });

    await expect(manager.createController(parentScope()).spawnChildAgent({
      description: "succeeds",
      prompt: "work",
      agent: "worker",
      cwd: "/repo",
    })).resolves.toBeDefined();
    await manager.closeAll();
  });
});

function createManager(
  bus: AgentEventBus,
  createAgent: (...args: any[]) => Promise<any>,
  idleTtlMs?: number,
  directory?: AgentChildRegistry,
  preserveRunIdentity = false,
  configuration: Record<string, unknown> = {},
  acquire: (input: any, childId: string) => Promise<any> = async (input) => ({ cwd: input.cwd, release: async () => {} }),
  configurationForChild?: () => Record<string, unknown>,
) {
  return new AgentChildManager({
    settings: {} as any,
    configuration,
    ...(configurationForChild ? { configurationForChild } : {}),
    cwd: "/repo",
    eventBus: bus,
    idleTtlMs,
    directory,
    createAgent: async (options, identity) => {
      const agent = await createAgent(options, identity);
      if (preserveRunIdentity) return agent;
      const submitMessage = agent.submitMessage;
      return {
        ...agent,
        submitMessage: (content: unknown, submitOptions: any) => {
          const run = submitMessage(content, submitOptions);
          const ids = submitOptions.ids;
          return {
            ...run,
            id: ids.runId,
            inputId: ids.inputId,
            sessionId: options.sessionId,
            started: run.started.then(() => ({
              sessionId: options.sessionId,
              inputId: ids.inputId,
              runId: ids.runId,
            })),
          };
        },
      };
    },
    environment: {
      acquire,
    },
  });
}

function parentScope(signal = new AbortController().signal): AgentRunScope {
  return {
    agentId: "parent",
    sessionId: "parent",
    inputId: "parent-input",
    runId: "parent-run",
    cwd: "/repo",
    traceId: "parent-trace",
    signal,
  };
}

function fakeAgent(submitMessage: any, close = vi.fn(async () => {})) {
  return {
    submitMessage,
    getHistory: vi.fn(() => []),
    loadHistory: vi.fn(),
    close,
  };
}

function completedRun(output: string): AgentRunHandle {
  return runHandle(Promise.resolve(completedResult(output)), vi.fn());
}

function signalAwareHangingRun() {
  return (_content: unknown, options: any): AgentRunHandle => {
    const pending = deferred<AgentRunResult>();
    options.signal.addEventListener(
      "abort",
      () => pending.reject(options.signal.reason ?? new Error("aborted")),
      { once: true },
    );
    return runHandle(pending.promise, vi.fn());
  };
}

function activityContext(invocation: { id: string; sessionId: string; runId?: string }, runId = invocation.runId!) {
  return {
    agentId: "child-agent",
    sessionId: invocation.sessionId,
    runId,
    childId: invocation.id,
  };
}

function runHandle(
  result: Promise<AgentRunResult>,
  steer: any,
  interrupt = vi.fn(async () => {}),
  started: Promise<AgentInputReceipt> = Promise.resolve({
    sessionId: "child-session",
    inputId: "input-1",
    runId: "run-1",
  }),
): AgentRunHandle {
  return {
    id: "run-1",
    inputId: "input-1",
    sessionId: "child-session",
    traceId: "trace-1",
    started,
    result,
    steer,
    interrupt,
  };
}

function completedResult(output: string): AgentRunResult {
  return {
    status: "completed",
    output,
    history: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition was not met");
}
