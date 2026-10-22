import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@vykor/agent-contracts";
import { ToolAppOriginProjector } from "../tool-app-origin-projector.js";

function fixture() {
  const projector = new ToolAppOriginProjector();
  const binding = { definition: { name: "Save" } };
  const origin = {
    pluginId: "p",
    toolName: "Save",
    backendKind: "native-tools",
  };
  const resolve = vi.fn(async () => origin);
  const snapshot = {
    scope: { runId: "r", sessionId: "s" },
    capabilityView: { tools: new Map([["Save", binding]]) },
    resolveToolAppOrigin: resolve,
  };
  const release = projector.capture(snapshot as any);
  const event = (type: string, data: any, sessionId = "s") =>
    ({ type, data, context: { runId: "r", sessionId } }) as AgentEvent;
  const start = event("tool.started", {
    toolUse: { id: "call", name: "Save" },
  }) as Extract<AgentEvent, { type: "tool.started" }>;
  const completed = event("tool.completed", {
    toolUseId: "call",
    result: { content: [], executionState: "completed" },
    pluginAppOrigin: { pluginId: "forged" },
  }) as Extract<AgentEvent, { type: "tool.completed" }>;
  return { projector, binding, origin, resolve, release, start, completed };
}
it("derives origin from the captured binding and reuses the same fact on projection retry", async () => {
  const f = fixture();
  f.projector.started(f.start);
  expect(await f.projector.completed(f.completed)).toBe(f.origin);
  expect(await f.projector.completed(f.completed)).toBe(f.origin);
  expect(f.resolve).toHaveBeenCalledExactlyOnceWith(f.binding);
});
it("rejects unstarted, foreign-session and failed tool events including forged origins", async () => {
  const f = fixture();
  expect(await f.projector.completed(f.completed)).toBeUndefined();
  f.projector.started({
    ...f.start,
    context: { ...f.start.context, sessionId: "foreign" },
  });
  expect(await f.projector.completed(f.completed)).toBeUndefined();
  f.projector.started(f.start);
  expect(
    await f.projector.completed({
      ...f.completed,
      data: {
        ...f.completed.data,
        result: { content: [], isError: true, executionState: "completed" },
      },
    }),
  ).toBeUndefined();
  expect(f.resolve).not.toHaveBeenCalled();
});
it("drops the captured catalog after release and does not accept a stale completion", async () => {
  const f = fixture();
  f.projector.started(f.start);
  f.release();
  f.release();
  expect(await f.projector.completed(f.completed)).toBeUndefined();
  expect(f.resolve).not.toHaveBeenCalled();
});
it("rejects an origin for a different tool", async () => {
  const f = fixture();
  f.resolve.mockResolvedValueOnce({ ...f.origin, toolName: "Other" });
  f.projector.started(f.start);
  expect(await f.projector.completed(f.completed)).toBeUndefined();
});
