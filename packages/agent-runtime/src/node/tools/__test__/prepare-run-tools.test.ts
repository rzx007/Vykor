import { expect, it, vi } from "vitest";
import { createDefaultToolRegistry } from "../default-tool-registry.js";
import { createRunCapabilityView } from "../../plugins/run-capability-view.js";
import { NodeRunCatalogue } from "../../capabilities/node-run-catalogue.js";
import { deriveChildCapabilityView } from "../../children/child-agent-options.js";
import { prepareNodeRunTools } from "../prepare-run-tools.js";
import { McpClientManager } from "@vykor/mcp";
import { createDefaultNodeAgent } from "../../agent/default-agent.js";
import type { ToolDispatchCheckFactory, ToolDefinition } from "@vykor/agent-contracts";
import { AgentChildManager } from "../../../kernel/children/child-agent.js";
import { AgentEventBus } from "../../../kernel/event-source.js";
import {
  createAgentKernel,
  createBasicAgentKernelRuntime,
} from "../../../kernel/index.js";
import type {
  NodeRuntimeResources,
  RunCapabilityView,
} from "../../runtime/node-runtime-resources.js";

it.each([false, true])(
  "preserves preparation-only host check through Node child tool binding: %s",
  async (withCheck) => {
    let effects = 0;
    let dispatchChecks = 0;
    const check: ToolDispatchCheckFactory = () => async () => { dispatchChecks++; throw new Error("denied by host"); };
    const write: ToolDefinition = {
      name: "Write",
      description: "count a real child tool effect",
      inputSchema: { type: "object" },
      execute: async () => {
        effects++;
        return { content: [{ type: "text", text: "effect" }] };
      },
    };
    const manager = new AgentChildManager({
      cwd: process.cwd(),
      eventBus: new AgentEventBus(),
      resolveChild: (input) => ({
        spawn: input.spawn,
        createAgent: async () => {
          let requests = 0;
          return createAgentKernel({
            sessionId: input.sessionId,
            cwd: process.cwd(),
            engine: createBasicAgentKernelRuntime({
              tools: [write],
              client: {
                async *streamMessage() {
                  if (requests++ === 0) {
                    yield {
                      type: "tool_use_start",
                      toolUse: {
                        type: "tool_use",
                        id: "write",
                        name: "Write",
                        input: {},
                      },
                    };
                    yield { type: "complete", stopReason: "tool_use" };
                  } else yield { type: "complete", stopReason: "end_turn" };
                },
              },
            }),
            effects: {
              requestPermission: async () => ({ status: "approved" }),
            },
            preparation: {
              prepare: async () => ({
                run: {
                  tools: new Map([
                    ["Write", { definition: write, invoke: write.execute }],
                  ]),
                },
              }),
            },
          });
        },
      }),
    });
    const definition: ToolDefinition = {
      name: "Agent",
      description: "spawn a child through the real Node wrapper",
      inputSchema: { type: "object" },
      execute: async (_input, context) => {
        const child = await context.agent!.children!.spawnChildAgent({
          description: "child",
          prompt: "task",
          agent: "worker",
          cwd: process.cwd(),
        });
        await child.result;
        return { content: [] };
      },
    };
    const view: RunCapabilityView = {
      tools: new Map([
        [
          "Agent",
          {
            definition,
            invoke: definition.execute,
            source: { kind: "builtin" },
          },
        ],
        [
          "Write",
          {
            definition: write,
            invoke: write.execute,
            source: { kind: "builtin" },
          },
        ],
      ]),
      agents: new Map(),
      skills: new Map(),
      mcpServers: new Map(),
    };
    const tools = prepareNodeRunTools(
      {
        runCatalogue: new NodeRunCatalogue(),
        childManager: manager,
      } as NodeRuntimeResources,
      view,
    );
    const scope = {
      agentId: "root",
      sessionId: "root",
      runId: "r",
      inputId: "i",
      traceId: "t",
      cwd: process.cwd(),
      signal: new AbortController().signal,
    };
    try {
      await tools.get("Agent")!.invoke(
        {},
        {
          cwd: process.cwd(),
          agent: {
            scope,
            bindToolDispatch: withCheck ? check : undefined,
            children: manager.createController({
              ...scope,
              bindToolDispatch: withCheck ? check : undefined,
            }),
          },
        },
      );
      expect(effects).toBe(withCheck ? 0 : 1);
      expect(dispatchChecks).toBe(withCheck ? 1 : 0);
    } finally {
      await manager.closeAll();
    }
  },
);

it("captures a configured disconnected HTTP server for authentication during Node assembly", async () => {
  const connect = vi
    .spyOn(McpClientManager.prototype, "connect")
    .mockResolvedValue({
      status: "error",
      error: new Error("authentication required"),
    } as any);
  let agent: Awaited<ReturnType<typeof createDefaultNodeAgent>> | undefined;
  try {
    agent = await createDefaultNodeAgent({
      cwd: process.cwd(),
      pluginsEnabled: false,
      settings: {
        model: "offline-mcp",
        permission: { mode: "full_auto" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
      client: {
        async *streamMessage() {
          yield { type: "complete", stopReason: "end_turn" };
        },
      },
      mcpServers: { offline: { type: "http", url: "https://offline.invalid" } },
      capabilityOverrides: {
        terminal: false,
        jobs: false,
        backgroundShell: false,
        memory: false,
        childEnvironment: false,
        workflowRepository: false,
      },
    });
    const view = agent.host.plugins.createRunCapabilityView();
    expect(view.mcpServers.size).toBe(0);
    expect(
      [...view.mcpAuthServers!.values()].map((server) => server.serverName),
    ).toEqual(["offline"]);
  } finally {
    await agent?.close();
    connect.mockRestore();
  }
});

it("repairs captured offline MCP authentication without granting foreign or child-excluded servers", async () => {
  const configure = vi.fn(async () => ({ message: "saved" }));
  const registry = createDefaultToolRegistry({
    skills: {
      resolve: async () => ({ getAll: () => [], get: () => undefined }),
    } as any,
    agentDefinitions: [],
  });
  const runtime = {
    toolFactoryOptions: { agentDefinitions: [] },
    mcpAuth: { configure },
    runCatalogue: new NodeRunCatalogue(),
  } as any;
  const servers = [
    {
      serverId: "mcp:offline",
      serverName: "offline",
      definition: { type: "http" as const, url: "https://offline.invalid" },
    },
    {
      serverId: "plugin:foreign",
      serverName: "foreign",
      ownerPluginId: "foreign",
      definition: { type: "http" as const, url: "https://foreign.invalid" },
    },
  ];
  const view = createRunCapabilityView({
    toolRegistry: registry,
    pluginIds: new Set(["foreign"]),
    mcpServers: [],
    mcpAuthServers: servers,
  });
  expect(view.mcpServers.size).toBe(0);
  const invoke = async (captured: typeof view, serverName: string) =>
    prepareNodeRunTools(runtime, captured)
      .get("McpAuth")!
      .invoke(
        { serverName, mode: "bearer", value: "test-token" },
        { cwd: process.cwd() },
      );
  expect((await invoke(view, "offline")).isError).not.toBe(true);
  expect(configure).toHaveBeenCalledOnce();
  expect((await invoke(view, "foreign")).isError).toBe(true);
  const child = deriveChildCapabilityView(view, {
    agent: "worker",
    description: "child",
    prompt: "task",
    cwd: process.cwd(),
    requiredMcpServers: [],
  })!;
  expect((await invoke(child, "offline")).isError).toBe(true);
  expect(configure).toHaveBeenCalledOnce();
});
