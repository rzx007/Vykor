import { describe, expect, it } from "vitest";
import type { StreamEvent, ToolExecutionResult } from "@vykor/agent-contracts";
import { QueryEngine } from "../../query-engine.js";
import { ToolRegistry } from "../tool-registry.js";

describe("tool batch recovery ordering", () => {
  // Calling observe before the correction limit, or before delivering the whole
  // batch, would expose an extra trajectory side effect at the terminal boundary.
  it.each([
    { kind: "invalid_input", limit: 8, error: "ToolInputCorrectionsExceeded" },
    { kind: "precondition", limit: 5, error: "ToolPreconditionsExceeded" },
  ] as const)("settles the terminal $kind batch without observing it", async ({ kind, limit, error }) => {
    const registry = new ToolRegistry();
    registry.register({
      name: "Write", description: "controlled refusal", inputSchema: { type: "object" },
      execute: async () => ({ content: [], isError: true, failureKind: kind, executionState: "not_started" }),
    });
    registry.register({
      name: "Read", description: "successful sibling", inputSchema: { type: "object" },
      execute: async () => ({ content: [], executionState: "completed" }),
    });
    let requests = 0;
    const order: string[] = [];
    const engine = new QueryEngine({
      async *streamMessage(): AsyncIterable<StreamEvent> {
        const attempt = ++requests;
        for (const name of ["Write", "Read"]) yield {
          type: "tool_use_start", toolUse: {
            type: "tool_use", id: `${name}-${attempt}`, name, input: { attempt },
          },
        };
        yield { type: "complete", stopReason: "tool_use" };
      },
    }, registry, { checkTool: async () => ({ action: "allow" }) },
    { register() {}, execute: async () => ({ blocked: false }) }, {
      maxTurns: 20,
      trajectoryTrackerFactory: () => ({ observe(event, control) {
        expect(engine.getHistory().filter(message => message.type === "tool_result")).toHaveLength(requests * 2);
        expect(event.calls.map(call => call.toolUse.name)).toEqual(["Write", "Read"]);
        order.push(`observe-${requests}`);
        // If the terminal batch is incorrectly observed, it must still not get
        // a model finalization request instead of the correction error.
        if (requests === limit) control.forceFinal = true;
      } }),
    });
    let failure: unknown;
    try {
      for await (const event of engine.submitMessage("correct the failed call")) {
        if (event.type !== "tool_use_end") continue;
        expect(engine.getHistory().filter(message => message.type === "tool_result")).toHaveLength(requests * 2);
        order.push(event.toolUseId);
      }
    } catch (caught) { failure = caught; }
    expect(failure).toMatchObject({ name: error });
    expect(requests).toBe(limit);
    expect(order).toEqual(Array.from({ length: limit }, (_, index) => [
      `Write-${index + 1}`, `Read-${index + 1}`,
      ...(index + 1 < limit ? [`observe-${index + 1}`] : []),
    ]).flat());
    expect(engine.getHistory().filter(message => message.type === "tool_result")).toHaveLength(limit * 2);
  });

  // Checking the recovery allowance before observe would omit the fourth
  // observation; letting forceFinal win would add a fifth model request.
  it("observes the exhausted recovery batch after delivery even when it requests finalization", async () => {
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
      name: "Build", description: "unchanged failing operation", inputSchema: { type: "object" },
      execute: async () => {
        executions++;
        return { content: [], isError: true, executionState: "completed" };
      },
    });
    let requests = 0;
    const order: string[] = [];
    const results: ToolExecutionResult[] = [];
    const engine = new QueryEngine({
      async *streamMessage(): AsyncIterable<StreamEvent> {
        requests++;
        yield { type: "tool_use_start", toolUse: {
          type: "tool_use", id: `build-${requests}`, name: "Build", input: {},
        } };
        yield { type: "complete", stopReason: "tool_use" };
      },
    }, registry, { checkTool: async () => ({ action: "allow" }) },
    { register() {}, execute: async () => ({ blocked: false }) }, {
      maxTurns: 20,
      trajectoryTrackerFactory: () => ({ observe(_event, control) {
        order.push(`observe-${requests}`);
        if (requests === 4) control.forceFinal = true;
      } }),
    });
    let failure: unknown;
    try {
      for await (const event of engine.submitMessage("build")) {
        if (event.type !== "tool_use_end") continue;
        results.push(event.result);
        order.push(event.toolUseId);
      }
    } catch (caught) { failure = caught; }
    expect(failure).toMatchObject({ name: "ToolRecoveryExceeded" });
    expect(requests).toBe(4);
    expect(executions).toBe(1);
    expect(results.slice(1).every(result => Boolean(result.metadata?.recoveryGuard))).toBe(true);
    expect(order).toEqual([
      "build-1", "observe-1", "build-2", "observe-2",
      "build-3", "observe-3", "build-4", "observe-4",
    ]);
    expect(engine.getHistory().filter(message => message.type === "tool_result")).toHaveLength(4);
  });
});
