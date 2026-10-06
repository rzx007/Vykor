import type { ToolDefinition } from "@vykor/core";
import {
  getAgentDefinition,
  getAllAgentDefinitions,
  type AgentDefinition,
} from "@vykor/coordinator";

const scopedAgentDefinitions = new WeakMap<ToolDefinition, AgentDefinition[]>();
const MAX_DELEGATION_TEXT_LENGTH = 2_000;

export const agentTool: ToolDefinition = {
  name: "Agent",
  description:
    "Spawn an in-process child-agent job for one independently deliverable scope. Give it a " +
    "`scope` (the files, modules, or assertion categories it owns) and an `expectedResult` " +
    "(the expected result you need back). When visible job controls are available, use them " +
    "with the returned jobId. Do not claim the job completed without evidence.",
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
          "Permission mode for the spawned agent. Inherits the parent's current mode when omitted; " +
          "can only narrow that mode, never raise the parent's authority.",
      },
      isolate: {
        type: "boolean",
        description:
          "For parallel write tasks, isolate the sub-agent into its own git worktree (separate branch) " +
          "so concurrent file edits don't conflict. Not needed for read-only exploration.",
      },
      scope: {
        type: "string",
        maxLength: MAX_DELEGATION_TEXT_LENGTH,
        description:
          "Task boundary the child owns: files, modules, questions or assertion categories. " +
          "It narrows the described work only; it never grants tools, paths or permissions.",
      },
      expectedResult: {
        type: "string",
        maxLength: MAX_DELEGATION_TEXT_LENGTH,
        description:
          "Deliverable the parent needs back, such as evidence-backed findings, changes with test " +
          "results, or explicit blockers.",
      },
      maxTurns: {
        type: "integer",
        minimum: 1,
        description: "Optional turn budget for this child run. It can only tighten the configured budget.",
      },
      timeoutSeconds: {
        type: "integer",
        minimum: 1,
        description: "Optional wall-clock budget for this child run. Legacy calls without it get no timer.",
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

    const scope = input.scope;
    const expectedResult = input.expectedResult;
    for (const [name, value] of [["scope", scope], ["expectedResult", expectedResult]] as const) {
      if (value !== undefined && !isDelegationText(value)) {
        return {
          content: [{
            type: "text",
            text: `Invalid ${name}. Provide non-empty text up to ${MAX_DELEGATION_TEXT_LENGTH} characters.`,
          }],
          isError: true,
        };
      }
    }
    const maxTurns = input.maxTurns;
    if (maxTurns !== undefined && !isPositiveBudget(maxTurns)) {
      return { content: [{ type: "text", text: "Invalid maxTurns. Use a positive integer." }], isError: true };
    }
    const timeoutSeconds = input.timeoutSeconds;
    if (timeoutSeconds !== undefined && !isPositiveBudget(timeoutSeconds)) {
      return { content: [{ type: "text", text: "Invalid timeoutSeconds. Use a positive integer." }], isError: true };
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
        timeoutSeconds: agentDef?.timeoutSeconds,
        effort: agentDef?.effort != null ? String(agentDef.effort) : undefined,
        ...(typeof scope === "string" ? { scope } : {}),
        ...(typeof expectedResult === "string" ? { expectedResult } : {}),
        ...(maxTurns !== undefined ? { requestedMaxTurns: maxTurns } : {}),
        ...(typeof timeoutSeconds === "number" ? { requestedTimeoutSeconds: timeoutSeconds } : {}),
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

function isDelegationText(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_DELEGATION_TEXT_LENGTH;
}

function isPositiveBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function createAgentTool(options: CreateAgentToolOptions = {}): ToolDefinition {
  if (options.agentDefinitions === undefined) return agentTool;
  const tool = { ...agentTool };
  scopedAgentDefinitions.set(tool, getAllAgentDefinitions(options.agentDefinitions));
  return tool;
}
