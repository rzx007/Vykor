import { expect, it } from "vitest";
import { QueryEngine } from "../query-engine.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { AgentExecutionContext, StreamMessageParams } from "@vykor/agent-contracts";

it("keeps a host run contribution isolated from the next run", async () => {
  const systems: Array<string | undefined> = [];
  const toolNames: string[][] = [];
  const registry = new ToolRegistry();
  const runTool = {
    name: "RunControl",
    description: "run control",
    inputSchema: { type: "object" },
    execute: async () => ({ content: [] }),
  };
  const engine = new QueryEngine(
    {
      streamMessage: async function* (input: StreamMessageParams) {
        systems.push(input.system);
        toolNames.push(input.tools?.map((tool) => tool.name) ?? []);
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    },
    registry,
    { checkTool: async () => ({ action: "allow", reason: "test" }) },
    {
      execute: async () => ({ blocked: false }),
    } as any,
    { systemPrompt: "base" },
  );
  engine.setAllowedTools(["Read"]);
  const execution = {
    contribution: {
      systemGuidance: "unique-run-guidance",
      tools: [{ definition: runTool, permission: "host-internal" }],
    },
    emit: async () => {},
    takeSteeredInputs: async () => [],
    closeSteering: () => {},
  } as unknown as AgentExecutionContext;
  for await (const _ of engine.submitMessage("work", { execution })) {
    /* drain */
  }
  for await (const _ of engine.submitMessage("ordinary")) {
    /* drain */
  }
  expect(systems[0]).toContain("unique-run-guidance");
  expect(systems[1]).toBe("base");
  expect(toolNames).toEqual([["RunControl"], []]);
});

it("does not carry goal-scoped contribution into subsequent ordinary turns", async () => {
  const systems: Array<string | undefined> = [];
  const toolNames: string[][] = [];
  const registry = new ToolRegistry();
  const runTool = {
    name: "RunControl",
    description: "run control",
    inputSchema: { type: "object" },
    execute: async () => ({ content: [] }),
  };
  const engine = new QueryEngine(
    {
      streamMessage: async function* (input: StreamMessageParams) {
        systems.push(input.system);
        toolNames.push(input.tools?.map((tool) => tool.name) ?? []);
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    },
    registry,
    { checkTool: async () => ({ action: "allow", reason: "test" }) },
    {
      execute: async () => ({ blocked: false }),
    } as any,
    { systemPrompt: "base" },
  );
  engine.setAllowedTools(["Read"]);
  const execution = {
    contribution: {
      systemGuidance: "goal-only-guidance",
      tools: [{ definition: runTool, permission: "host-internal" }],
    },
    emit: async () => {},
    takeSteeredInputs: async () => [],
    closeSteering: () => {},
  } as unknown as AgentExecutionContext;
  for await (const _ of engine.submitMessage("goal run", { execution })) {
    /* drain */
  }
  for await (const _ of engine.submitMessage("ordinary #1")) {
    /* drain */
  }
  for await (const _ of engine.submitMessage("ordinary #2")) {
    /* drain */
  }
  expect(systems[0]).toContain("goal-only-guidance");
  expect(systems[1]).toBe("base");
  expect(systems[2]).toBe("base");
  expect(toolNames[0]).toEqual(["RunControl"]);
  expect(toolNames[1]).toEqual([]);
  expect(toolNames[2]).toEqual([]);
});

it("rejects a run tool that conflicts with a configured tool", async () => {
  const registry = new ToolRegistry();
  const definition = {
    name: "Read",
    description: "read",
    inputSchema: { type: "object" },
    execute: async () => ({ content: [] }),
  };
  registry.register(definition);
  const engine = new QueryEngine(
    {
      streamMessage: async function* () {
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    },
    registry,
    { checkTool: async () => ({ action: "allow" }) },
    { execute: async () => ({ blocked: false }) } as any,
  );
  const execution = {
    contribution: { tools: [{ definition, permission: "host-internal" }] },
  } as unknown as AgentExecutionContext;
  const consume = async () => {
    for await (const _ of engine.submitMessage("work", { execution })) {
      /* drain */
    }
  };
  await expect(consume()).rejects.toThrow("conflicts");
});
