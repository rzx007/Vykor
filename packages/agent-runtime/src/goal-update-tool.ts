import type { ToolDefinition } from "@vykor/core";

export const GOAL_UPDATE_TOOL_NAME = "GoalUpdate";

const textSchema = { type: "string", minLength: 1, maxLength: 4000 };
const object = (properties: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, required: Object.keys(properties), properties,
});

/** The host closure supplies the goal, objective version and originating Run identity. */
export function createGoalUpdateTool(
  submitUpdate: (input: Record<string, unknown>) => Promise<{ recorded: true }>,
): ToolDefinition {
  return {
    name: GOAL_UPDATE_TOOL_NAME,
    description: "Optionally record a goal status change, a question for the user, or a wait for a specific child Run. "
      + "Choose exactly one request. The host applies it only after this Run completes normally. "
      + "Ordinary work does not require this tool. After a successful submission, finish the normal final reply promptly. "
      + "Use paused only when the user explicitly requests a pause.",
    inputSchema: { type: "object", oneOf: [
      object({ status: { type: "string", enum: ["completed", "blocked", "paused"] }, reason: textSchema }),
      object({ question: textSchema }),
      object({ wait: object({
        targetRunId: { type: "string", minLength: 1, maxLength: 256 },
        deadlineAt: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      }) }),
    ] },
    execution: { domain: "control_plane", supportedEnvironments: ["local", "wsl"] },
    async execute(input) {
      if (!isGoalUpdate(input)) return { isError: true, content: [{ type: "text", text:
        "GoalUpdate requires exactly one of {status: completed|blocked|paused, reason}, {question}, or {wait: {targetRunId, deadlineAt}}. "
        + "Identity and extra fields are not accepted; text must be non-empty and deadlineAt must be a positive integer timestamp.",
      }] };
      try {
        await submitUpdate(input);
        return { content: [{ type: "text", text: "已记录，将在本回合正常结束后生效。请尽快完成正常最终回复。" }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `GoalUpdate could not be recorded: ${String(error)}` }] };
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function text(value: unknown, maxLength = 4000): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isGoalUpdate(input: unknown): input is Record<string, unknown> {
  if (!isRecord(input)) return false;
  if (exactKeys(input, ["status", "reason"])) {
    return typeof input.status === "string" && ["completed", "blocked", "paused"].includes(input.status) && text(input.reason);
  }
  if (exactKeys(input, ["question"])) return text(input.question);
  if (!exactKeys(input, ["wait"]) || !isRecord(input.wait) || !exactKeys(input.wait, ["targetRunId", "deadlineAt"])) return false;
  return text(input.wait.targetRunId, 256) && Number.isSafeInteger(input.wait.deadlineAt) && Number(input.wait.deadlineAt) > 0;
}
