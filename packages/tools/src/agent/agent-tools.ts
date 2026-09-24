import type { ToolDefinition } from "@vykor/core";
import {
  getAgentDefinition,
  getAllAgentDefinitions,
  type AgentDefinition,
} from "@vykor/coordinator";

const scopedAgentDefinitions = new WeakMap<ToolDefinition, AgentDefinition[]>();

export const agentTool: ToolDefinition = {
  name: "Agent",
  description:
    "Spawn an in-process child-agent job. Use JobWait, JobRead, JobSend, and JobCancel with the returned jobId.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short description of the delegated work" },
      prompt: { type: "string", description: "Full prompt for the agent" },
      subagentType: { type: "string", description: "Agent type (e.g. general-purpose, Explore, worker)" },
      model: { type: "string", description: "Model override" },
      team: { type: "string", description: "Optional team to attach the agent to" },
      permissionMode: {
        type: "string",
        enum: ["default", "plan", "full_auto"],
        description:
          "Permission mode for the spawned agent. Defaults to 'default': write operations are " +
          "escalated to the leader through the framework permission effect.",
      },
      isolate: {
        type: "boolean",
        description:
          "For parallel write tasks, isolate the sub-agent into its own git worktree (separate branch) " +
          "so concurrent file edits don't conflict. Not needed for read-only exploration.",
      },
    },
    required: ["description", "prompt"],
  },
  async execute(input, context) {
    const { getTeamRegistry } = await import("@vykor/coordinator");

    if (input.mode !== undefined) {
      return {
        content: [{ type: "text", text: "Agent.mode is not supported. Agent always uses the framework child manager." }],
        isError: true,
      };
    }

    const permissionMode = input.permissionMode as string | undefined;
    if (permissionMode !== undefined && !["default", "plan", "full_auto"].includes(permissionMode)) {
      return { content: [{ type: "text", text: "Invalid permissionMode. Use default, plan, or full_auto." }], isError: true };
    }

    const children = context.agent?.children;
    if (!children) {
      return { content: [{ type: "text", text: "No framework child manager registered for Agent tool" }], isError: true };
    }

    const subagentType = (input.subagentType as string | undefined) ?? "worker";
    const view = context.capabilityView ?? context.agent?.capabilityView;
    const agentDef = view
      ? view.agents.get(subagentType)?.definition
      : getAgentDefinition(subagentType, scopedAgentDefinitions.get(this));
    if (view && !agentDef) {
      return { content: [{ type: "text", text: `Agent is not available in this run: ${subagentType}` }], isError: true };
    }
    const team = (input.team as string) ?? "default";

    try {
      const workerSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const invocation = await children.spawnChildAgent({
        description: input.description as string,
        prompt: input.prompt as string,
        agent: subagentType,
        team,
        cwd: context.cwd,
        sessionId: workerSessionId,
        model: (input.model as string) ?? agentDef?.model,
        systemPrompt: agentDef?.systemPrompt,
        permissionMode: (permissionMode ?? agentDef?.permissionMode) as "default" | "plan" | "full_auto" | undefined,
        isolate: input.isolate === true,
        allowedTools: agentDef?.tools,
        requiredMcpServers: agentDef?.requiredMcpServers,
        disallowedTools: agentDef?.disallowedTools,
        maxTurns: agentDef?.maxTurns,
        effort: agentDef?.effort != null ? String(agentDef.effort) : undefined,
      });

      if (input.team) {
        try {
          getTeamRegistry().addAgent(input.team as string, invocation.id);
        } catch {
          // Team registration is best-effort; spawning already succeeded.
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            kind: "job",
            action: "created",
            jobId: invocation.id,
            jobKind: "agent",
            label: input.description,
            agent: `${subagentType}@${team}`,
            sessionId: invocation.sessionId,
            backend: "framework",
            ...(invocation.worktree ? {
              worktree: invocation.worktree,
              cleanup: `git worktree remove ${invocation.worktree.path}`,
            } : {}),
            ...(invocation.notice ? { notice: invocation.notice } : {}),
          }),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  },
};

export interface CreateAgentToolOptions {
  /** Plugin definitions owned by this tool's runtime. An empty array explicitly disables global plugins. */
  agentDefinitions?: AgentDefinition[];
}

export function createAgentTool(options: CreateAgentToolOptions = {}): ToolDefinition {
  if (options.agentDefinitions === undefined) return agentTool;
  const tool = { ...agentTool };
  scopedAgentDefinitions.set(tool, getAllAgentDefinitions(options.agentDefinitions));
  return tool;
}
