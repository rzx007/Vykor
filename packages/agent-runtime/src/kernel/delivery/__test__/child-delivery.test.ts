import { describe, expect, it } from "vitest";
import type { AgentChildController, AgentChildInvocation, AgentChildResult, AgentEvent, ToolDefinition } from "@vykor/agent-contracts";
import { createAgentKernel, createBasicAgentKernelRuntime } from "../../index.js";

const delivery = { status: "done", summary: "Child report ready", data: { path: "child.md" } };
const receipt = { ...delivery, validation: "schema_valid", verification: "passed" };

async function fixture(onRelease?: (result: AgentChildResult) => void) {
  let invocation: AgentChildInvocation | undefined;
  let controller: AgentChildController | undefined;
  let rootRequests = 0;
  const events: AgentEvent[] = [];
  const delegate: ToolDefinition = {
    name: "Delegate", description: "Run the report child", inputSchema: { type: "object" },
    async execute(_input, context) {
      controller = context.agent!.children;
      invocation = await controller.spawnChildAgent({
        description: "Create a report", prompt: "Deliver the child report", agent: "reporter",
        cwd: "/work", allowedTools: [],
      });
      const result = await invocation.result;
      return { content: [{ type: "text", text: result.output }], isError: result.status !== "completed" };
    },
  };
  const effects = { requestPermission: async () => ({ status: "approved" as const }) };
  const root = await createAgentKernel({
    cwd: "/work", effects, childIdleTtlMs: 0,
    childEnvironment: { acquire: async () => ({ cwd: "/work", release: async result => { onRelease?.(result); } }) },
    onEvent: event => { events.push(event); },
    engine: createBasicAgentKernelRuntime({
      tools: [delegate], trajectoryTrackerFactory: false, maxTurns: 3,
      client: { async *streamMessage() {
        if (rootRequests++ === 0) {
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "delegate", name: "Delegate", input: {} } };
          yield { type: "complete", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", delta: "Root finished" };
          yield { type: "complete", stopReason: "end_turn" };
        }
      } },
    }),
    preparation: { prepare: async () => ({
      run: { tools: new Map([[delegate.name, { definition: delegate, invoke: delegate.execute }]]) }, release() {},
    }) },
    resolveChild: ({ spawn, sessionId }) => ({
      spawn,
      createAgent: () => createAgentKernel({
        id: sessionId, cwd: "/work", effects,
        outputContract: {
          schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
          verify: candidate => ({ ok: (candidate.data as { path: string }).path === "child.md" }),
        },
        engine: createBasicAgentKernelRuntime({
          tools: [], trajectoryTrackerFactory: false, maxTurns: 2,
          client: { async *streamMessage() {
            yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "submit", name: "SubmitResult", input: delivery } };
            yield { type: "complete", stopReason: "tool_use" };
          } },
        }),
        preparation: { prepare: async () => ({ run: { tools: new Map() }, release() {} }) },
      }),
    }),
  });
  return { root, events, invocation: () => invocation!, controller: () => controller! };
}

describe("structured delivery through an actual Kernel child", () => {
  it("returns the child's own verified contract without requiring a root contract", async () => {
    const f = await fixture();
    try {
      const rootResult = await f.root.runMessage("Delegate the report");
      expect(rootResult).toMatchObject({ output: "Root finished" });
      expect(rootResult.delivery).toBeUndefined();
      expect(await f.invocation().result).toEqual({ status: "completed", output: "Child report ready", delivery: receipt });
    } finally { await f.root.close(); }
  });

  it("isolates receipts returned through invocation, controller, and handle reads", async () => {
    const f = await fixture();
    try {
      await f.root.runMessage("Delegate the report");
      const invocation = f.invocation();
      const fromInvocation = await invocation.result;
      (fromInvocation.delivery!.data as { path: string }).path = "changed-by-invocation.md";
      const fromController = await f.controller().awaitChildAgent(invocation.id);
      expect(fromController.delivery).toEqual(receipt);
      fromController.delivery!.verification = "not_requested";
      const handle = f.root.children.get(invocation.id)!;
      const fromHandle = await handle.result;
      expect(fromHandle.delivery).toEqual(receipt);
      (fromHandle.delivery!.data as { path: string }).path = "changed-by-handle.md";
      expect((await handle.result).delivery).toEqual(receipt);
    } finally { await f.root.close(); }
  });

  it("keeps child.closed observers from changing the retained receipt", async () => {
    const f = await fixture();
    f.root.subscribe(event => {
      if (event.type !== "child.closed" || !event.data.result.delivery) return;
      (event.data.result.delivery.data as { path: string }).path = "changed-by-observer.md";
    });
    try {
      await f.root.runMessage("Delegate the report");
      const handle = f.root.children.get(f.invocation().id)!;
      await handle.close();
      expect(f.events.some(event => event.type === "child.closed")).toBe(true);
      expect((await handle.result).delivery).toEqual(receipt);
    } finally { await f.root.close(); }
  });

  it("keeps environment release from changing the retained receipt", async () => {
    let released = false;
    const f = await fixture(result => {
      released = true;
      if (result.delivery) (result.delivery.data as { path: string }).path = "changed-by-release.md";
    });
    try {
      await f.root.runMessage("Delegate the report");
      const handle = f.root.children.get(f.invocation().id)!;
      await handle.close();
      expect(released).toBe(true);
      expect((await handle.result).delivery).toEqual(receipt);
    } finally { await f.root.close(); }
  });
});
