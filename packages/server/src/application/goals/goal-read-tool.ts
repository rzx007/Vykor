import type { ToolDefinition } from "@vykor/agent-contracts";

/** Small host DTO. It intentionally does not depend on persisted Goal records. */
export interface GoalReadSnapshot {
  goalId: string;
  objectiveVersion: number;
  objective: string;
  status:
    | "active"
    | "waiting_user"
    | "blocked"
    | "paused"
    | "completed"
    | "cancelled";
  wait?:
    | {
        kind: "user";
        questionId: string;
        question: string;
        objectiveVersion: number;
      }
    | { kind: "approval"; permissionRequestId: string }
    | {
        kind: "external";
        targetRunId: string;
        deadlineAt: number;
        observedStatus?:
          | "pending"
          | "running"
          | "completed"
          | "failed"
          | "interrupted"
          | "cancelled";
      };
  reason?: string;
  stopReason?: string;
  autoTurnsUsed: number;
  maxAutoTurns: number;
  knownTokens: number;
  usageIncomplete: boolean;
  tokenBudget?: number;
}

export const GOAL_READ_TOOL_NAME = "GoalRead";

/** Shared rendering for both prompt guidance and on-demand reads. */
export function formatGoalReadSnapshot(snapshot: GoalReadSnapshot): string {
  return JSON.stringify({
    goalId: snapshot.goalId,
    objectiveVersion: snapshot.objectiveVersion,
    objective: snapshot.objective,
    status: snapshot.status,
    wait: snapshot.wait,
    reason: snapshot.reason,
    stopReason: snapshot.stopReason,
    autoTurnsUsed: snapshot.autoTurnsUsed,
    maxAutoTurns:
      snapshot.maxAutoTurns === 0 ? "unlimited" : snapshot.maxAutoTurns,
    knownTokens: snapshot.knownTokens,
    usageIncomplete: snapshot.usageIncomplete,
    tokenBudget: snapshot.tokenBudget,
  });
}

export function createGoalReadTool(
  read: () => Promise<GoalReadSnapshot>,
): ToolDefinition {
  return {
    name: GOAL_READ_TOOL_NAME,
    description:
      "Read the complete current host-bound goal, status, wait, stop details and usage. No IDs are accepted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execution: {
      domain: "control_plane",
      supportedEnvironments: ["local", "wsl"],
    },
    safeToRetry: true,
    async execute(input) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length
      ) {
        return {
          isError: true,
          content: [
            { type: "text", text: "GoalRead accepts only an empty object." },
          ],
        };
      }
      try {
        return {
          content: [
            { type: "text", text: formatGoalReadSnapshot(await read()) },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `GoalRead is unavailable for this Run: ${String(error)}`,
            },
          ],
        };
      }
    },
  };
}
