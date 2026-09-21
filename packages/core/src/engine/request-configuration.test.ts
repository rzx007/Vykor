import { describe, expect, it, vi } from "vitest";

import type { StreamMessageParams, StreamingMessageClient } from "../types/client.js";
import type { IHookExecutor } from "../index.js";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";

describe("QueryEngine request configuration", () => {
  it("reads configuration at the next automatic request after checking for follow-ups", async () => {
    const models: string[] = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        models.push(params.model);
        if (models.length === 1) {
          yield {
            type: "tool_use_start" as const,
            toolUse: { type: "tool_use", id: "echo", name: "Echo", input: {} },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
        } else {
          yield { type: "complete" as const, stopReason: "end_turn" };
        }
      },
    };
    const tools = new ToolRegistry();
    tools.register({
      name: "Echo", description: "Echoes", inputSchema: {},
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    });
    let model = "model-a";
    const engine = new QueryEngine(client, tools,
      { checkTool: async () => ({ action: "allow", reason: "test" }) } as never,
      { execute: async () => ({ blocked: false }) } as IHookExecutor,
      { maxTurns: 2, resolveRequestConfiguration: async () => ({
        revision: 0, model, client, maxTurns: 2,
      }) },
    );
    for await (const _ of engine.submitMessage("start", {
      execution: {
        emit: async () => {}, closeSteering: () => {},
        takeSteeredInputs: async () => { model = "model-b"; return []; },
      } as never,
    })) { /* consume */ }
    expect(models).toEqual(["model-a", "model-b"]);
  });

  it("accepts a steered follow-up when the turn limit rises during a tool-free response", async () => {
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let requestCount = 0;
    const models: string[] = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        requestCount++;
        models.push(params.model);
        if (requestCount === 1) { started(); await held; }
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    let maxTurns = 1;
    let model = "model-a";
    let pending = true;
    const engine = new QueryEngine(client, new ToolRegistry(),
      { checkTool: async () => ({ action: "allow", reason: "test" }) } as never,
      { execute: async () => ({ blocked: false }) } as IHookExecutor,
      { maxTurns: 1, resolveRequestConfiguration: async () => ({
        revision: 0, model, client, maxTurns,
      }) },
    );
    const running = (async () => {
      for await (const _ of engine.submitMessage("first", {
        execution: {
          emit: async () => {}, closeSteering: () => {},
          takeSteeredInputs: async () => {
            if (!pending) return [];
            pending = false;
            model = "model-b";
            maxTurns = 1;
            return [{ id: "follow-up", content: "continue" }];
          },
        } as never,
      })) { /* consume */ }
    })();
    await firstStarted;
    maxTurns = 2;
    release();
    await running;
    expect(requestCount).toBe(2);
    expect(models).toEqual(["model-a", "model-b"]);
  });

  it("uses an increased turn limit after tools and finishes an accepted follow-up", async () => {
    const requests: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        requests.push(params.model);
        if (requests.length === 1) {
          started();
          await held;
          yield {
            type: "tool_use_start" as const,
            toolUse: { type: "tool_use", id: "echo", name: "Echo", input: {} },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    let maxTurns = 1;
    const tools = new ToolRegistry();
    tools.register({
      name: "Echo", description: "Echo", inputSchema: {},
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    });
    const engine = new QueryEngine(client, tools,
      { checkTool: async () => ({ action: "allow", reason: "test" }) } as never,
      { execute: async () => ({ blocked: false }) } as IHookExecutor,
      { maxTurns: 1, resolveRequestConfiguration: async () => ({
        revision: 0, model: "model-a", client, maxTurns,
      }) },
    );
    const running = (async () => {
      let pending = true;
      for await (const _ of engine.submitMessage("run", {
        execution: {
          emit: async () => {}, closeSteering: () => {},
          takeSteeredInputs: async () => {
            if (!pending) return [];
            pending = false;
            maxTurns = 1;
            return [{ id: "follow-up", content: "continue" }];
          },
        } as never,
      })) { /* consume */ }
    })();
    await firstStarted;
    maxTurns = 2;
    release();
    await running;
    expect(requests).toEqual(["model-a", "model-a"]);
  });

  it("prepares a steered follow-up with the client selected for its request", async () => {
    const prepared: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const firstClient: StreamingMessageClient = {
      prepareUserContent: async (content) => { prepared.push(`a:${String(content)}`); return content; },
      async *streamMessage() {
        started();
        await held;
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const secondClient: StreamingMessageClient = {
      prepareUserContent: async (content) => { prepared.push(`b:${String(content)}`); return content; },
      async *streamMessage() { yield { type: "complete" as const, stopReason: "end_turn" }; },
    };
    let selected = { revision: 0, model: "a", client: firstClient };
    let pending = true;
    const engine = new QueryEngine(
      firstClient, new ToolRegistry(),
      { checkTool: async () => ({ action: "allow", reason: "test" }) } as never,
      { execute: async () => ({ blocked: false }) } as IHookExecutor,
      { resolveRequestConfiguration: async () => selected },
    );
    const run = (async () => {
      for await (const _ of engine.submitMessage("initial", {
        execution: {
          emit: async () => {},
          closeSteering: () => {},
          takeSteeredInputs: async () => {
            if (!pending) return [];
            pending = false;
            return [{ id: "followup", content: "later" }];
          },
        } as never,
      })) { /* consume */ }
    })();
    await firstStarted;
    selected = { revision: 1, model: "b", client: secondClient };
    release();
    await run;
    expect(prepared).toEqual(["a:initial", "b:later"]);
  });

  it("uses a changed configuration for the request after a completed tool call", async () => {
    const initialRequests: StreamMessageParams[] = [];
    const updatedRequests: StreamMessageParams[] = [];
    let releaseFirstRequest!: () => void;
    let signalFirstRequest!: () => void;
    const firstRequestHeld = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const firstRequestStarted = new Promise<void>((resolve) => {
      signalFirstRequest = resolve;
    });
    const toolExecutions = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "echoed" }],
    }));
    const initialClient: StreamingMessageClient = {
      async *streamMessage(params) {
        initialRequests.push(params);
        if (initialRequests.length > 1) {
          throw new Error("the old client received a later request");
        }
        signalFirstRequest();
        await firstRequestHeld;
        yield {
          type: "tool_use_start" as const,
          toolUse: { type: "tool_use", id: "echo-1", name: "Echo", input: {} },
        };
        yield { type: "complete" as const, stopReason: "tool_use" };
      },
    };
    const updatedClient: StreamingMessageClient = {
      async *streamMessage(params) {
        updatedRequests.push(params);
        yield { type: "text_delta" as const, delta: "done" };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    let selected = {
      revision: 0,
      model: "model-a",
      reasoningEffort: "low",
      client: initialClient,
    };
    const tools = new ToolRegistry();
    tools.register({
      name: "Echo",
      description: "Returns its input.",
      inputSchema: {},
      execute: toolExecutions,
    });
    const engine = new QueryEngine(
      initialClient,
      tools,
      { checkTool: async () => ({ action: "allow", reason: "test" }) } as never,
      { execute: async () => ({ blocked: false }) } as IHookExecutor,
      {
        resolveRequestConfiguration: async () => selected,
      },
    );

    const run = (async () => {
      for await (const _event of engine.submitMessage("use Echo")) {
        // Consume the real stream so the engine can execute the tool and continue.
      }
    })();
    await firstRequestStarted;
    selected = {
      revision: 1,
      model: "model-b",
      reasoningEffort: "high",
      client: updatedClient,
    };
    releaseFirstRequest();
    await run;

    expect(initialRequests).toHaveLength(1);
    expect(initialRequests[0]).toMatchObject({
      model: "model-a",
      reasoningEffort: "low",
    });
    expect(toolExecutions).toHaveBeenCalledTimes(1);
    expect(updatedRequests).toHaveLength(1);
    expect(updatedRequests[0]).toMatchObject({
      model: "model-b",
      reasoningEffort: "high",
    });
    expect(updatedRequests[0]!.messages.some((message) => message.type === "tool_result"))
      .toBe(true);
  });
});
