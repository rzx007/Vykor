import { type ToolDefinition } from "@vykor/agent-contracts";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@vykor/core";
import { type Settings } from "@vykor/host-config";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";
import {  createFixtureNodeAgent as createAgentKernel  } from "../../agent/__test__/host-assembly.test-support.js";
type AgentKernelRuntimeContext=any;
import { createVykorRuntime } from "../../runtime/default-runtime.js";
import { constrainRunCapabilityTools } from "../default-runtime-tools.js";
import { createRunCapabilityView } from "../../plugins/run-capability-view.js";
import { unavailableCapability } from "../../capabilities/capability-resolution.js";

const settings: Settings = { model: "scripted-only", apiFormat: "anthropic", maxTurns: 3,
  permission: { mode: "default" }, sandbox: { enabled: false } };

function environment(kind: "local" | "wsl", networkMode = "bridge"): ExecutionEnvironmentHandle {
  return {
    info: { kind, hostOs: "Windows", executionOs: kind === "wsl" ? "Linux" : "Windows", shell: "test",
      shellDialect: "posix", pathStyle: "posix", cwd: "/workspace", homeDir: "/home", tempDir: "/tmp",
      mounts: [], networkMode, limitations: [] },
    workspace: { kind, hostRoot: "D:/workspace", executionRoot: "/workspace" },
    process: {} as never, files: {} as never, paths: {} as never, release: async () => {},
  };
}

describe("inherited plugin bindings obey the receiving runtime's policy", () => {
  // Merely accepting a captured View bypasses registry visibility, especially its environment checks.
  it.each(["host", "denied", "role", "environment", "network", "text-only"] as const)(
    "filters inherited schemas, delegation and invocation under the %s restriction", async restriction => {
      const registry = new ToolRegistry();
      let invoked = 0;
      const define = (name: string): ToolDefinition => ({ name, description: name, inputSchema: { type: "object" },
        execution: { supportedEnvironments: name === "Blocked" && restriction === "environment" ? ["local"] : ["local", "wsl"],
          network: name === "Blocked" && restriction === "network" },
        execute: async () => { invoked++; return { content: [{ type: "text", text: name }] }; } });
      registry.register(define("Blocked"), { kind: "plugin", id: "office" });
      registry.register(define("Safe"), { kind: "plugin", id: "office" });
      const original = createRunCapabilityView({ toolRegistry: registry, delegatableToolRegistry: registry, pluginIds: new Set(["office"]) }, ["office"]);
      const requests: string[][] = [];
      const agent = await createAgentKernel({
        settings, cwd: "D:/workspace",
        capabilities: {
          terminal: unavailableCapability("test"), backgroundShell: unavailableCapability("test"), jobs: unavailableCapability("test"),
          memory: unavailableCapability("test"), childEnvironment: unavailableCapability("test"),
          workflowRepository: unavailableCapability("test"), schedules: unavailableCapability("test"),
        },
        effects: { requestPermission: async () => ({ status: "approved" }) },
        createRuntime: async context => {
          const runtime = await createVykorRuntime({ settings, cwd: context.cwd,
            executionEnvironment: restriction === "environment" ? environment("wsl")
              : restriction === "network" ? environment("local", "none") : undefined,
            configuration: {
              ...(restriction === "host" ? { hostToolCeiling: ["Safe"] } : {}),
              ...(restriction === "denied" ? { disallowedTools: ["Blocked"] } : {}),
              ...(restriction === "role" ? { roleAllowedTools: ["Safe"] } : {}),
              ...(restriction === "text-only" ? { internalTextOnly: true } : {}),
              client: { async *streamMessage(params) {
                requests.push(params.tools?.map(tool => tool.name) ?? []);
                if (requests.length === 1) yield { type: "tool_use_start" as const,
                  toolUse: { type: "tool_use" as const, id: "blocked-call", name: "Blocked", input: {} } };
                yield { type: "complete" as const, stopReason: requests.length === 1 ? "tool_use" as const : "end_turn" as const };
              } },
            },
          });
          const constrained = constrainRunCapabilityTools(runtime.toolRegistry, original);
          expect([...constrained.delegatableTools!.keys()]).toEqual(restriction === "text-only" ? []
            : restriction === "role" ? ["Blocked", "Safe"] : ["Safe"]);
          return { runtime };
        },
      });
      try {
        await agent.runMessage("attempt inherited tool", { capabilityView: original });
        expect(requests[0]).toEqual(restriction === "text-only" ? [] : ["Safe"]);
        expect(invoked).toBe(0);
      } finally { await agent.close(); }
    },
  );
});
