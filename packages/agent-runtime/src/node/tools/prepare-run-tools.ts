import { readonlyMap } from "@vykor/agent-contracts";
import { createDefaultToolRegistry } from "./default-tool-registry.js";
import {
  createNodeMcpPort,
  createRunSkillCatalog,
} from "./tool-ports.js";
import type {
  NodeRuntimeResources,
  RunCapabilityView,
  NodeRunToolBinding,
} from "../runtime/node-runtime-resources.js";
export function prepareNodeRunTools(
  runtime: NodeRuntimeResources,
  view: RunCapabilityView,
  candidates?: readonly import("../plugins/plugin-selection.js").PluginSelectionCandidate[],
): ReadonlyMap<string, NodeRunToolBinding> {
  const options = runtime.toolFactoryOptions;
  const registry = options
    ? createDefaultToolRegistry({
        ...options,
        skills: createRunSkillCatalog(view),
        agentDefinitions: [...view.agents.values()].map(
          (item) => item.definition,
        ),
        mcp: createNodeMcpPort(
          runtime.mcpManager,
          runtime.mcpAuth,
          new Set([...view.mcpServers.values()].map((item) => item.serverName)),
          new Set(
            [...(view.mcpAuthServers ?? view.mcpServers).values()].map(
              (item) => item.serverName,
            ),
          ),
        ),
        authorization: Object.freeze({
          ...view,
          tools: readonlyMap([...(view.delegatableTools ?? []), ...view.tools]),
        }),
      })
    : undefined;
  const delegation = readonlyMap([
    ...(view.delegatableTools ?? []),
    ...view.tools,
  ]);
  runtime.runCatalogue.register(
    Object.freeze({ ...view, tools: delegation }),
    candidates,
  );
  const tools = readonlyMap(
    [...view.tools].map(([name, binding]) => {
      const replacement =
        binding.source?.kind === "builtin" ? registry?.get(name) : undefined;
      const invoke = replacement
        ? replacement.execute.bind(replacement)
        : binding.invoke;
      return [
        name,
        Object.freeze({
          ...binding,
          invoke: (
            input: Record<string, unknown>,
            context: import("@vykor/agent-contracts").ToolContext,
          ) => {
            const agent = context.agent;
            const captured =
              runtime.childManager && agent
                ? {
                    ...context,
                    agent: {
                      ...agent,
                      children: runtime.childManager.createController(
                        {
                          ...agent.scope,
                          limits: agent.limits,
                          bindToolDispatch: agent.bindToolDispatch,
                        },
                        delegation,
                      ),
                    },
                  }
                : context;
            return invoke(input, captured);
          },
        }),
      ] as const;
    }),
  );
  const captured = Object.freeze({ ...view, tools });
  runtime.runCatalogue.register(captured, candidates);
  return tools;
}
