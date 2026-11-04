import { AgentEventBus } from "../../event-source.js";
import { expect, it } from "vitest";
import { applyChildActivityEvent, type ChildActivityState } from "../child-activity.js";

it("distinguishes model connection activity from generated progress", async () => {
  const record: { id: string; sessionId: string; activityRunId: string; activity?: ChildActivityState } = {
    id: "child", sessionId: "session", activityRunId: "run",
  };
  const bus = new AgentEventBus();
  bus.subscribe(event => applyChildActivityEvent(record, event));
  const context = { agentId: "agent", sessionId: "session", childId: "child", runId: "run" };
  await bus.emit({ type: "model.attempt.started", data: { generationId: "g", attempt: 1, model: "m", purpose: "generation" } }, context);
  expect(record.activity!.snapshot.model).toMatchObject({ generationId: "g", attempt: 1 });
  expect(record.activity!.snapshot.model!.lastStreamAt).toBeUndefined();
  expect(record.activity!.snapshot.model!.lastProgressAt).toBeUndefined();
  await bus.emit({ type: "domain.event", data: { name: "model.stream.activity", payload: { generationId: "g", attempt: 1 } } }, context);
  expect(record.activity!.snapshot.model!.lastStreamAt).toEqual(expect.any(Number));
  expect(record.activity!.snapshot.model!.lastProgressAt).toBeUndefined();
  await bus.emit({ type: "output.text.delta", data: { delta: "hello" } }, context);
  expect(record.activity!.snapshot.model!.lastProgressAt).toEqual(expect.any(Number));
  await bus.emit({ type: "model.attempt.finished", data: { generationId: "g", attempt: 1, status: "completed", usageStatus: "unknown" } }, context);
  expect(record.activity!.snapshot.model).toBeUndefined();
  await bus.emit({ type: "model.attempt.started", data: { generationId: "compact", attempt: 1, model: "m", purpose: "compaction" } }, context);
  expect(record.activity!.snapshot.model).toBeUndefined();
  await bus.emit({ type: "model.attempt.started", data: { generationId: "final", attempt: 1, model: "m", purpose: "finalization" } }, context);
  expect(record.activity!.snapshot.model).toMatchObject({ generationId: "final", attempt: 1 });
});

it("does not count empty or repeated tool arguments as new model progress", async () => {
  const record: { id: string; sessionId: string; activityRunId: string; activity?: ChildActivityState } = { id: "child", sessionId: "session", activityRunId: "run" };
  const bus = new AgentEventBus();
  bus.subscribe(event => applyChildActivityEvent(record, event));
  const context = { agentId: "agent", sessionId: "session", childId: "child", runId: "run" };
  await bus.emit({ type: "model.attempt.started", data: { generationId: "g", attempt: 1, model: "m", purpose: "generation" } }, context);
  const progress = async (receivedChars: number) => bus.emit({ type: "domain.event", data: { name: "tool.generation.progress", payload: { generationId: "g", attempt: 1, toolKey: "t", receivedChars } } }, context);
  await progress(0);
  expect(record.activity!.snapshot.model!.lastProgressAt).toBeUndefined();
  await progress(5);
  const observed = record.activity!.snapshot.model!.lastProgressAt;
  expect(observed).toEqual(expect.any(Number));
  await new Promise(resolve => setTimeout(resolve, 5));
  await progress(5);
  expect(record.activity!.snapshot.model!.lastProgressAt).toBe(observed);
});

it.each([false, true])("releases completed tool tracking while preserving its activity summary (error=%s)", async (isError) => {
  const record: { id: string; sessionId: string; activityRunId: string; activity?: ChildActivityState } = {
    id: "child", sessionId: "session", activityRunId: "run",
  };
  const bus = new AgentEventBus();
  bus.subscribe(event => applyChildActivityEvent(record, event));
  const context = { agentId: "agent", sessionId: "session", childId: "child", runId: "run" };

  await bus.emit({ type: "tool.started", data: {
    toolUse: { type: "tool_use", id: "pending", name: "Bash", input: {} },
  } }, context);
  for (let i = 0; i < 100; i++) {
    const id = `tool-${i}`;
    await bus.emit({ type: "tool.started", data: {
      toolUse: { type: "tool_use", id, name: "Read", input: {} },
    } }, context);
    await bus.emit({ type: "tool.completed", data: {
      toolUseId: id, result: { content: [{ type: "text", text: "done" }], isError },
    } }, context);
  }

  expect([...record.activity!.toolNames.entries()]).toEqual([["pending", "Bash"]]);
  expect(record.activity!.snapshot.latestTool).toMatchObject({
    name: "Read", status: isError ? "failed" : "completed",
  });
  expect(record.activity!.snapshot.toolCalls).toBe(101);
});
