import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamingMessageClient } from "@vykor/core";
import { behaviorSystemPrompt, runBehaviorCase, reserveBehaviorReport } from "./run.js";
import { behaviorCases, type BehaviorCase } from "./cases.js";

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
  it("gives default runs separate report files", () => {
    const first = reserveBehaviorReport();
    const second = reserveBehaviorReport();
    try {
      first.save({ results: ["earlier"] });
      second.save({ results: ["later"] });
      expect(first.path).not.toBe(second.path);
      expect(JSON.parse(readFileSync(first.path, "utf8"))).toEqual({ results: ["earlier"] });
    } finally {
      rmSync(first.path);
      rmSync(second.path);
    }
  });

  it("reserves distinct reports and preserves earlier and explicitly named artifacts", () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-report-test-"));
    try {
      const requested = join(directory, "baseline.json");
      writeFileSync(requested, "original");
      const first = reserveBehaviorReport(requested);
      first.save({ results: [1] });
      const second = reserveBehaviorReport(requested);
      second.save({ results: [2] });
      first.save({ results: [1, 3] });
      expect(first.path).not.toBe(second.path);
      expect(readFileSync(requested, "utf8")).toBe("original");
      expect(JSON.parse(readFileSync(first.path, "utf8"))).toEqual({ results: [1, 3] });
      expect(JSON.parse(readFileSync(second.path, "utf8"))).toEqual({ results: [2] });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["success", "verifier throws", "cancelled", "timed_out", "budget_cancelled"])("persists review evidence on %s", async (outcome) => {
    const original = behaviorCases.find((entry) => entry.id === "R2")!;
    const controller = new AbortController();
    const source = original.scripted!();
    let request = 0;
    const client: StreamingMessageClient = { async *streamMessage(params) {
      request++;
      if ((outcome === "cancelled" || outcome === "timed_out") && request === 3) {
        yield { type: "text_delta", delta: "Partial answer: sources disagree." };
        if (outcome === "cancelled") controller.abort(new Error("cancelled after evidence"));
        if (params.abortSignal?.aborted) throw params.abortSignal.reason;
        await new Promise<void>((_, reject) => params.abortSignal?.addEventListener("abort", () => reject(params.abortSignal?.reason), { once: true }));
        return;
      }
      yield { type: "reasoning_delta", delta: "PRIVATE_REASONING", source: "think" };
      yield* source.streamMessage(params);
    } };
    const item: BehaviorCase = { ...original, setup: () => {
      const sample = original.setup();
      return { ...sample, verify: outcome === "verifier throws" ? () => { throw new Error("verifier failed"); } : sample.verify };
    } };
    const result = await runBehaviorCase(item, { ...options, client, signal: controller.signal,
      maxRequests: outcome === "budget_cancelled" ? 2 : 5, timeoutMs: outcome === "timed_out" ? 100 : 10_000 });
    expect(result.evidence).toBeDefined();
    const directory = mkdtempSync(join(tmpdir(), "vykor-evidence-test-"));
    try {
      const report = reserveBehaviorReport(join(directory, "evidence.json"));
      report.save(result);
      const saved = JSON.parse(readFileSync(report.path, "utf8"));
      expect(saved.status).toBe(outcome === "success" ? "pending_review" : outcome === "verifier throws" ? "failed" : outcome);
      expect(saved.evidence.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool.started", name: "ReadSourceA", input: {} }),
        expect.objectContaining({ type: "tool.completed", content: [{ type: "text", text: "Source A: yes" }] }),
        expect.objectContaining({ type: "tool.completed", content: [{ type: "text", text: "Source B: no" }] }),
      ]));
      if (outcome === "success" || outcome === "verifier throws") expect(saved.evidence.finalText).toContain("Sources disagree");
      if (outcome === "cancelled" || outcome === "timed_out") expect(saved.evidence.outputText).toContain("Partial answer");
      expect(JSON.stringify(saved)).not.toContain("PRIVATE_REASONING");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

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
