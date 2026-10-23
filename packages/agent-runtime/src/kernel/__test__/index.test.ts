import { describe, it, expect, vi } from "vitest";
import {
  readonlyMap,
  type AgentRunPreparation,
  type ToolDefinition,
  type AgentEvent,
} from "@vykor/agent-contracts";
import { createAgentKernel, createBasicAgentKernelRuntime } from "../index.js";
import { AgentChildManager } from "../children/child-agent.js";
import { AgentEventBus } from "../event-source.js";
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const empty = readonlyMap<never>([]);
function preparation(release = vi.fn(), tools = empty): AgentRunPreparation {
  return {
    async prepare() {
      return { run: { tools }, release };
    },
  };
}
const effects = {
  requestPermission: async () => ({ status: "approved" as const }),
};
function engine() {
  return createBasicAgentKernelRuntime({
    cwd: "/workspace",
    model: "fake",
    client: {
      async *streamMessage() {
        yield { type: "text_delta", delta: "done" };
        yield { type: "complete", stopReason: "end_turn" };
      },
    },
  });
}
describe("generic Kernel lifecycle", () => {
  it("runs using only an explicit engine, prepared bindings and effects", async () => {
    const release = vi.fn();
    const agent = await createAgentKernel({
      cwd: "/workspace",
      engine: engine(),
      effects,
      preparation: preparation(release),
    });
    await expect(agent.runMessage("hello")).resolves.toMatchObject({
      output: "done",
      status: "completed",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect("host" in agent).toBe(false);
    await agent.close();
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("isolates throwing observation listeners while retaining every durable event", async () => {
    const events: AgentEvent[] = [];
    const agent = await createAgentKernel({
      cwd: "/workspace",
      engine: engine(),
      effects,
      preparation: preparation(),
      onEvent: (event) => {
        events.push(event);
      },
    });
    agent.subscribe(() => {
      throw new Error("observer");
    });
    await expect(agent.runMessage("hello")).resolves.toMatchObject({
      status: "completed",
    });
    expect(events.map((e) => e.type)).toContain("run.completed");
    expect(events.at(-1)?.type).toBe("run.completed");
    await agent.close();
  });
  it("does not resolve result until the terminal sink releases", async () => {
    const terminal = deferred(),
      entered = deferred();
    const agent = await createAgentKernel({
      cwd: "/workspace",
      engine: engine(),
      effects,
      preparation: preparation(),
      onEvent: async (event) => {
        if (event.type === "run.completed") {
          entered.resolve();
          await terminal.promise;
        }
      },
    });
    const run = agent.submitMessage("hello");
    let finished = false;
    void run.result.then(() => {
      finished = true;
    });
    await entered.promise;
    expect(finished).toBe(false);
    terminal.resolve();
    await run.result;
    expect(finished).toBe(true);
    await agent.close();
  });
  it("releases prepared resources once when a reliable event fails", async () => {
    const release = vi.fn();
    const agent = await createAgentKernel({
      cwd: "/workspace",
      engine: engine(),
      effects,
      preparation: preparation(release),
      onEvent: (event) => {
        if (event.type === "run.started") throw new Error("sink");
      },
    });
    const run = agent.submitMessage("hello");
    await expect(run.result).rejects.toThrow("sink");
    expect(release).toHaveBeenCalledTimes(1);
    await agent.close();
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch a provider when preparation fails", async () => {
    const call = vi.fn();
    const agent = await createAgentKernel({
      cwd: "/workspace",
      engine: createBasicAgentKernelRuntime({
        client: {
          async *streamMessage() {
            call();
            yield { type: "complete", stopReason: "end_turn" };
          },
        },
      }),
      effects,
      preparation: {
        async prepare() {
          throw new Error("revoked");
        },
      },
    });
    const run = agent.submitMessage("hello");
    await expect(run.started).rejects.toThrow("revoked");
    await expect(run.result).rejects.toThrow("revoked");
    expect(call).not.toHaveBeenCalled();
    await agent.close();
  });
  it("collects every close failure and remains closed", async () => {
    const release = vi.fn(async () => {
      throw new Error("owned resource");
    });
    const agent = await createAgentKernel({
      cwd: "/workspace",
      engine: engine(),
      effects,
      preparation: preparation(),
      release,
    });
    await expect(agent.close()).rejects.toThrow("owned resource");
    expect(agent.state).toBe("closed");
    await expect(agent.close()).rejects.toThrow("owned resource");
    expect(release).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      parentNames: ["A"],
      allowed: ["A", "B"],
      denied: undefined,
      expected: ["A"],
    },
    { parentNames: ["A"], allowed: ["*"], denied: undefined, expected: ["A"] },
    {
      parentNames: ["A", "Shell"],
      allowed: ["*"],
      denied: ["A"],
      expected: ["Shell"],
    },
    {
      parentNames: ["A", "Shell"],
      allowed: ["Bash"],
      denied: undefined,
      expected: ["Shell"],
    },
    {
      parentNames: ["A", "Shell"],
      allowed: ["*"],
      denied: ["Bash"],
      expected: ["A"],
    },
    {
      parentNames: ["A", "Shell"],
      allowed: ["*"],
      denied: ["*"],
      expected: [],
    },
  ])(
    "freezes the parent ceiling under child allow=$allowed deny=$denied",
    async ({ parentNames, allowed, denied, expected }) => {
      const make = (name: string): ToolDefinition => ({
        name,
        description: name,
        inputSchema: { type: "object" },
        async execute() {
          return { content: [] };
        },
      });
      const parent = readonlyMap(
        parentNames.map((name) => {
          const definition = make(name);
          return [
            name,
            {
              definition,
              definitionIdentity: Symbol(name),
              source: { kind: "runtime" as const },
              invoke: definition.execute.bind(definition),
            },
          ] as const;
        }),
      );
      let submitted: any;
      const manager = new AgentChildManager({
        cwd: "/workspace",
        eventBus: new AgentEventBus(),
        resolveChild: (input) => ({
          spawn: input.spawn,
          createAgent: async () =>
            ({
              getHistory: () => [],
              close: async () => {},
              submitMessage: (_content: any, options: any) => {
                submitted = options;
                return {
                  id: options.ids.runId,
                  inputId: options.ids.inputId,
                  sessionId: input.sessionId,
                  traceId: options.ids.traceId,
                  active: false,
                  started: Promise.resolve({
                    sessionId: input.sessionId,
                    inputId: options.ids.inputId,
                    runId: options.ids.runId,
                  }),
                  result: Promise.resolve({
                    status: "completed",
                    output: "done",
                    history: [],
                    usage: { inputTokens: 0, outputTokens: 0 },
                  }),
                  interrupt: async () => {},
                  steer: async () => {
                    throw new Error("closed");
                  },
                };
              },
            }) as any,
        }),
      });
      const invocation = await manager
        .createController(
          {
            agentId: "root",
            sessionId: "root",
            inputId: "i",
            runId: "r",
            traceId: "t",
            cwd: "/workspace",
            signal: new AbortController().signal,
          },
          parent,
        )
        .spawnChildAgent({
          description: "child",
          prompt: "task",
          agent: "worker",
          cwd: "/workspace",
          allowedTools: allowed,
          disallowedTools: denied,
        });
      await invocation.result;
      expect([...submitted.tools.keys()]).toEqual(expected);
      expect([...parent.keys()]).toEqual(parentNames);
      expect((submitted.tools as any).set).toBeUndefined();
      await manager.closeAll();
    },
  );
});
