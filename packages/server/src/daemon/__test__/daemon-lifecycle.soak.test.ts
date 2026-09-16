import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { OpenHarnessAgent } from "@openharness/agent-runtime";
import type {
  AgentEvent,
  AgentEventContext,
  AgentEventInput,
  AgentRunHandle,
  AgentRunResult,
  Message,
} from "@openharness/core";

import type { CreateDaemonAgent } from "../daemon-agent.js";
import { OpenHarnessHttpServer } from "../../http/server.js";

const fetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("x-openharness-protocol-version", "4");
  return globalThis.fetch(input, { ...init, headers });
};

interface SoakMetrics {
  generations: Map<string, number>;
  restoredHistoryLengths: Map<string, number[]>;
  closedAgents: number;
}

interface SessionState {
  inputs: Array<{ id: string }>;
  runs: Array<{ id: string; status: string }>;
  messages: Array<{ id: string; role: string }>;
  parts: Array<{ type: string; status: string; text?: string }>;
}

function createSoakAgent(metrics: SoakMetrics): CreateDaemonAgent {
  return async (context) => {
    const generation = (metrics.generations.get(context.session.id) ?? 0) + 1;
    metrics.generations.set(context.session.id, generation);
    let history: Message[] = [];
    let sequence = 0;
    let state: OpenHarnessAgent["state"] = "idle";
    let closePromise: Promise<void> | undefined;

    const emit = async (input: AgentEventInput, eventContext: AgentEventContext): Promise<void> => {
      const event = {
        ...input,
        id: `${context.session.id}-g${generation}-event-${++sequence}`,
        sequence,
        occurredAt: new Date().toISOString(),
        context: eventContext,
      } as AgentEvent;
      await context.options.onEvent?.(event);
    };

    const agent: OpenHarnessAgent = {
      id: context.session.id,
      get state() { return state; },
      children: { get: () => undefined, getBySessionId: () => undefined, list: () => [] },
      subscribe: () => () => {},
      submitMessage(content, options = {}): AgentRunHandle {
        if (state !== "idle") throw new Error(`Agent is ${state}`);
        if (typeof content !== "string") throw new Error("Soak agent only accepts text prompts");
        state = "running";
        const ids = options.ids ?? {
          inputId: `${context.session.id}-input-${sequence + 1}`,
          runId: `${context.session.id}-run-${sequence + 1}`,
          traceId: `${context.session.id}-trace-${sequence + 1}`,
        };
        const eventContext: AgentEventContext = {
          agentId: context.session.id,
          sessionId: context.session.id,
          inputId: ids.inputId,
          runId: ids.runId,
          traceId: ids.traceId,
        };
        const output = `reply:${content}`;
        const splitAt = Math.max(1, Math.floor(output.length / 2));
        let resolveStarted!: (receipt: { sessionId: string; inputId: string; runId: string }) => void;
        let rejectStarted!: (error: unknown) => void;
        let didStart = false;
        const started = new Promise<{ sessionId: string; inputId: string; runId: string }>((resolve, reject) => {
          resolveStarted = resolve;
          rejectStarted = reject;
        });
        const result = Promise.resolve().then(async (): Promise<AgentRunResult> => {
          try {
            await emit({
              type: "input.accepted",
              data: {
                content,
                delivery: options.delivery ?? "queue",
                ...(options.metadata ? { metadata: options.metadata } : {}),
              },
            }, eventContext);
            await emit({ type: "run.started", data: {} }, eventContext);
            didStart = true;
            resolveStarted({ sessionId: context.session.id, inputId: ids.inputId, runId: ids.runId });
            await emit({ type: "output.text.delta", data: { delta: output.slice(0, splitAt) } }, eventContext);
            await emit({ type: "output.text.delta", data: { delta: output.slice(splitAt) } }, eventContext);
            await emit({ type: "output.turn.completed", data: { stopReason: "end_turn" } }, eventContext);
            await emit({ type: "run.completed", data: { output, stopReason: "end_turn" } }, eventContext);
            history = [
              ...history,
              { type: "user", content },
              { type: "assistant", content: output },
            ];
            return {
              status: "completed",
              output,
              history: [...history],
              usage: { inputTokens: content.length, outputTokens: output.length },
            };
          } catch (error) {
            if (!didStart) rejectStarted(error);
            throw error;
          } finally {
            if (state === "running") state = "idle";
          }
        });
        return {
          id: ids.runId,
          inputId: ids.inputId,
          sessionId: context.session.id,
          traceId: ids.traceId,
          started,
          result,
          steer: async () => { throw new Error("Steer is not used by the lifecycle soak test"); },
          interrupt: async () => { await result.catch(() => {}); },
        };
      },
      async runMessage(content, options) { return await this.submitMessage(content, options).result; },
      getHistory: () => [...history],
      loadHistory: (messages) => {
        history = [...messages];
        const lengths = metrics.restoredHistoryLengths.get(context.session.id) ?? [];
        lengths.push(messages.length);
        metrics.restoredHistoryLengths.set(context.session.id, lengths);
      },
      clear: () => { history = []; },
      setModel: () => {},
      setCompactContextProvider: () => {},
      compact: async () => ({
        history: [...history],
        beforeMessageCount: history.length,
        afterMessageCount: history.length,
      }),
      remember: async () => ({ skipped: true, writtenIds: [], titles: [] }),
      getUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
      inspect: () => ({ model: context.session.model, tools: [], hooks: [], mcpServers: [] }),
      close: () => {
        if (closePromise) return closePromise;
        state = "closing";
        closePromise = Promise.resolve().then(() => {
          metrics.closedAgents += 1;
          state = "closed";
        });
        return closePromise;
      },
    };
    return agent;
  };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readState(baseUrl: string, sessionId: string): Promise<SessionState> {
  const response = await fetch(`${baseUrl}/sessions/${sessionId}/state`);
  expect(response.status).toBe(200);
  return await response.json() as SessionState;
}

async function waitForCompletedRuns(baseUrl: string, sessionId: string, expected: number): Promise<SessionState> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await readState(baseUrl, sessionId);
    if (state.runs.length === expected && state.runs.every((run) => run.status === "completed")) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} completed runs in ${sessionId}`);
}

function expectExactTranscript(state: SessionState, expectedPrompts: string[]): void {
  const expectedReplies = expectedPrompts.map((prompt) => `reply:${prompt}`);
  expect(state.inputs).toHaveLength(expectedPrompts.length);
  expect(state.runs).toHaveLength(expectedPrompts.length);
  expect(state.runs.every((run) => run.status === "completed")).toBe(true);
  expect(state.messages.filter((message) => message.role === "user")).toHaveLength(expectedPrompts.length);
  expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(expectedPrompts.length);
  expect(state.parts.filter((part) => part.type === "text" && part.status === "completed").map((part) => part.text))
    .toEqual(expectedPrompts.flatMap((prompt, index) => [prompt, expectedReplies[index]!]));
}

describe("daemon lifecycle soak", () => {
  it("keeps multi-session transcripts exact across queued runs and two daemon restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-daemon-lifecycle-soak-"));
    const storePath = join(dir, "sessions.db");
    const sessionIds = Array.from({ length: 4 }, (_, index) => `soak-session-${index + 1}`);
    const prompts = new Map(sessionIds.map((sessionId) => [sessionId, [] as string[]]));
    const metrics: SoakMetrics = {
      generations: new Map(),
      restoredHistoryLengths: new Map(),
      closedAgents: 0,
    };
    const roundsByGeneration = [6, 4, 2];
    let server: OpenHarnessHttpServer | undefined;

    try {
      for (let generation = 0; generation < roundsByGeneration.length; generation += 1) {
        server = new OpenHarnessHttpServer({
          storePath,
          createAgent: createSoakAgent(metrics),
          logger: () => {},
        });
        const listen = await server.listen();

        if (generation === 0) {
          await Promise.all(sessionIds.map(async (sessionId) => {
            const response = await postJson(`${listen.url}/sessions`, {
              id: sessionId,
              cwd: process.cwd(),
              model: "soak-model",
            });
            expect(response.status).toBe(201);
          }));
        }

        for (let round = 0; round < roundsByGeneration[generation]!; round += 1) {
          await Promise.all(sessionIds.map(async (sessionId) => {
            const prompt = `g${generation + 1}-r${round + 1}-${sessionId}`;
            prompts.get(sessionId)!.push(prompt);
            const response = await postJson(`${listen.url}/sessions/${sessionId}/prompts`, {
              id: `input-${prompt}`,
              content: prompt,
            });
            expect(response.status).toBe(202);
          }));
        }

        await Promise.all(sessionIds.map(async (sessionId) => {
          const state = await waitForCompletedRuns(listen.url, sessionId, prompts.get(sessionId)!.length);
          expectExactTranscript(state, prompts.get(sessionId)!);
        }));

        await server.close();
        server = undefined;
      }

      for (const sessionId of sessionIds) {
        expect(metrics.generations.get(sessionId)).toBe(3);
        const restored = metrics.restoredHistoryLengths.get(sessionId);
        expect(restored).toHaveLength(3);
        expect(restored![0]).toBe(0);
        expect(restored![1]).toBe(12);
        expect(restored![2]).toBe(20);
      }
      expect(metrics.closedAgents).toBe(sessionIds.length * roundsByGeneration.length);
    } finally {
      await server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
