import {
  AgentRunNotAcceptingInputError,
  type AgentRunHandle,
} from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import { SessionRunEngine } from "../session-run-engine.js";
import { RunInterruptedError } from "../../../runtime/run-coordinator.js";

describe("SessionRunEngine", () => {
  it("rejects capability steer without delivering it to the active run", async () => {
    const store = createStore();
    const pending = deferred<void>();
    const handle = runHandle(pending.promise, vi.fn());
    const runExecutor = {
      execute: vi.fn(async (_input, context) => {
        await context.registerHandle(handle);
        await handle.result;
      }),
    };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });
    await engine.admitPromptAndMaybeRun("s1", { content: "root" });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());
    store.admitPrompt.mockClear();
    store.createRun.mockClear();

    await expect(engine.admitPromptAndMaybeRun("s1", {
      id: "capability-steer",
      delivery: "steer",
      items: [{
        type: "capability",
        kind: "plugin",
        pluginId: "dev.openharness.quality",
        displayName: "Quality",
      }],
    })).rejects.toThrow("session_capability_requires_queued_run");

    expect(handle.steer).not.toHaveBeenCalled();
    expect(store.admitPrompt).not.toHaveBeenCalled();
    expect(store.createRun).not.toHaveBeenCalled();
    pending.resolve();
    await engine.waitForRuns(["r1"]);
  });

  it("admits root work and forwards steer directly to the active handle", async () => {
    const store = createStore();
    const pending = deferred<void>();
    const steer = vi.fn(async (input) => {
      store.bindInputToRun(input.id!, "r1");
      return { sessionId: "s1", inputId: input.id!, runId: "r1" };
    });
    const handle = runHandle(pending.promise, steer);
    const runExecutor = {
      execute: vi.fn(async (_input, context) => {
        await context.registerHandle(handle);
        await handle.result;
      }),
    };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    const root = await engine.admitPromptAndMaybeRun("s1", {
      content: "hello",
      traceId: "trace-1",
    });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());
    const steered = await engine.admitPromptAndMaybeRun("s1", {
      id: "steer-1",
      content: "nudge",
      delivery: "steer",
      traceId: "trace-2",
    });
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce());

    expect(root.queue_state).toBe("running");
    expect(steered.run?.id).toBe(root.run?.id);
    await expect(
      engine.admitPromptAndMaybeRun("s1", {
        id: "steer-1",
        content: "nudge",
        delivery: "steer",
        traceId: "retry-trace",
      }),
    ).resolves.toMatchObject({ run: { id: root.run?.id } });
    expect(steer).toHaveBeenCalledOnce();
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "steer-1", content: "nudge" }),
    );
    pending.resolve();
    await engine.waitForRuns([root.run!.id]);
  });

  it("shares one pending delivery for concurrent requests with the same input id", async () => {
    const store = createStore();
    const runDone = deferred<void>();
    const delivery = deferred<{
      sessionId: string;
      inputId: string;
      runId: string;
    }>();
    const steer = vi.fn(async (input) => {
      store.bindInputToRun(input.id!, "r1");
      return await delivery.promise;
    });
    const handle = runHandle(runDone.promise, steer);
    const runExecutor = {
      execute: vi.fn(async (_input, context) => {
        await context.registerHandle(handle);
        await handle.result;
      }),
    };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });
    await engine.admitPromptAndMaybeRun("s1", { content: "root" });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());

    const first = engine.admitPromptAndMaybeRun("s1", {
      id: "same-steer",
      content: "nudge",
      delivery: "steer",
    });
    const duplicate = engine.admitPromptAndMaybeRun("s1", {
      id: "same-steer",
      content: "nudge",
      delivery: "steer",
    });

    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce());
    delivery.resolve({ sessionId: "s1", inputId: "same-steer", runId: "r1" });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ run: expect.objectContaining({ id: "r1" }) }),
      expect.objectContaining({ run: expect.objectContaining({ id: "r1" }) }),
    ]);
    runDone.resolve();
  });

  it.each([
    [
      "order",
      [{ assetId: "b" }, { assetId: "a" }],
      [{ assetId: "a" }, { assetId: "b" }],
    ],
    ["intent", [{ assetId: "a" }], [{ assetId: "a", intent: "ocr" }]],
    [
      "display name",
      [{ assetId: "a", displayName: "first.png" }],
      [{ assetId: "a", displayName: "second.png" }],
    ],
  ] as const)("rejects concurrent id reuse with changed attachment %s", async (_label, firstAttachments, changedAttachments) => {
    const store = createStore();
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: false } as any,
      runExecutor: {} as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });
    const first = engine.admitPromptAndMaybeRun("s1", {
      id: `same-${_label}`,
      content: "inspect",
      attachments: [...firstAttachments],
    });

    expect(() =>
      engine.admitPromptAndMaybeRun("s1", {
        id: `same-${_label}`,
        content: "inspect",
        attachments: [...changedAttachments],
      }),
    ).toThrow(/prompt_id_conflict/);
    await first;
  });

  it("terminalizes a steer input interrupted before delivery", async () => {
    const store = createStore();
    const runDone = deferred<void>();
    const delivery = deferred<{
      sessionId: string;
      inputId: string;
      runId: string;
    }>();
    const handle = runHandle(
      runDone.promise,
      vi.fn(async () => await delivery.promise),
      vi.fn(async () =>
        delivery.reject(new AgentRunNotAcceptingInputError("r1")),
      ),
    );
    const runExecutor = {
      execute: vi.fn(async (_input, context) => {
        await context.registerHandle(handle);
        await handle.result;
      }),
    };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });
    await engine.admitPromptAndMaybeRun("s1", { content: "root" });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());
    const steered = engine.admitPromptAndMaybeRun("s1", {
      id: "interrupted-steer",
      content: "stop this",
      delivery: "steer",
    });
    await vi.waitFor(() => expect(handle.steer).toHaveBeenCalledOnce());

    engine.interruptSession("s1");

    await expect(steered).rejects.toBeInstanceOf(RunInterruptedError);
    expect(store.findRunByInput("interrupted-steer")).toMatchObject({
      status: "interrupted",
      error: "Steered input interrupted",
    });
    await expect(
      engine.admitPromptAndMaybeRun("s1", {
        id: "interrupted-steer",
        content: "stop this",
        delivery: "steer",
      }),
    ).resolves.toMatchObject({ run: { status: "interrupted" } });
  });

  it("returns an existing prompt/run for an identical request id", async () => {
    const store = createStore();
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: false } as any,
      runExecutor: {} as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });
    const first = await engine.admitPromptAndMaybeRun("s1", {
      id: "fixed",
      content: "hello",
    });
    const second = await engine.admitPromptAndMaybeRun("s1", {
      id: "fixed",
      content: "hello",
    });
    expect(second.input).toBe(first.input);
  });

  it("uses request id only to reuse an admitted plugin Input and its started Run", async () => {
    const store = createStore();
    const pending = deferred<void>();
    const runExecutor = { execute: vi.fn(async () => await pending.promise) };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });
    const items = [{
      type: "capability" as const,
      kind: "plugin" as const,
      pluginId: "dev.openharness.quality",
      displayName: "Quality",
    }];

    const first = await engine.admitPromptAndMaybeRun("s1", {
      id: "plugin-request",
      items,
      metadata: { pluginId: "dev.openharness.quality" },
      runMetadata: { pluginId: "dev.openharness.quality" },
      traceId: "trace-first",
    });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());
    const duplicate = await engine.admitPromptAndMaybeRun("s1", {
      id: "plugin-request",
      items,
      metadata: { pluginId: "dev.openharness.quality" },
      runMetadata: { pluginId: "dev.openharness.quality" },
      traceId: "trace-retry",
    });

    expect(duplicate.input).toBe(first.input);
    expect(duplicate.run).toBe(first.run);
    expect(runExecutor.execute).toHaveBeenCalledOnce();
    pending.resolve();
    await engine.waitForRuns([first.run!.id]);
  });

  it("uses the atomic store admission before enqueuing queued work", async () => {
    const store = createStore();
    const runExecutor = { execute: vi.fn(async () => {}) };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    const admitted = await engine.admitPromptAndMaybeRun("s1", {
      id: "atomic-input",
      content: "hello",
      traceId: "trace-atomic",
    });

    expect(store.admitPromptWithRun).toHaveBeenCalledWith({
      prompt: expect.objectContaining({
        id: "atomic-input",
        sessionId: "s1",
        delivery: "queue",
        content: "hello",
      }),
      run: { metadata: { traceId: "trace-atomic" } },
    });
    expect(admitted).toMatchObject({
      input: { id: "atomic-input" },
      run: { inputId: "atomic-input" },
      queue_state: "running",
    });
    await engine.waitForRuns([admitted.run!.id]);
    expect(runExecutor.execute).toHaveBeenCalledOnce();
  });

  it("queues pure attachment prompts and attachment steer without direct delivery", async () => {
    const store = createStore();
    const runDone = deferred<void>();
    const runExecutor = { execute: vi.fn(async () => await runDone.promise) };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    await expect(
      engine.admitPromptAndMaybeRun("s1", {
        id: "only-file",
        content: "",
        attachments: [{ assetId: "att-1" }],
      }),
    ).resolves.toMatchObject({
      input: { attachments: [{ assetId: "att-1" }] },
    });
    await expect(
      engine.admitPromptAndMaybeRun("s1", {
        id: "steer-file",
        delivery: "steer",
        content: "inspect",
        attachments: [{ assetId: "att-1", intent: "ocr" }],
      }),
    ).resolves.toMatchObject({
      input: { delivery: "queue" },
      queue_state: "queued",
    });
    expect(store.admitPromptWithRun).toHaveBeenLastCalledWith({
      prompt: expect.objectContaining({
        id: "steer-file",
        delivery: "queue",
        attachments: [{ assetId: "att-1", intent: "ocr" }],
      }),
      run: expect.any(Object),
    });
    runDone.resolve();
  });

  it("atomically replaces the transcript before enqueuing edited work", async () => {
    const store = createStore();
    const runExecutor = { execute: vi.fn(async () => {}) };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    const admitted = engine.replaceTranscriptAndAdmitPrompt(
      "s1",
      [{ role: "assistant", parts: [{ type: "text", text: "kept" }] }],
      { id: "edited-input", content: "replacement", traceId: "trace-edit" },
    );

    expect(store.replaceTranscriptAndAdmitPrompt).toHaveBeenCalledWith({
      transcript: {
        sessionId: "s1",
        messages: [
          { role: "assistant", parts: [{ type: "text", text: "kept" }] },
        ],
      },
      admission: {
        prompt: expect.objectContaining({
          id: "edited-input",
          sessionId: "s1",
          delivery: "queue",
          items: [{ type: "text", text: "replacement" }],
        }),
        run: { metadata: { traceId: "trace-edit" } },
      },
      createRun: true,
    });
    expect(admitted).toMatchObject({
      input: { id: "edited-input" },
      run: { inputId: "edited-input" },
      queue_state: "running",
    });
    await engine.waitForRuns([admitted.run!.id]);
  });

  it("atomically replaces the latest prompt and forwards ordered attachments", async () => {
    const store = createStore();
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: { execute: vi.fn(async () => {}) } as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    const admitted = engine.replaceLatestPrompt("s1", "source-message", {
      id: "edited-input",
      content: "replacement",
      attachments: [
        { assetId: "asset-b", intent: "ocr" },
        { assetId: "asset-a", intent: "vision" },
      ],
      traceId: "trace-edit",
    });

    expect(store.replaceLatestPromptWithAdmission).toHaveBeenCalledWith({
      sessionId: "s1",
      sourceMessageId: "source-message",
      admission: {
        prompt: expect.objectContaining({
          id: "edited-input",
          attachments: [
            { assetId: "asset-b", intent: "ocr" },
            { assetId: "asset-a", intent: "vision" },
          ],
        }),
        run: { metadata: { traceId: "trace-edit" } },
      },
      createRun: true,
    });
    expect(admitted.input.id).toBe("edited-input");
    await engine.waitForRuns([admitted.run!.id]);
  });

  it("replays the original input with a second run", async () => {
    const store = createStore();
    const sourceInput = store.admitPrompt({
      id: "source-input",
      sessionId: "s1",
      content: "inspect",
      attachments: [{ assetId: "asset-1", intent: "vision" }],
    });
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: { execute: vi.fn(async () => {}) } as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    const replayed = engine.replayInput(sourceInput.id, {
      id: "recovery-run",
      metadata: { recovery: { sourceRunId: "source-run" } },
      traceId: "trace-replay",
    });

    expect(replayed.input).toBe(sourceInput);
    expect(replayed.run?.inputId).toBe(sourceInput.id);
    expect(store.createReplayRun).toHaveBeenCalledWith(sourceInput.id, {
      id: "recovery-run",
      metadata: {
        recovery: { sourceRunId: "source-run" },
        traceId: "trace-replay",
      },
    });
    await engine.waitForRuns([replayed.run!.id]);
  });

  it("interrupts only the selected active run and preserves queued work", async () => {
    const store = createStore();
    const activeDone = deferred<void>();
    const handle = runHandle(
      activeDone.promise,
      vi.fn(),
      vi.fn(async () => activeDone.resolve()),
    );
    let execution = 0;
    const runExecutor = {
      execute: vi.fn(async (_input, context) => {
        execution += 1;
        if (execution === 1) {
          await context.registerHandle(handle);
          await handle.result;
        }
      }),
    };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    const active = await engine.admitPromptAndMaybeRun("s1", {
      content: "active",
    });
    const queued = await engine.admitPromptAndMaybeRun("s1", {
      content: "queued",
    });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());

    expect(engine.interruptRun("s1", active.run!.id)).toMatchObject({
      activeRunId: active.run!.id,
      queuedRunIds: [],
      interrupted: true,
    });
    await vi.waitFor(() =>
      expect(runExecutor.execute).toHaveBeenCalledTimes(2),
    );
    await engine.waitForRuns([active.run!.id, queued.run!.id]);
    expect(store.updateRun).not.toHaveBeenCalledWith(
      queued.run!.id,
      expect.objectContaining({ status: "interrupted" }),
    );
  });

  it("promotes a durable queued prompt into the exact active run", async () => {
    const store = createStore();
    const activeDone = deferred<void>();
    const steer = vi.fn(async (input) => {
      store.bindInputToRun(input.id!, "r1");
      return { sessionId: "s1", inputId: input.id!, runId: "r1" };
    });
    const handle = runHandle(activeDone.promise, steer);
    let execution = 0;
    const runExecutor = {
      execute: vi.fn(async (_input, context) => {
        execution += 1;
        if (execution === 1) {
          await context.registerHandle(handle);
          await handle.result;
        }
      }),
    };
    const events = { checkpoint: vi.fn(() => 1), publishSince: vi.fn() };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events,
      materializeSteerInput: async (_sessionId, items) => {
        expect(items).toEqual([{ type: "skill", name: "review", path: "/review/SKILL.md" }, { type: "text", text: " adjust direction" }]);
        return "load selected skill then adjust direction";
      },
    });
    const active = await engine.admitPromptAndMaybeRun("s1", {
      content: "active",
    });
    const queued = await engine.admitPromptAndMaybeRun("s1", {
      id: "queued-input",
      items: [{ type: "skill", name: "review", path: "/review/SKILL.md" }, { type: "text", text: " adjust direction" }],
    });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());

    await expect(
      engine.promoteQueuedRun(
        "s1",
        "queued-input",
        queued.run!.id,
        active.run!.id,
      ),
    ).resolves.toMatchObject({
      input: { id: "queued-input" },
      queued_run: {
        id: queued.run!.id,
        status: "interrupted",
        metadata: {
          promotion: {
            kind: "steered",
            activeRunId: active.run!.id,
          },
        },
      },
      active_run: { id: active.run!.id },
    });
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "queued-input",
        content: "load selected skill then adjust direction",
        delivery: "steer",
      }),
    );
    expect(runExecutor.execute).toHaveBeenCalledOnce();
    activeDone.resolve();
    await engine.waitForRuns([active.run!.id]);
  });

  it("does not promote a trusted plugin capability Input into the active run", async () => {
    const store = createStore();
    const activeDone = deferred<void>();
    const steer = vi.fn();
    const handle = runHandle(activeDone.promise, steer);
    let execution = 0;
    const runExecutor = {
      execute: vi.fn(async (_input, context) => {
        execution += 1;
        if (execution === 1) {
          await context.registerHandle(handle);
          await handle.result;
        }
      }),
    };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });
    const active = await engine.admitPromptAndMaybeRun("s1", { content: "active" });
    const queued = await engine.admitPromptAndMaybeRun("s1", {
      id: "plugin-queued-input",
      items: [{
        type: "capability",
        kind: "plugin",
        pluginId: "dev.openharness.quality",
        displayName: "Quality",
      }],
      metadata: { pluginId: "dev.openharness.quality" },
      runMetadata: { pluginId: "dev.openharness.quality" },
    });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());

    await expect(engine.promoteQueuedRun(
      "s1",
      queued.input.id,
      queued.run!.id,
      active.run!.id,
    )).rejects.toThrow("session_capability_requires_queued_run");

    expect(steer).not.toHaveBeenCalled();
    expect(store.getRun(queued.run!.id)).toMatchObject({ status: "pending" });
    activeDone.resolve();
    await engine.waitForRuns([active.run!.id, queued.run!.id]);
  });

  it("queues a durable replacement run when a late steer is rejected", async () => {
    const store = createStore();
    const pending = deferred<void>();
    const handle = runHandle(
      pending.promise,
      vi.fn(async (input) => {
        store.bindInputToRun(input.id!, "r1");
        throw new AgentRunNotAcceptingInputError("r1");
      }),
    );
    let execution = 0;
    const runExecutor = {
      execute: vi.fn(async (_input, context) => {
        execution += 1;
        if (execution === 1) {
          await context.registerHandle(handle);
          await pending.promise;
        }
      }),
    };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    await engine.admitPromptAndMaybeRun("s1", { content: "first" });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());
    const steered = engine.admitPromptAndMaybeRun("s1", {
      id: "late-input",
      content: "late",
      delivery: "steer",
    });
    await vi.waitFor(() => expect(store.createRun).toHaveBeenCalledTimes(2));
    const replacement = store.createRun.mock.results[1]?.value;
    expect(replacement).toMatchObject({
      inputId: "late-input",
      metadata: expect.objectContaining({ recoveredFromSteer: true }),
    });
    await expect(steered).resolves.toMatchObject({
      input: { id: "late-input" },
      run: { id: replacement.id },
      queue_state: "queued",
    });

    pending.resolve();
    await vi.waitFor(() =>
      expect(runExecutor.execute).toHaveBeenCalledTimes(2),
    );
  });

  it("stops admission, interrupts the active lane, and never starts queued work during shutdown", async () => {
    const store = createStore();
    const activeDone = deferred<void>();
    const handle = runHandle(
      activeDone.promise,
      vi.fn(),
      vi.fn(async () => activeDone.resolve()),
    );
    const runExecutor = {
      execute: vi.fn(async (_input, context) => {
        await context.registerHandle(handle);
        await handle.result;
      }),
    };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    await engine.admitPromptAndMaybeRun("s1", { content: "active" });
    await engine.admitPromptAndMaybeRun("s1", { content: "queued" });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());

    await engine.stopAndDrain();

    expect(runExecutor.execute).toHaveBeenCalledOnce();
    expect(handle.interrupt).toHaveBeenCalledWith("Daemon shutting down");
    await expect(
      engine.admitPromptAndMaybeRun("s1", { content: "too late" }),
    ).rejects.toThrow("stopping");
  });

  it("cancels active goal continuation runs with '用户消息优先' when admitting user prompt", async () => {
    const store = createStore();
    const activeGoal = { id: "g1", status: "active", revision: 1 };
    store.getCurrentGoal = vi.fn(() => activeGoal as any);
    store.getGoal = vi.fn(() => activeGoal as any);
    store.createRun({
      id: "gr1",
      sessionId: "s1",
      inputId: "gi1",
      status: "pending",
      metadata: { goalId: "g1", goalRunKind: "continuation" },
    });
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: { execute: vi.fn() } as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    await engine.admitPromptAndMaybeRun("s1", { content: "user message" });

    expect(store.updateRun).toHaveBeenCalledWith(
      "gr1",
      expect.objectContaining({ status: "interrupted", error: "用户消息优先" }),
    );
    expect(store.markGoalContinuation).toHaveBeenCalledWith("gr1", "cancelled");
  });

  it("interrupts goal run when goal revision has changed or goal is paused", async () => {
    const store = createStore();
    const goal = { id: "g1", status: "active", revision: 2 };
    store.getCurrentGoal = vi.fn(() => goal as any);
    store.getGoal = vi.fn(() => goal as any);
    store.startGoalRun = vi.fn(() => false);
    const runExecutor = { execute: vi.fn() };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    const admitted = await engine.admitPromptAndMaybeRun("s1", {
      content: "goal step",
      runMetadata: { goalId: "g1", goalRevision: 1, goalRunKind: "continuation" },
    });

    await vi.waitFor(() =>
      expect(store.updateRun).toHaveBeenCalledWith(
        admitted.run?.id,
        expect.objectContaining({
          status: "interrupted",
          error: "目标已暂停或版本已变化",
        }),
      ),
    );
    expect(runExecutor.execute).not.toHaveBeenCalled();
  });

  it("downgrades steer to queue when attachments are present", async () => {
    const store = createStore();
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: { execute: vi.fn() } as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    const result = await engine.admitPromptAndMaybeRun("s1", {
      delivery: "steer",
      content: "with attachment",
      attachments: [{ assetId: "asset-1" }],
    });

    expect(result.input.delivery).toBe("queue");
    expect(store.admitPromptWithRun).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.objectContaining({ delivery: "queue" }),
      }),
    );
  });

  it("returns existing input and run idempotently when prompt id was already admitted", async () => {
    const store = createStore();
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: { execute: vi.fn() } as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    const first = await engine.admitPromptAndMaybeRun("s1", {
      id: "p1",
      content: "hello",
    });
    const second = await engine.admitPromptAndMaybeRun("s1", {
      id: "p1",
      content: "hello",
    });

    expect(second.input.id).toBe(first.input.id);
    expect(second.run?.id).toBe(first.run?.id);
  });

  it("does not create duplicate failed run when terminalizing undelivered steer if owning run exists", async () => {
    const store = createStore();
    const handle = runHandle(
      deferred<void>().promise,
      vi.fn(async () => {
        throw new Error("delivery failed");
      }),
    );
    const runExecutor = {
      execute: vi.fn(async (_input, context) => {
        await context.registerHandle(handle);
        await handle.result;
      }),
    };
    const engine = new SessionRunEngine({
      store: store as any,
      goals: store as any,
      agentPool: { configured: true } as any,
      runExecutor: runExecutor as any,
      events: { checkpoint: vi.fn(() => 1), publishSince: vi.fn() },
    });

    await engine.admitPromptAndMaybeRun("s1", { content: "root" });
    await vi.waitFor(() => expect(runExecutor.execute).toHaveBeenCalledOnce());

    await expect(
      engine.admitPromptAndMaybeRun("s1", {
        id: "steer-fail",
        delivery: "steer",
        content: "steer that fails",
      }),
    ).rejects.toThrow("delivery failed");

    expect(store.findRunByInput("steer-fail")).toBeDefined();
  });
});

function createStore() {
  const inputs = new Map<string, any>();
  const runs = new Map<string, any>();
  const inputOwners = new Map<string, string>();
  let inputCount = 0;
  let runCount = 0;
  const admitPrompt = vi.fn((input) => {
    const row = {
      ...input,
      id: input.id ?? `i${++inputCount}`,
      delivery: input.delivery ?? "queue",
      attachments: input.attachments ?? [],
      createdAt: 1,
    };
    inputs.set(row.id, row);
    return row;
  });
  const createRun = vi.fn((input) => {
    const row = {
      ...input,
      id: input.id ?? `r${++runCount}`,
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
    };
    runs.set(row.id, row);
    return row;
  });
  return {
    transaction: <T>(work: () => T) => work(),
    getCurrentGoal: vi.fn(() => undefined),
    getGoal: vi.fn((_id: string) => undefined),
    updateGoal: vi.fn(),
    markGoalContinuation: vi.fn(),
    startGoalRun: vi.fn(() => true),
    listRuns: vi.fn((sessionId: string) =>
      [...runs.values()].filter((run) => run.sessionId === sessionId),
    ),
    admitPrompt,
    admitPromptWithRun: vi.fn((input) => {
      const admitted = admitPrompt({ ...input.prompt, delivery: "queue" });
      const run = createRun({
        id: input.run?.id,
        sessionId: admitted.sessionId,
        inputId: admitted.id,
        metadata: input.run?.metadata,
      });
      return { input: admitted, run };
    }),
    replaceTranscriptAndAdmitPrompt: vi.fn((input) => {
      if (input.createRun) {
        const admitted = admitPrompt({
          ...input.admission.prompt,
          delivery: "queue",
        });
        const run = createRun({
          id: input.admission.run?.id,
          sessionId: admitted.sessionId,
          inputId: admitted.id,
          metadata: input.admission.run?.metadata,
        });
        return {
          transcript: { messages: [], parts: [] },
          input: admitted,
          run,
        };
      }
      const admitted = admitPrompt(input.admission.prompt);
      return { transcript: { messages: [], parts: [] }, input: admitted };
    }),
    replaceLatestPromptWithAdmission: vi.fn((input) => {
      if (input.createRun) {
        const admitted = admitPrompt({
          ...input.admission.prompt,
          delivery: "queue",
        });
        const run = createRun({
          id: input.admission.run?.id,
          sessionId: admitted.sessionId,
          inputId: admitted.id,
          metadata: input.admission.run?.metadata,
        });
        return { transcript: { messages: [], parts: [] }, input: admitted, run };
      }
      const admitted = admitPrompt(input.admission.prompt);
      return { transcript: { messages: [], parts: [] }, input: admitted };
    }),
    createReplayRun: vi.fn((inputId, input) => {
      const source = inputs.get(inputId);
      const existing = input.id ? runs.get(input.id) : undefined;
      if (existing) return existing;
      return createRun({
        id: input.id,
        sessionId: source.sessionId,
        inputId,
        metadata: input.metadata,
      });
    }),
    getInput: vi.fn((id) => inputs.get(id)),
    createRun,
    getRun: vi.fn((id) => runs.get(id)),
    findRunByInput: vi.fn((id) => {
      const direct = [...runs.values()].find((run) => run.inputId === id);
      return direct ?? runs.get(inputOwners.get(id));
    }),
    updateRun: vi.fn((id, update) => {
      const run = Object.assign(runs.get(id), update);
      runs.set(id, run);
      return run;
    }),
    appendEvent: vi.fn(),
    bindInputToRun: (inputId: string, runId: string) =>
      inputOwners.set(inputId, runId),
  };
}

function runHandle(
  done: Promise<void>,
  steer: AgentRunHandle["steer"],
  interrupt = vi.fn(async () => {}),
): AgentRunHandle {
  return {
    id: "r1",
    inputId: "i1",
    sessionId: "s1",
    traceId: "trace-1",
    started: Promise.resolve({ sessionId: "s1", inputId: "i1", runId: "r1" }),
    result: done.then(() => ({
      status: "completed" as const,
      output: "ok",
      history: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
    steer,
    interrupt,
  };
}

function deferred<T>() {
  let resolve!: (value?: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
