import { describe, expect, it } from "vitest";
import {
  AgentExecutionLimitError, ModelRequestFailure,
  type AgentEventInput, type AgentExecutionContext, type Message,
  type StreamingMessageClient, type StreamEvent,
} from "@vykor/agent-contracts";
import { QueryEngine } from "../query-engine.js";
import { ToolRegistry } from "../tools/tool-registry.js";

const input = "Continue without losing the earlier constraints.";
const permissions = { checkTool: async () => ({ action: "allow" as const, reason: "test" }) };
const hooks = { execute: async () => ({ blocked: false }) };
const summarizerSystem = "You are a conversation summarizer.";

function history(): Message[] {
  return Array.from({ length: 60 }, (_, index) => ({
    type: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `original message ${index}: ${"x".repeat(1000)}`,
  }));
}

async function collect(engine: QueryEngine, options?: Parameters<QueryEngine["submitMessage"]>[1]) {
  const events: StreamEvent[] = [];
  for await (const event of engine.submitMessage(input, options)) events.push(event);
  return events;
}

function execution(emit: (event: AgentEventInput) => Promise<void> = async () => {}): AgentExecutionContext {
  return {
    scope: { agentId: "a", sessionId: "s", inputId: "i", runId: "r", traceId: "t", cwd: "/work", signal: new AbortController().signal },
    emit, takeSteeredInputs: async () => [], closeSteering() {},
  } as unknown as AgentExecutionContext;
}

describe("summary validation through QueryEngine", () => {
  it.each(["auto", "reactive", "manual"] as const)("preserves history and stops work after invalid %s summaries", async trigger => {
    let summaries = 0;
    let mainRequests = 0;
    let tools = 0;
    const client: StreamingMessageClient = { async *streamMessage(params) {
      if (params.system === summarizerSystem) {
        summaries++;
        yield { type: "text_delta", delta: "<analysis>Only draft reasoning.</analysis>" };
        yield { type: "complete", stopReason: "end_turn" };
        return;
      }
      mainRequests++;
      if (trigger === "reactive") throw new ModelRequestFailure("context length exceeded", {
        kind: "invalid_request", phase: "request", retryable: false, contextLengthExceeded: true,
      });
      if (mainRequests === 1) yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "write", name: "Mutate", input: {} } };
      yield { type: "complete", stopReason: mainRequests === 1 ? "tool_use" : "end_turn" };
    } };
    const registry = new ToolRegistry();
    registry.register({ name: "Mutate", description: "A side effect", inputSchema: {}, execute: async () => {
      tools++;
      return { content: [{ type: "text", text: "mutated" }] };
    } });
    const engine = new QueryEngine(client, registry, permissions, hooks, {
      maxTokens: trigger === "reactive" ? 1_048_576 : 1,
      compactKeepRecent: 4, trajectoryTrackerFactory: false,
    });
    const before = history();
    engine.loadMessages(structuredClone(before));

    await expect(trigger === "manual" ? engine.compact() : collect(engine)).rejects.toThrow(/summary/i);

    expect(summaries).toBe(2);
    expect(mainRequests).toBe(trigger === "reactive" ? 1 : 0);
    expect(tools).toBe(0);
    expect(engine.getHistory()).toEqual(trigger === "manual" ? before : [...before, { type: "user", content: input }]);
  });

  it("admits and settles both summary requests before resuming after correction", async () => {
    let summaries = 0;
    let mainRequests = 0;
    const emitted: AgentEventInput[] = [];
    const admitted: string[] = [];
    const settled: Array<{ generationId: string; status: string }> = [];
    const client: StreamingMessageClient = { async *streamMessage(params) {
      if (params.system === summarizerSystem) {
        summaries++;
        yield { type: "text_delta", delta: summaries === 1 ? "<summary> </summary>" : "<summary>Keep all prior constraints.</summary>" };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2, metering: {
          knownInputTokens: 10, knownOutputTokens: 2, completeness: "complete", inputIncludesCache: true, raw: {},
        } } };
      } else mainRequests++;
      yield { type: "complete", stopReason: "end_turn" };
    } };
    const run: AgentExecutionContext = {
      ...execution(async event => { emitted.push(event); }),
      modelAttempts: {
        beforeDispatch: async attempt => { if (attempt.purpose === "compaction") admitted.push(attempt.generationId); },
        settle: async attempt => { settled.push(attempt); },
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), permissions, hooks, {
      maxTokens: 1, compactKeepRecent: 4, trajectoryTrackerFactory: false,
    });
    engine.loadMessages(history());
    await collect(engine, { execution: run });

    expect(summaries).toBe(2);
    expect(mainRequests).toBe(1);
    expect(new Set(admitted).size).toBe(2);
    expect(settled.filter(attempt => admitted.includes(attempt.generationId)).map(attempt => attempt.status)).toEqual(["completed", "completed"]);
    const finished = emitted.filter(event => event.type === "model.attempt.finished" && admitted.includes(event.data.generationId));
    expect(finished).toHaveLength(2);
    for (const event of finished) if (event.type === "model.attempt.finished") {
      expect(event.data).toMatchObject({ status: "completed", usageStatus: "complete", usage: { inputTokens: 10, outputTokens: 2 } });
    }
    expect(engine.getHistory()).toContainEqual(expect.objectContaining({ compactRole: "summary", content: expect.stringContaining("Keep all prior constraints.") }));
  });

  it("preserves history when the Run gate rejects the correction request", async () => {
    const closed = new AgentExecutionLimitError("Run budget exhausted before correction");
    let summaries = 0;
    let mainRequests = 0;
    let admissions = 0;
    const client: StreamingMessageClient = { async *streamMessage(params) {
      if (params.system === summarizerSystem) {
        summaries++;
        yield { type: "text_delta", delta: "<summary></summary>" };
      } else mainRequests++;
      yield { type: "complete", stopReason: "end_turn" };
    } };
    const run: AgentExecutionContext = { ...execution(), modelAttempts: {
      beforeDispatch: async () => { if (++admissions === 2) throw closed; },
      settle: async () => {},
    } };
    const engine = new QueryEngine(client, new ToolRegistry(), permissions, hooks, {
      maxTokens: 1, compactKeepRecent: 4, trajectoryTrackerFactory: false,
    });
    const before = history(); engine.loadMessages(structuredClone(before));

    await expect(collect(engine, { execution: run })).rejects.toBe(closed);
    expect(summaries).toBe(1);
    expect(mainRequests).toBe(0);
    expect(engine.getHistory()).toEqual([...before, { type: "user", content: input }]);
  });

  it("does not dispatch correction after cancellation on the retry progress event", async () => {
    const controller = new AbortController();
    const cancelled = new Error("User cancelled before summary correction");
    let summaries = 0;
    let mainRequests = 0;
    const run = execution(async event => {
      if (event.type === "domain.event" && event.data.name === "context_compaction"
        && event.data.payload.phase === "compact_retry") controller.abort(cancelled);
    });
    const client: StreamingMessageClient = { async *streamMessage(params) {
      if (params.system === summarizerSystem) {
        summaries++;
        yield { type: "text_delta", delta: "<analysis>No usable summary.</analysis>" };
      } else mainRequests++;
      yield { type: "complete", stopReason: "end_turn" };
    } };
    const engine = new QueryEngine(client, new ToolRegistry(), permissions, hooks, {
      maxTokens: 1, compactKeepRecent: 4, trajectoryTrackerFactory: false,
    });
    const before = history(); engine.loadMessages(structuredClone(before));

    await expect(collect(engine, { execution: run, signal: controller.signal })).rejects.toBe(cancelled);
    expect(summaries).toBe(1);
    expect(mainRequests).toBe(0);
    expect(engine.getHistory()).toEqual([...before, { type: "user", content: input }]);
  });

  it("does not resume the main request when reporting validation failure also fails", async () => {
    const reportingFailure = new Error("Failed to save compact progress");
    let mainRequests = 0;
    const run = execution(async event => {
      if (event.type === "domain.event" && event.data.name === "context_compaction"
        && event.data.payload.phase === "compact_failed") throw reportingFailure;
    });
    const client: StreamingMessageClient = { async *streamMessage(params) {
      if (params.system === summarizerSystem) yield { type: "text_delta", delta: "<analysis>No usable summary.</analysis>" };
      else mainRequests++;
      yield { type: "complete", stopReason: "end_turn" };
    } };
    const engine = new QueryEngine(client, new ToolRegistry(), permissions, hooks, {
      maxTokens: 1, compactKeepRecent: 4, trajectoryTrackerFactory: false,
    });
    const before = history(); engine.loadMessages(structuredClone(before));
    await expect(collect(engine, { execution: run })).rejects.toMatchObject({ name: "CompactSummaryValidationError", cause: reportingFailure });
    expect(mainRequests).toBe(0);
    expect(engine.getHistory()).toEqual([...before, { type: "user", content: input }]);
  });
});
