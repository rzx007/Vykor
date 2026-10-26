import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentOutputContract, ToolDefinition } from "@vykor/agent-contracts";
import { createAgentKernel, createBasicAgentKernelRuntime } from "../../index.js";

const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false };
const valid = { status: "done", summary: "Report ready", data: { path: "report.md" } };

async function fixture(batches: Array<Array<{ name: string; input: Record<string, unknown> }>>, contract?: AgentOutputContract) {
  let requests = 0, effects = 0;
  const events: AgentEvent[] = [];
  const write: ToolDefinition = { name: "Write", description: "test effect", inputSchema: { type: "object" }, execute: async () => { effects++; return { content: [{ type: "text", text: "saved" }] }; } };
  const engine = createBasicAgentKernelRuntime({ tools: [write], trajectoryTrackerFactory: false, maxTurns: 5, client: {
    async *streamMessage() {
      const batch = batches[requests++];
      if (batch) {
        for (const [index, call] of batch.entries()) yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `call-${requests}-${index}`, ...call } };
        yield { type: "complete" as const, stopReason: "tool_use" };
      } else { yield { type: "text_delta" as const, delta: "Plain answer" }; yield { type: "complete" as const, stopReason: "end_turn" }; }
    },
  } });
  const agent = await createAgentKernel({ cwd: "/work", engine, effects: { requestPermission: async () => ({ status: "approved" }) },
    outputContract: contract, onEvent: event => { events.push(event); },
    preparation: { prepare: async () => ({ run: { tools: new Map([[write.name, { definition: write, invoke: write.execute }]]) }, release() {} }) },
  });
  return { agent, events, requests: () => requests, effects: () => effects };
}

describe("structured delivery through actual Kernel and QueryEngine", () => {
  it("accepts independent business keys that also happen to be tool argument aliases", async () => {
    const data = { path: "source.txt", file_path: "destination.txt" };
    const f = await fixture([[{ name: "SubmitResult", input: { ...valid, data } }]], {
      schema: { ...schema, additionalProperties: true },
    });
    try {
      const result = await f.agent.runMessage("deliver independent business fields");
      expect(result.delivery?.data).toEqual(data);
      expect(f.requests()).toBe(1);
    } finally { await f.agent.close(); }
  });
  it("repairs an invalid structure and ends only after the valid submission", async () => {
    const f = await fixture([[{ name: "SubmitResult", input: { ...valid, data: {} } }], [{ name: "SubmitResult", input: valid }]], { schema });
    try {
      const result = await f.agent.runMessage("create report");
      expect(result.delivery).toMatchObject({ ...valid, validation: "schema_valid", verification: "not_requested" });
      expect(f.requests()).toBe(2);
      expect(f.events.find(event => event.type === "run.completed")?.data).toHaveProperty("delivery");
      expect(f.agent.state).toBe("idle");
    } finally { await f.agent.close(); }
  });
  it("does not verify alongside a sibling write and verifies after its result", async () => {
    let verifiedEffects = -1;
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture([[{ name: "Write", input: {} }, { name: "SubmitResult", input: valid }], [{ name: "SubmitResult", input: valid }]],
      { schema, verify: () => { verifiedEffects = f.effects(); return { ok: verifiedEffects === 1 }; } });
    try {
      const result = await f.agent.runMessage("write and deliver");
      expect(f.effects()).toBe(1);
      expect(verifiedEffects).toBe(1);
      expect(f.requests()).toBe(2);
      expect(result.delivery?.verification).toBe("passed");
    } finally { await f.agent.close(); }
  });
  it("keeps completion observers from changing the verified Run result", async () => {
    const f = await fixture([[{ name: "SubmitResult", input: valid }]], {
      schema,
      verify: delivery => ({ ok: (delivery.data as { path: string }).path === "report.md" }),
    });
    f.agent.subscribe(event => {
      if (event.type !== "run.completed" || !event.data.delivery) return;
      event.data.delivery.summary = "Changed by observer";
      event.data.delivery.verification = "not_requested";
      (event.data.delivery.data as { path: unknown }).path = 42;
    });
    try {
      const result = await f.agent.runMessage("deliver report");
      expect(result.delivery).toEqual({ ...valid, validation: "schema_valid", verification: "passed" });
    } finally { await f.agent.close(); }
  });
  it("keeps the completed event intact when the caller changes its receipt", async () => {
    const f = await fixture([[{ name: "SubmitResult", input: valid }]], { schema });
    try {
      const result = await f.agent.runMessage("deliver report");
      result.delivery!.summary = "Changed by caller";
      (result.delivery!.data as { path: string }).path = "other.md";
      const completed = f.events.find(event => event.type === "run.completed");
      expect(completed?.data).toHaveProperty("delivery", {
        ...valid, validation: "schema_valid", verification: "not_requested",
      });
    } finally { await f.agent.close(); }
  });
  it("fails clearly if a contracted Run ends without a valid delivery", async () => {
    const f = await fixture([], { schema });
    try { await expect(f.agent.runMessage("deliver")).rejects.toThrow(/structured delivery/i); }
    finally { await f.agent.close(); }
  });
  it("keeps ordinary text-only Runs unchanged", async () => {
    const f = await fixture([]);
    try { const result = await f.agent.runMessage("chat"); expect(result.output).toBe("Plain answer"); expect(result.delivery).toBeUndefined(); }
    finally { await f.agent.close(); }
  });
});
