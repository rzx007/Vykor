import { expect, it, vi } from "vitest";
import { createDefaultToolRegistry } from "../tools/default-tool-registry.js";
import { createRunCapabilityView } from "../plugins/run-capability-view.js";
import { NodeRunCatalogue } from "../capabilities/node-run-catalogue.js";
import { deriveChildCapabilityView } from "./child-agent-options.js";
import { prepareNodeRunTools } from "./prepare-run-tools.js";
import { McpClientManager } from "@vykor/mcp";
import { createDefaultNodeAgent } from "./default-agent.js";

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
