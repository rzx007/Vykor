import { AgentEventBus } from "../../event-source.js";
import { expect, it } from "vitest";
import { applyChildActivityEvent, type ChildActivityState } from "../child-activity.js";

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
