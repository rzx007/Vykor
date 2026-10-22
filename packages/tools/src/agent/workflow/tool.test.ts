import { describe, it, expect, vi } from "vitest";
import type { AgentRunScope, ToolContext } from "@vykor/agent-contracts";
import { createWorkflowTool } from "./tool.js";

describe("Workflow tool port", () => {
  const scope: AgentRunScope = {
    agentId: "a",
    sessionId: "s",
    runId: "r",
    inputId: "i",
    traceId: "t",
    cwd: "/work",
    signal: new AbortController().signal,
  };
  const context = {
    cwd: "/work",
    agent: { scope },
    abortSignal: new AbortController().signal,
  } as ToolContext;
  it("forwards one action with the real scope and request signal, preserving the result", async () => {
    const result = {
      content: [{ type: "text" as const, text: "host result" }],
    };
    const invoke = vi.fn(async () => result);
    const tool = createWorkflowTool({ invoke });
    const input = { action: "history" };
    expect(await tool.execute(input, context)).toBe(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith({
      input,
      scope,
      signal: context.abortSignal,
      children: undefined,
      definitions: undefined,
    });
    expect(invoke.mock.calls[0]?.[0]?.scope).toBe(scope);
  });
  it("rejects an unknown action before invoking the host", async () => {
    const invoke = vi.fn();
    const result = await createWorkflowTool({ invoke }).execute(
      { action: "cancel" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("forwards only the execution-captured role catalog", async () => {
    const definition = { name: "selected", description: "Selected role" };
    const invoke = vi.fn(async () => ({ content: [] }));
    const view = { agents: new Map([["selected", { definition }]]) };
    await createWorkflowTool({ invoke }, [definition]).execute({ action: "history", definitions: [{ name: "forged" }] }, { ...context, capabilityView: view } as ToolContext);
    expect(invoke.mock.calls[0]?.[0]?.definitions).toEqual([definition]);
  });
  it("reports missing execution scope without creating a host", async () => {
    const invoke = vi.fn();
    expect(
      (await createWorkflowTool({ invoke }).execute({}, { cwd: "/work" }))
        .isError,
    ).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});
