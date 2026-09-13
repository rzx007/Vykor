import { describe, it, expect, vi } from "vitest";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import type { AgentExecutionContext, StreamEvent } from "../index.js";

/**
 * Mock streaming client that records every `streamMessage` request so tests can
 * assert what `system` text was actually sent to the API per turn.
 */
function createRecordingClient(events: StreamEvent[]): {
  client: any;
  requests: Array<{ system?: string; messages: any[] }>;
} {
  const requests: Array<{ system?: string; messages: any[] }> = [];
  const client = {
    streamMessage: async function* (req: any) {
      requests.push({ system: req.system, messages: req.messages });
      for (const event of events) yield event;
    },
  };
  return { client, requests };
}

function createMockPermissionChecker(): any {
  return { checkTool: async () => ({ action: "allow", reason: "mock" }) };
}

function createMockHookExecutor(): any {
  return { execute: async () => ({ blocked: false }) };
}

const SIMPLE_RESPONSE: StreamEvent[] = [
  { type: "text_delta", delta: "ok" },
  { type: "complete", stopReason: "end_turn" },
];

describe("QueryEngine per-turn memory retriever", () => {
  it("reports the latest Run prompt and keeps the callback ahead of the session default", async () => {
    const { client, requests } = createRecordingClient(SIMPLE_RESPONSE);
    const engine = new QueryEngine(client, new ToolRegistry(), createMockPermissionChecker(), createMockHookExecutor(), {
      systemPrompt: "SESSION",
      systemPromptForRun: async (view) => view.pluginId ? "PLUGIN SUMMARY" : "BASELINE SUMMARY",
      memoryRetriever: async () => "MEMORY",
    });
    engine.setSystemPrompt("UPDATED SESSION");
    expect(engine.getContextUsagePromptSource().systemPrompt).toBe("UPDATED SESSION");
    for (const pluginId of [undefined, "one", undefined]) {
      const execution = {
        capabilityView: { pluginId, tools: new Map(), skills: new Map(), agents: new Map(), mcpServers: new Map() },
        emit: async () => {}, takeSteeredInputs: async () => [], closeSteering: () => {},
      } as unknown as AgentExecutionContext;
      for await (const _ of engine.submitMessage("go", { execution })) {}
      expect(engine.getContextUsagePromptSource()).toEqual({
        systemPrompt: pluginId ? "PLUGIN SUMMARY" : "BASELINE SUMMARY",
        memoryReminderText: "<system-reminder>\nMEMORY\n</system-reminder>",
      });
    }
    expect(requests.map((request) => request.system)).toEqual([
      "BASELINE SUMMARY\n\n<system-reminder>\nMEMORY\n</system-reminder>",
      "PLUGIN SUMMARY\n\n<system-reminder>\nMEMORY\n</system-reminder>",
      "BASELINE SUMMARY\n\n<system-reminder>\nMEMORY\n</system-reminder>",
    ]);
    for await (const _ of engine.submitMessage("no view")) {}
    expect(engine.getContextUsagePromptSource().systemPrompt).toBe("UPDATED SESSION");
    engine.clear();
    expect(engine.getContextUsagePromptSource()).toEqual({ systemPrompt: "UPDATED SESSION" });
  });

  it("calls retriever with the current user input on each submitMessage", async () => {
    const { client } = createRecordingClient(SIMPLE_RESPONSE);
    const retriever = vi.fn(async () => null);

    const engine = new QueryEngine(
      client,
      new ToolRegistry(),
      createMockPermissionChecker(),
      createMockHookExecutor(),
      { systemPrompt: "BASE", memoryRetriever: retriever },
    );

    for await (const _ of engine.submitMessage("first input")) { /* drain */ }
    for await (const _ of engine.submitMessage("second input")) { /* drain */ }

    expect(retriever).toHaveBeenCalledTimes(2);
    expect(retriever).toHaveBeenNthCalledWith(1, "first input");
    expect(retriever).toHaveBeenNthCalledWith(2, "second input");
  });

  it("injects retrieved memory into the system prompt sent to the API", async () => {
    const { client, requests } = createRecordingClient(SIMPLE_RESPONSE);
    const retriever = vi.fn(async () => "<memory>\n- user prefers pnpm\n</memory>");

    const engine = new QueryEngine(
      client,
      new ToolRegistry(),
      createMockPermissionChecker(),
      createMockHookExecutor(),
      { systemPrompt: "BASE PROMPT", memoryRetriever: retriever },
    );

    for await (const _ of engine.submitMessage("how do I install?")) { /* drain */ }

    expect(requests).toHaveLength(1);
    const system = requests[0]!.system ?? "";
    // Base prompt is preserved.
    expect(system).toContain("BASE PROMPT");
    // Retrieved memory is appended transiently as a system-reminder.
    expect(system).toContain("user prefers pnpm");
    expect(system).toContain("<system-reminder>");
  });

  it("exposes the exact runtime prompt source used by the latest turn", async () => {
    const { client, requests } = createRecordingClient(SIMPLE_RESPONSE);
    const engine = new QueryEngine(
      client,
      new ToolRegistry(),
      createMockPermissionChecker(),
      createMockHookExecutor(),
      {
        systemPrompt: "SESSION RUNTIME PROMPT",
        memoryRetriever: async () => "TURN MEMORY",
      },
    );

    for await (const _ of engine.submitMessage("remember this")) { /* drain */ }

    const source = engine.getContextUsagePromptSource();
    expect(source.systemPrompt).toBe("SESSION RUNTIME PROMPT");
    expect(source.memoryReminderText).toBe(
      "<system-reminder>\nTURN MEMORY\n</system-reminder>",
    );
    expect(requests[0]!.system).toBe(
      `${source.systemPrompt}\n\n${source.memoryReminderText}`,
    );
  });

  it("does NOT write injected memory into the persistent message history", async () => {
    const { client } = createRecordingClient(SIMPLE_RESPONSE);
    const retriever = vi.fn(async () => "TRANSIENT_MEMORY_MARKER");

    const engine = new QueryEngine(
      client,
      new ToolRegistry(),
      createMockPermissionChecker(),
      createMockHookExecutor(),
      { systemPrompt: "BASE", memoryRetriever: retriever },
    );

    for await (const _ of engine.submitMessage("hi")) { /* drain */ }

    const history = engine.getHistory();
    // Only user + assistant, no transient memory leaked into history.
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ type: "user", content: "hi" });
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain("TRANSIENT_MEMORY_MARKER");
  });

  it("does not mutate the persistent systemPrompt across turns", async () => {
    // Turn 1 retrieves memory, turn 2 retrieves none — turn 2 must fall back to
    // the bare base prompt (proves injection was transient, not persisted).
    let callCount = 0;
    const retriever = vi.fn(async () => {
      callCount += 1;
      return callCount === 1 ? "FIRST_TURN_MEMORY" : null;
    });

    const { client, requests } = createRecordingClient(SIMPLE_RESPONSE);
    const engine = new QueryEngine(
      client,
      new ToolRegistry(),
      createMockPermissionChecker(),
      createMockHookExecutor(),
      { systemPrompt: "BASE", memoryRetriever: retriever },
    );

    for await (const _ of engine.submitMessage("turn 1")) { /* drain */ }
    for await (const _ of engine.submitMessage("turn 2")) { /* drain */ }

    expect(requests[0]!.system).toContain("FIRST_TURN_MEMORY");
    expect(requests[1]!.system).not.toContain("FIRST_TURN_MEMORY");
    expect(requests[1]!.system).toBe("BASE");
  });

  it("keeps the injected memory for every agentic iteration within one turn", async () => {
    const tool = {
      name: "Echo",
      description: "echo",
      inputSchema: {},
      execute: async () => ({ content: [{ type: "text" as const, text: "done" }] }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);

    const requests: Array<{ system?: string }> = [];
    let call = 0;
    const client = {
      streamMessage: async function* (req: any) {
        requests.push({ system: req.system });
        call += 1;
        if (call === 1) {
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "tu1", name: "Echo", input: {} } } as StreamEvent;
          yield { type: "complete", stopReason: "tool_use" } as StreamEvent;
        } else {
          yield { type: "text_delta", delta: "final" } as StreamEvent;
          yield { type: "complete", stopReason: "end_turn" } as StreamEvent;
        }
      },
    };

    const retriever = vi.fn(async () => "TURN_MEMORY");
    const engine = new QueryEngine(
      client,
      registry,
      createMockPermissionChecker(),
      createMockHookExecutor(),
      { systemPrompt: "BASE", memoryRetriever: retriever },
    );

    for await (const _ of engine.submitMessage("use echo")) { /* drain */ }

    // Retriever runs once per user turn, not once per API iteration.
    expect(retriever).toHaveBeenCalledTimes(1);
    // Both the initial call and the post-tool continuation carry the memory.
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      expect(r.system).toContain("TURN_MEMORY");
    }
  });

  it("behaves identically when no retriever is set (system prompt unchanged)", async () => {
    const { client, requests } = createRecordingClient(SIMPLE_RESPONSE);
    const engine = new QueryEngine(
      client,
      new ToolRegistry(),
      createMockPermissionChecker(),
      createMockHookExecutor(),
      { systemPrompt: "BASE" },
    );

    for await (const _ of engine.submitMessage("hi")) { /* drain */ }

    expect(requests).toHaveLength(1);
    expect(requests[0]!.system).toBe("BASE");
    expect(requests[0]!.system).not.toContain("system-reminder");
  });

  it("setMemoryRetriever can enable and disable injection at runtime", async () => {
    const { client, requests } = createRecordingClient(SIMPLE_RESPONSE);
    const engine = new QueryEngine(
      client,
      new ToolRegistry(),
      createMockPermissionChecker(),
      createMockHookExecutor(),
      { systemPrompt: "BASE" },
    );

    // No retriever -> bare system.
    for await (const _ of engine.submitMessage("a")) { /* drain */ }

    engine.setMemoryRetriever(async () => "LATE_MEMORY");
    for await (const _ of engine.submitMessage("b")) { /* drain */ }

    engine.setMemoryRetriever(undefined);
    for await (const _ of engine.submitMessage("c")) { /* drain */ }

    expect(requests[0]!.system).toBe("BASE");
    expect(requests[1]!.system).toContain("LATE_MEMORY");
    expect(requests[2]!.system).toBe("BASE");
  });
});
