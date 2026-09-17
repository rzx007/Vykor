import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  OpenHarnessHttpServer,
  type CreateDaemonAgent,
} from "@openharness/server";
import type {
  AgentEvent,
  AgentEventContext,
  AgentEventInput,
  AgentEventListener,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentRunHandle,
} from "@openharness/core";
import type {
  AgentCapabilitySnapshot,
  OpenHarnessAgent,
} from "@openharness/agent-runtime";

import { runPrintSession } from "./print-session.js";

function captureWrite(stream: NodeJS.WriteStream): {
  chunks: string[];
  spy: { mockRestore(): void };
} {
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as never);
  return { chunks, spy };
}

async function withPrintServer(
  createAgent: CreateDaemonAgent,
  run: (input: { server: OpenHarnessHttpServer; url: string; token: string }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ohs-print-integration-"));
  const token = "print-integration-token";
  const server = new OpenHarnessHttpServer({
    token,
    storePath: join(dir, "sessions.db"),
    createAgent,
    logger: () => {},
  });

  try {
    const listen = await server.listen();
    await run({ server, url: listen.url, token });
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function testAgent(
  run: (content: string, context: {
    emit(event: AgentEventInput): Promise<void>;
    requestPermission(request: AgentPermissionRequest): Promise<AgentPermissionDecision>;
  }) => Promise<void>,
): CreateDaemonAgent {
  return async ({ session, options: agentOptions }) => {
    const listeners = new Set<AgentEventListener>();
    let sequence = 0;
    const publish = async (input: AgentEventInput, context: AgentEventContext) => {
      const event = {
        ...input,
        id: `print-test-${++sequence}`,
        sequence,
        occurredAt: new Date().toISOString(),
        context,
      } as AgentEvent;
      await agentOptions.onEvent?.(event);
      for (const listener of listeners) await listener(event);
    };
    const agent: OpenHarnessAgent = {
      id: session.id,
      state: "idle",
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      children: { get: () => undefined, getBySessionId: () => undefined, list: () => [] },
      submitMessage(content, options = {}) {
        const ids = options.ids!;
        const controller = new AbortController();
        const context = { agentId: session.id, sessionId: session.id, inputId: ids.inputId, runId: ids.runId, traceId: ids.traceId };
        let output = "";
        const result = Promise.resolve().then(async () => {
          await publish({ type: "input.accepted", data: { content, delivery: options.delivery ?? "queue" } }, context);
          await publish({ type: "run.started", data: {} }, context);
          await run(typeof content === "string" ? content : "", {
            emit: async (event) => {
              if (event.type === "output.text.delta") output += event.data.delta;
              await publish(event, context);
            },
            requestPermission: async (request) => {
              const requestId = `permission-${sequence + 1}`;
              await publish({ type: "permission.requested", data: { requestId, request } }, context);
              const requestPermission = agentOptions.effects?.requestPermission;
              if (!requestPermission) throw new Error("Permission effect is not configured");
              const decision = await requestPermission(request, {
                agentId: session.id,
                sessionId: session.id,
                inputId: ids.inputId,
                runId: ids.runId,
                traceId: ids.traceId,
                cwd: session.cwd,
                signal: controller.signal,
              });
              await publish({ type: "permission.resolved", data: { requestId, decision } }, context);
              return decision;
            },
          });
          await publish({ type: "run.completed", data: { output } }, context);
          return { status: "completed" as const, output, history: [], usage: { inputTokens: 0, outputTokens: 0 } };
        });
        return {
          id: ids.runId,
          inputId: ids.inputId,
          sessionId: session.id,
          traceId: ids.traceId,
          started: Promise.resolve({ sessionId: session.id, inputId: ids.inputId, runId: ids.runId }),
          result,
          steer: async () => { throw new Error("steer is not used in print tests"); },
          interrupt: async (reason) => { controller.abort(reason); await result.catch(() => {}); },
        } satisfies AgentRunHandle;
      },
      async runMessage(content, options) { return await this.submitMessage(content, options).result; },
      getHistory: () => [],
      loadHistory: () => {},
      clear: () => {},
      setModel: () => {},
      setCompactContextProvider: () => {},
      async compact() { return { history: [], beforeMessageCount: 0, afterMessageCount: 0 }; },
      async remember() { return { skipped: true, writtenIds: [], titles: [] }; },
      getUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
      getCapabilities: disabledCapabilities,
      inspect: () => ({
        model: session.model,
        tools: [],
        hooks: [],
        mcpServers: [],
        childBudget: {
          maxDepth: 4,
          maxActiveChildren: 4,
          maxTotalChildren: 16,
          activeChildren: 0,
          totalChildren: 0,
        },
        capabilities: disabledCapabilities(),
      }),
      async close() {},
    };
    return agent;
  };
}

function disabledCapabilities(): AgentCapabilitySnapshot {
  return {
    terminal: { status: "disabled" },
    backgroundShell: { status: "disabled" },
    jobs: { status: "disabled" },
    attachments: { status: "disabled" },
    memory: { status: "disabled" },
    childEnvironment: { status: "disabled" },
    workflowRepository: { status: "disabled" },
    imageToText: { status: "disabled" },
    schedules: { status: "disabled" },
  };
}

describe("runPrintSession daemon integration", () => {
  let exitSpy: MockInstance<(code?: string | number | null) => never>;

  afterEach(() => {
    exitSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("uses the real daemon client/server path to render text and exit after completion", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const stdout = captureWrite(process.stdout);

    const createAgent = testAgent(async (content, run) => {
      expect(content).toBe("hello daemon");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await run.emit({ type: "output.text.delta", data: { delta: "hello from real daemon" } });
    });

    await withPrintServer(createAgent, async ({ server, url, token }) => {
      await runPrintSession(
        { model: "m", outputStyle: "default" } as never,
        "hello daemon",
        { model: "m", cwd: process.cwd(), daemonUrl: url, daemonToken: token },
      );

      const sessions = server.store.sessions.list({ includeArchived: true });
      expect(sessions).toHaveLength(1);
      const session = sessions[0]!;
      expect(server.store.conversations.listInputs(session.id).map((input) => input.content)).toEqual(["hello daemon"]);
      expect(server.store.runs.listRuns(session.id).map((run) => run.status)).toEqual(["completed"]);
    });

    expect(stdout.chunks.join("")).toContain("hello from real daemon");
    expect(exitSpy).not.toHaveBeenCalled();
    stdout.spy.mockRestore();
  });

  it("auto-replies to daemon permission requests in print mode", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const stdout = captureWrite(process.stdout);
    const stderr = captureWrite(process.stderr);
    const decisions: boolean[] = [];

    const createAgent = testAgent(async (_content, run) => {
      const decision = await run.requestPermission({
        toolName: "Write",
        reason: "edit requested by integration test",
        input: { path: "README.md" },
      });
      const allowed = decision.status === "approved";
      decisions.push(allowed);
      await run.emit({ type: "output.text.delta", data: { delta: allowed ? "permission approved" : "permission denied" } });
    });

    await withPrintServer(createAgent, async ({ server, url, token }) => {
      await runPrintSession(
        { model: "m", outputStyle: "default" } as never,
        "try edit",
        { model: "m", cwd: process.cwd(), daemonUrl: url, daemonToken: token },
      );

      const session = server.store.sessions.list({ includeArchived: true })[0]!;
      const requests = server.store.permissions.list({ sessionId: session.id });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ toolName: "Write", status: "denied" });
      expect(server.store.runs.listRuns(session.id).map((run) => run.status)).toEqual(["completed"]);
    });

    expect(decisions).toEqual([false]);
    expect(stdout.chunks.join("")).toContain("permission denied");
    expect(stderr.chunks.join("")).toContain("[print] auto-denied permission for Write");
    expect(exitSpy).not.toHaveBeenCalled();
    stdout.spy.mockRestore();
    stderr.spy.mockRestore();
  });
});
