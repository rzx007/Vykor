import type { ToolDefinition } from "@vykor/core";

/** Small host DTO. It intentionally does not depend on persisted Goal records. */
export interface GoalReadSnapshot {
  goalId: string;
  objectiveVersion: number;
  phase: "preparing" | "executing";
  objective: string;
  sourceInputIds: string[];
  requirements: Array<{ id: string; text: string; verification: string;
    status: "incomplete" | "satisfied" | "needs_user" }>;
  latestAssessment?: string;
  waitSummary?: string;
  stopReason?: string;
  autoTurnsUsed: number;
  maxAutoTurns: number;
  knownTokens: number;
  usageIncomplete: boolean;
}

export const GOAL_READ_TOOL_NAME = "GoalRead";

/** Shared rendering for both prompt guidance and on-demand reads. */
export function formatGoalReadSnapshot(snapshot: GoalReadSnapshot): string {
  const short = (value: string | undefined, limit = 1000) => value === undefined ? undefined
    : value.length <= limit ? value : value.slice(0, limit) + "…";
  return JSON.stringify({ ...snapshot, maxAutoTurns: snapshot.maxAutoTurns === 0 ? "unlimited" : snapshot.maxAutoTurns, objective: short(snapshot.objective, 4000),
    sourceInputIds: snapshot.sourceInputIds.map(id => short(id, 256)),
    requirements: snapshot.requirements.slice(0, 64).map(requirement => ({ ...requirement,
      text: short(requirement.text, 500), verification: short(requirement.verification, 500) })),
    latestAssessment: short(snapshot.latestAssessment), waitSummary: short(snapshot.waitSummary),
    stopReason: short(snapshot.stopReason) });
}

export function createGoalReadTool(read: () => Promise<GoalReadSnapshot>): ToolDefinition {
  return {
    name: GOAL_READ_TOOL_NAME,
    description: "Read the current host-bound goal, formal requirements and latest status. No IDs are accepted.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execution: { domain: "control_plane", supportedEnvironments: ["local", "wsl"] },
    safeToRetry: true,
    async execute(input) {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) {
        return { isError: true, content: [{ type: "text", text: "GoalRead accepts only an empty object." }] };
      }
      try {
        return { content: [{ type: "text", text: formatGoalReadSnapshot(await read()) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `GoalRead is unavailable for this Run: ${String(error)}` }] };
      }
    },
  };
}
