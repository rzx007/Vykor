import type { ToolDefinition } from "@vykor/core";

const textSchema = { type: "string", minLength: 1, maxLength: 4000 };
export const GOAL_ASSESSMENT_TOOL_NAME = "GoalAssessment";
function validText(value: unknown, max = 4000): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.trim().length <= max && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

export function createGoalAssessmentTool(binding?: { goalId: string; revision: number }): ToolDefinition {
  return {
    name: GOAL_ASSESSMENT_TOOL_NAME,
    description: "Submit the outcome of the current durable goal turn. Call once at the end of a goal-linked run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "progress", "progressAssessment", "evidence"],
      properties: {
        decision: {
          type: "string",
          enum: ["continue", "complete", "waiting_user", "blocked"],
        },
        progress: textSchema,
        progressAssessment: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "summary"],
          properties: {
            kind: {
              type: "string",
              enum: ["progress", "waiting", "no_progress"],
            },
            summary: textSchema,
            blockerKey: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
        evidence: { type: "array", maxItems: 32, items: textSchema },
        evidenceRefs: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["messagePartId", "criterion"],
            properties: {
              messagePartId: { type: "string", minLength: 1, maxLength: 256 },
              criterion: textSchema,
            },
          },
        },
        requirements: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["requirement", "source", "status", "evidenceRefs"],
            properties: {
              requirement: textSchema,
              source: textSchema,
              status: {
                type: "string",
                enum: ["satisfied", "incomplete", "needs_user"],
              },
              evidenceRefs: {
                type: "array",
                maxItems: 32,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["messagePartId", "criterion"],
                  properties: {
                    messagePartId: {
                      type: "string",
                      minLength: 1,
                      maxLength: 256,
                    },
                    criterion: textSchema,
                  },
                },
              },
            },
          },
        },
        remainingWork: { type: "array", maxItems: 64, items: textSchema },
        nextStep: textSchema,
        reason: textSchema,
        question: textSchema,
        wait: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "handleId", "deadlineAt"],
          properties: {
            kind: { type: "string", enum: ["external"] },
            handleId: { type: "string", minLength: 1, maxLength: 256 },
            deadlineAt: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    execution: {
      domain: "control_plane",
      supportedEnvironments: ["local", "wsl"],
    },
    async execute(input, context) {
      if (!binding || !context.agent || typeof input.decision !== "string" || !["continue", "complete", "waiting_user", "blocked"].includes(input.decision) || !validText(input.progress) || !validProgressAssessment(input.progressAssessment) || !Array.isArray(input.evidence) || input.evidence.length > 32 || !input.evidence.every((item) => validText(item)) || ![input.nextStep, input.reason, input.question].every((item) => item === undefined || validText(item))) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Goal assessment is unavailable or invalid.",
            },
          ],
        };
      }
      const refs = input.evidenceRefs ?? [];
      if (!Array.isArray(refs) || refs.length > 32 || !refs.every((ref) => ref && typeof ref === "object" && validText(ref.messagePartId, 256) && validText(ref.criterion))) {
        return {
          isError: true,
          content: [{ type: "text", text: "Invalid goal evidence references." }],
        };
      }
      const requirements = input.requirements;
      const remainingWork = input.remainingWork ?? [];
      if (!Array.isArray(remainingWork) || remainingWork.length > 64 || !remainingWork.every((item) => validText(item))) {
        return {
          isError: true,
          content: [{ type: "text", text: "Invalid remaining goal work." }],
        };
      }
      if (requirements !== undefined && (!Array.isArray(requirements) || requirements.length > 64 || !requirements.every(validRequirement))) {
        return {
          isError: true,
          content: [{ type: "text", text: "Invalid goal requirement audit." }],
        };
      }
      if (input.decision === "complete" && (!Array.isArray(requirements) || requirements.length === 0)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Completion requires a requirement audit." }],
        };
      }
      if (input.wait !== undefined && !validExternalWait(input.wait)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Invalid external goal wait." }],
        };
      }
      if (input.progressAssessment.kind === "waiting" && input.decision !== "waiting_user" && !validExternalWait(input.wait)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "A waiting assessment requires a live handle and deadline.",
            },
          ],
        };
      }
      await context.agent.emit({
        type: "domain.event",
        data: {
          name: "goal.assessment",
          payload: {
            goalId: binding.goalId,
            revision: binding.revision,
            runId: context.agent.scope.runId,
            decision: input.decision,
            progress: input.progress,
            progressAssessment: input.progressAssessment,
            evidence: input.evidence,
            evidenceRefs: refs,
            ...(requirements === undefined ? {} : { requirements }),
            ...(input.remainingWork === undefined ? {} : { remainingWork }),
            ...(typeof input.nextStep === "string" ? { nextStep: input.nextStep } : {}),
            ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
            ...(typeof input.question === "string" ? { question: input.question } : {}),
            ...(input.wait === undefined ? {} : { wait: { ...input.wait, runId: context.agent.scope.runId } }),
          },
        },
      });
      return { content: [{ type: "text", text: "Goal assessment recorded." }] };
    },
  };
}

function validExternalWait(value: unknown): value is { kind: "external"; handleId: string; deadlineAt: number } {
  if (!value || typeof value !== "object") return false;
  const wait = value as Record<string, unknown>;
  return wait.kind === "external" && validText(wait.handleId, 256) && Number.isSafeInteger(wait.deadlineAt) && (wait.deadlineAt as number) > 0;
}

function validProgressAssessment(value: unknown): value is { kind: string; summary: string; blockerKey?: string } {
  if (!value || typeof value !== "object") return false;
  const progress = value as Record<string, unknown>;
  if (!["progress", "waiting", "no_progress"].includes(String(progress.kind)) || !validText(progress.summary)) return false;
  if (progress.blockerKey !== undefined && !validText(progress.blockerKey, 256)) return false;
  return progress.kind !== "no_progress" || validText(progress.blockerKey, 256);
}

function validRequirement(value: unknown): value is {
  requirement: string;
  source: string;
  status: string;
  evidenceRefs: { messagePartId: string; criterion: string }[];
} {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!validText(item.requirement) || !validText(item.source) || !["satisfied", "incomplete", "needs_user"].includes(String(item.status)) || !Array.isArray(item.evidenceRefs) || item.evidenceRefs.length > 32) return false;
  return item.evidenceRefs.every((ref) => {
    if (!ref || typeof ref !== "object") return false;
    const evidence = ref as Record<string, unknown>;
    return validText(evidence.messagePartId, 256) && validText(evidence.criterion);
  });
}
