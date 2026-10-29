import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSubscriptionClient, OpenAICompatibleClient } from "@vykor/api";
import { QueryEngine, ToolRegistry } from "@vykor/core/engine";
import { SessionStore } from "@vykor/services";
import type { AgentExecutionContext, Message, StreamEvent, StreamingMessageClient } from "@vykor/agent-contracts";
import { GoalModelAttemptService } from "../../../packages/server/src/application/goals/goal-model-attempt-service.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup.splice(0).reverse().forEach(close => close());
});

function history(): Message[] {
  return Array.from({ length: 60 }, (_, i) => ({
    type: i % 2 ? "assistant" : "user", content: `message ${i}: ${"x".repeat(1000)}`,
  }));
}

function engine(client: StreamingMessageClient, contextWindow = 100_000) {
  return new QueryEngine(client, new ToolRegistry(),
    { checkTool: async () => ({ action: "allow", reason: "test" }) },
    { execute: async () => ({ blocked: false }) } as any, {
      compactKeepRecent: 4, trajectoryTrackerFactory: false, modelRetry: { maxTotalRetries: 0 },
      resolveRequestConfiguration: async () => ({ revision: 1, model: "test", client, contextWindow, maxOutputTokens: 4096 }),
    });
}

function sse(frames: unknown[]) {
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function codexClient() {
  const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" },
  })).toString("base64url")}.sig`;
  return new CodexSubscriptionClient({ apiKey: token });
}

async function collect(query: QueryEngine, execution?: AgentExecutionContext) {
  const events: StreamEvent[] = [];
  for await (const event of query.submitMessage("Continue safely", { execution })) events.push(event);
  return events;
}

function success(text: string) {
  return sse([
    { type: "response.output_text.delta", delta: text },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 } } },
  ]);
}

describe("context compaction through real provider adapters", () => {
  it.each(["response.failed", "error"])("recovers a Codex %s context rejection", async type => {
    const bodies: Array<{ instructions?: string; input: unknown[] }> = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1) {
        const error = { code: "context_length_exceeded", message: "Input rejected" };
        return sse([type === "response.failed" ? { type, response: { error } } : { type, error }]);
      }
      return success(body.instructions === "You are a conversation summarizer." ? "Task progress summarized" : "Task continued");
    });
    const query = engine(codexClient());
    query.loadMessages(history());
    const events = await collect(query);
    expect(bodies).toHaveLength(3);
    expect(bodies[1]!.instructions).toBe("You are a conversation summarizer.");
    expect(bodies[2]!.input.length).toBeLessThan(bodies[0]!.input.length);
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "Task continued" }));
    expect(events.filter(event => event.type === "model_attempt_finished").map(event => event.status)).toEqual(["failed", "completed"]);
  });

  it.each([
    { message: "Tool schema exceeds configured limit", code: "invalid_function_parameters" },
    { message: "Invalid schema for function 'context_length_exceeded': additionalProperties is required to be false.", code: "invalid_function_parameters" },
    { message: "Invalid schema for function 'inspect': In context=('properties', 'input too long'), additionalProperties is required to be false.", code: "invalid_function_parameters" },
  ])("preserves history on an OpenAI tool-schema rejection: $message", async ({ message, code }) => {
    let calls = 0;
    const client = new OpenAICompatibleClient({ apiKey: "offline-test" });
    client.client = new OpenAI({ apiKey: "offline-test", maxRetries: 0, fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      if (body.messages[0]?.content === "You are a conversation summarizer.") {
        return sse([{ choices: [{ delta: { content: "Unnecessary summary" }, finish_reason: "stop" }] }]);
      }
      return new Response(JSON.stringify({ error: { message, code, type: "invalid_request_error" } }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    } });
    const query = engine(client);
    const original = history();
    query.loadMessages(original);
    await expect(collect(query)).rejects.toMatchObject({ info: { kind: "invalid_request" } });
    expect(calls).toBe(1);
    expect(query.getHistory()).toEqual([...original, { type: "user", content: "Continue safely" }]);
  });

  it("uses the model output cap for the actual OpenAI summary request", async () => {
    const requests: Array<{ max_tokens?: number; max_completion_tokens?: number }> = [];
    const client = new OpenAICompatibleClient({ apiKey: "offline-test" });
    client.client = new OpenAI({ apiKey: "offline-test", maxRetries: 0, fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return sse([{ choices: [{ delta: { content: "Task progress retained" }, finish_reason: "stop" }] }]);
    } });
    const query = engine(client, 48_000);
    query.loadMessages(history());
    await collect(query);
    expect(requests).toHaveLength(2);
    expect(requests.map(request => request.max_tokens ?? request.max_completion_tokens)).toEqual([4096, 4096]);
    expect(query.getHistory()).toContainEqual(expect.objectContaining({ compactRole: "summary", content: expect.stringContaining("Task progress retained") }));
  });

  it("recovers a code-less overflow inside the real OpenAI SDK's HTTP error wrapper", async () => {
    let calls = 0;
    const client = new OpenAICompatibleClient({ apiKey: "offline-test" });
    client.client = new OpenAI({ apiKey: "offline-test", maxRetries: 0, fetch: async () => {
      if (++calls === 1) return new Response(JSON.stringify({ error: {
        type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum",
      } }), { status: 400, headers: { "content-type": "application/json" } });
      return sse([{ choices: [{ delta: { content: "Task continued" }, finish_reason: "stop" }] }]);
    } });
    const query = engine(client);
    query.loadMessages(history());
    const events = await collect(query);
    expect(calls).toBe(3);
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "Task continued" }));
    expect(query.getHistory()).toContainEqual(expect.objectContaining({ compactRole: "summary" }));
  });

  it.each([undefined, 100_000])("respects real goal accounting with tokenBudget=%s during recovery", async tokenBudget => {
    const directory = mkdtempSync(join(tmpdir(), "context-goal-regression-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    store.sessions.create({ id: "session", cwd: directory, model: "test" });
    const goal = store.goals.createGoal({ sessionId: "session", objective: "finish", maxAutoTurns: 2, tokenBudget });
    store.runs.createRun({ id: "run", sessionId: "session", metadata: { goalId: goal.id, goalObjectiveVersion: 1 } });
    store.runs.updateRun("run", { status: "running" });
    const gate = new GoalModelAttemptService({ store, events: { checkpoint: () => 0, publishSince() {} } });
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      calls++;
      if (calls === 1) return sse([{ type: "response.failed", response: { error: { code: "context_length_exceeded", message: "Input rejected" } } }]);
      const body = JSON.parse(String(init?.body));
      return success(body.instructions === "You are a conversation summarizer." ? "Task summarized" : "Task continued");
    });
    const query = engine(codexClient());
    query.loadMessages(history());
    const execution = {
      scope: { agentId: "session", sessionId: "session", runId: "run", inputId: "input", traceId: "trace", cwd: directory, signal: new AbortController().signal },
      modelAttempts: gate, emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {},
    } as unknown as AgentExecutionContext;
    if (tokenBudget === undefined) {
      await collect(query, execution);
      expect(calls).toBe(3);
      expect(store.goals.getGoal(goal.id)).toMatchObject({ status: "active", usage: { knownTokens: 26, unknownAttempts: 1, inFlightAttempts: 0 } });
    } else {
      await expect(collect(query, execution)).rejects.toThrow("用量不完整");
      expect(calls).toBe(1);
      expect(store.goals.getGoal(goal.id)).toMatchObject({ status: "paused", stopReason: { code: "usage_unknown" }, usage: { knownTokens: 0, unknownAttempts: 1, inFlightAttempts: 0 } });
    }
  });
});
