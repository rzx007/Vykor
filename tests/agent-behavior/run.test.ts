import { describe, expect, it } from "vitest";
import type { StreamingMessageClient } from "@vykor/core";
import { behaviorSystemPrompt, runBehaviorCase } from "./run.js";
import type { BehaviorCase } from "./cases.js";

const done: StreamingMessageClient = {
  async *streamMessage() {
    yield { type: "text_delta" as const, delta: "done" };
    yield { type: "complete" as const, stopReason: "end_turn" };
  },
};

function scenario(verify: ReturnType<BehaviorCase["setup"]>["verify"]): BehaviorCase {
  return { id: "isolation", domain: "files", prompt: "Finish", setup: () => ({ tools: [], verify }) };
}

const options = { client: done, model: "scripted", revision: "baseline", repeat: 1, maxRequests: 2, timeoutMs: 10_000 };

describe("behavior runner", () => {
  it("creates fresh state for each repeat", async () => {
    let setups = 0;
    const item: BehaviorCase = { id: "fresh", domain: "files", prompt: "Finish", setup: () => {
      const state = { calls: 0 };
      setups++;
      return { tools: [{ name: "Touch", description: "touch", inputSchema: {}, execute: async () => {
        state.calls++;
        return { content: [{ type: "text", text: "ok" }] };
      } }], verify: () => ({ passed: state.calls === 0, reason: "fresh" }) };
    } };
    const first = await runBehaviorCase(item, options);
    const second = await runBehaviorCase(item, { ...options, repeat: 2 });
    expect([first.status, second.status]).toEqual(["passed", "passed"]);
    expect(setups).toBe(2);
  });

  it("returns a failed result when verification rejects the observed behavior", async () => {
    const result = await runBehaviorCase(scenario(() => ({ passed: false, reason: "missing evidence" })), options);
    expect(result).toMatchObject({ status: "failed", reason: "missing evidence" });
  });

  it("does not issue a request after the sample budget is exhausted", async () => {
    let calls = 0;
    const client: StreamingMessageClient = { async *streamMessage() {
      calls++;
      yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `x-${calls}`, name: "Again", input: {} } };
      yield { type: "complete" as const, stopReason: "tool_use" };
    } };
    const item: BehaviorCase = { id: "budget", domain: "files", prompt: "Again", setup: () => ({
      tools: [{ name: "Again", description: "repeat", inputSchema: {}, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }],
      verify: () => ({ passed: false, reason: "unfinished" }),
    }) };
    const sharedBudget = { remainingRequests: 1 };
    const result = await runBehaviorCase(item, { ...options, client, maxRequests: 1, sharedBudget });
    const next = await runBehaviorCase(item, { ...options, client, repeat: 2, sharedBudget });
    expect(result.status).toBe("budget_cancelled");
    expect(next.status).toBe("not_run");
    expect(calls).toBe(1);
  });

  it("separates a deadline from an external cancellation", async () => {
    const waiting: StreamingMessageClient = { async *streamMessage(params) {
      await new Promise<void>((_, reject) => params.abortSignal?.addEventListener("abort", () => reject(params.abortSignal?.reason), { once: true }));
      yield { type: "complete" as const, stopReason: "end_turn" };
    } };
    const item = scenario(() => ({ passed: true, reason: "unreachable" }));
    const timeout = await runBehaviorCase(item, { ...options, client: waiting, timeoutMs: 20 });
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    const cancelled = await runBehaviorCase(item, { ...options, client: done, signal: controller.signal });
    expect(timeout.status).toBe("timed_out");
    expect(cancelled.status).toBe("cancelled");
  });

  it("sends only the fixed prompt and scenario tools", async () => {
    const sent: Array<{ system?: string; tools: string[] }> = [];
    const client: StreamingMessageClient = { async *streamMessage(params) {
      sent.push({ system: params.system, tools: params.tools?.map((tool) => tool.name) ?? [] });
      yield { type: "complete" as const, stopReason: "end_turn" };
    } };
    const item: BehaviorCase = { id: "visibility", domain: "files", prompt: "Inspect", setup: () => ({
      tools: [{ name: "Visible", description: "visible", inputSchema: {}, execute: async () => ({ content: [] }) }],
      verify: () => ({ passed: true, reason: "visible" }),
    }) };
    await runBehaviorCase(item, { ...options, client });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.system).toContain(behaviorSystemPrompt);
    expect(sent[0]?.tools).toEqual(["Visible"]);
  });
});
