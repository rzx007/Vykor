import type { ToolDefinition } from "@vykor/core";
import type { GoalAssessmentFeedback } from "./goal-read-tool.js";

const textSchema = { type: "string", minLength: 1, maxLength: 4000 };
const idSchema = { type: "string", minLength: 1, maxLength: 256 };
const digestSchema = { type: "string", minLength: 71, maxLength: 71, pattern: "^sha256:[a-f0-9]{64}$" };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", additionalProperties: false, required, properties });
const array = (items: unknown, maxItems: number, minItems = 0) => ({ type: "array", items, maxItems, minItems });
const evidenceSchema = object({
  messagePartId: idSchema, criterion: textSchema,
  goalId: idSchema, objectiveVersion: { type: "integer", minimum: 1 }, runId: idSchema,
  revalidation: object({ messagePartIds: array(idSchema, 32, 1), environmentKey: idSchema,
    command: textSchema, expected: textSchema,
    dependencies: array(object({ subjectKey: idSchema, digest: { oneOf: [{ const: "missing" }, digestSchema] } }), 64) },
  ["messagePartIds", "environmentKey", "dependencies"]),
}, ["messagePartId", "criterion"]);
const verificationSchema = { oneOf: [
  object({ kind: { const: "check" }, method: textSchema, command: textSchema, commandPolicy: { enum: ["suggested", "required"] },
    environment: textSchema, expected: textSchema }, ["kind", "method", "environment", "expected"]),
  object({ kind: { const: "artifact_review" }, artifact: { ...textSchema, pattern: "^(?:/|[a-zA-Z]:[\\\\/]|\\\\\\\\|\\.{1,2}[\\\\/])",
    description: "A literal file path, absolute or explicitly relative (./ or ../). Never a chat message label." }, standard: textSchema }),
  object({ kind: { const: "tool_result" }, toolName: { ...idSchema, pattern: "^(?!(?:GoalRead|GoalAssessment)$).+" }, outcome: { const: "success" }, standard: textSchema }),
  object({ kind: { const: "tool_result" }, toolName: { const: "GoalAssessment" }, outcome: { const: "rejected" }, rejectionCode: idSchema, standard: textSchema }),
  object({ kind: { const: "user_acceptance" }, question: textSchema }),
] };
const preparedSchema = object({
  text: textSchema,
  source: array({ oneOf: [
    object({ kind: { const: "input" }, inputId: idSchema, quote: textSchema }),
    object({ kind: { const: "document" }, path: textSchema, digest: digestSchema,
      quote: textSchema, evidencePartId: idSchema }),
  ] }, 32, 1),
  verification: verificationSchema, constraints: array(textSchema, 64), previousRequirementId: idSchema,
}, ["text", "source", "verification", "constraints"]);

export const GOAL_ASSESSMENT_TOOL_NAME = "GoalAssessment";
export interface GoalAssessmentBinding {
  goalId: string;
  objectiveVersion: number;
  phase: "preparing" | "executing";
  requirementIds?: readonly string[];
  reviewAssessment?: (input: Record<string, unknown>) => Promise<GoalAssessmentFeedback>;
}

/** Phase is captured from the host; neither model input nor metadata can change it. */
export function createGoalAssessmentTool(binding?: GoalAssessmentBinding): ToolDefinition {
  const preparing = binding?.phase === "preparing";
  const inputSchema = object({
    decision: { type: "string", enum: preparing ? ["ready", "waiting_user"] : ["continue", "complete", "waiting_user", "blocked"] },
    progress: textSchema,
    progressAssessment: object({ kind: { type: "string", enum: ["progress", "waiting", "no_progress"] },
      summary: textSchema, blockerKey: idSchema }, ["kind", "summary"]),
    evidence: array(textSchema, 32), evidenceRefs: array(evidenceSchema, 32),
    remainingWork: array(textSchema, 64), nextStep: textSchema, reason: textSchema, question: textSchema,
    ...(preparing ? { preparedRequirements: array(preparedSchema, 64, 1) } : {
      requirements: array(object({ requirementId: idSchema,
        status: { type: "string", enum: ["satisfied", "incomplete", "needs_user"] },
        evidenceRefs: array(evidenceSchema, 32), explanation: textSchema }), 64, 1),
      progressSignals: array(object({ requirementId: idSchema,
        kind: { type: "string", enum: ["requirement_satisfied", "artifact_changed", "external_terminal"] },
        evidenceRefs: array(evidenceSchema, 32, 1), subjectKey: idSchema }), 64),
      wait: object({ kind: { const: "external" }, targetRunId: idSchema, deadlineAt: { type: "integer", minimum: 1 } }),
    }),
  }, ["decision", "progress", "progressAssessment", "evidence", ...(preparing ? [] : ["requirements", "progressSignals"])]);
  return {
    name: GOAL_ASSESSMENT_TOOL_NAME,
    description: preparing
      ? "Define goal requirements or ask a necessary clarification. Execution tools are intentionally hidden in preparation; do not assess execution capability here. A successful submission ends this preparation Run."
      : "Submit an audit of every frozen goal requirement by requirementId, with evidence and candidate progress signals.",
    inputSchema,
    execution: { domain: "control_plane", supportedEnvironments: ["local", "wsl"] },
    async execute(input, context) {
      const reject = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });
      if (preparing && input?.decision === "blocked") return reject("准备阶段只整理完成条件，不能提交执行阻塞。执行工具在本阶段暂不展示，不能据此判定执行能力缺失。条件明确请提交 ready；只有缺少用户选择或定义条件所需材料时才提交 waiting_user。");
      if (!binding || !context.agent || !validSchema(input, inputSchema)) {
        return reject("Goal assessment is unavailable or invalid for this phase.");
      }
      const progressAssessment = input.progressAssessment as { kind: string; blockerKey?: string };
      if ((input.decision === "blocked" || progressAssessment.kind === "no_progress") && !progressAssessment.blockerKey) {
        return reject("A no-progress assessment requires a blocker key.");
      }
      if (preparing && input.decision === "ready" && !input.preparedRequirements) {
        return reject("Ready requires complete preparation candidates with sources.");
      }
      if (input.decision === "waiting_user" && !input.question) return reject("A user wait requires a question.");
      if (!preparing && progressAssessment.kind === "waiting" && input.decision !== "waiting_user" && !input.wait) {
        return reject("A waiting assessment requires a specific Run ID and deadline.");
      }
      if (!preparing) {
        const requirements = input.requirements as Array<{ requirementId: string }>;
        const ids = new Set(requirements.map(requirement => requirement.requirementId));
        if (ids.size !== requirements.length || (binding.requirementIds
          && (ids.size !== binding.requirementIds.length || binding.requirementIds.some(id => !ids.has(id))))) {
          return reject("The audit must cover each frozen requirement exactly once.");
        }
        const signals = input.progressSignals as Array<{ requirementId: string }> | undefined;
        if (signals?.some(signal => !ids.has(signal.requirementId))) return reject("Progress must refer to a frozen requirement.");
      }
      const refs = [
        ...(input.evidenceRefs as Record<string, unknown>[] | undefined ?? []),
        ...((input.requirements as Array<{ evidenceRefs: Record<string, unknown>[] }> | undefined ?? []).flatMap(item => item.evidenceRefs)),
        ...((input.progressSignals as Array<{ evidenceRefs: Record<string, unknown>[] }> | undefined ?? []).flatMap(item => item.evidenceRefs)),
      ];
      if (refs.some(ref => (ref.goalId !== undefined || ref.objectiveVersion !== undefined)
        && (ref.goalId !== binding.goalId || !Number.isSafeInteger(ref.objectiveVersion)
          || Number(ref.objectiveVersion) > binding.objectiveVersion || ref.runId === undefined))) {
        return reject("Evidence origins must retain a complete identity from this goal.");
      }
      if (refs.some(ref => {
        if (ref.revalidation === undefined) return false;
        const review = ref.revalidation as { messagePartIds: string[]; dependencies: Array<{ subjectKey: string }> };
        return new Set(review.messagePartIds).size !== review.messagePartIds.length
          || new Set(review.dependencies.map(dependency => dependency.subjectKey)).size !== review.dependencies.length;
      })) return reject("Current revalidation must use unique Part IDs and dependency subjects.");
      const wait = input.wait as { kind: "external"; targetRunId: string; deadlineAt: number } | undefined;
      if (!preparing && binding.reviewAssessment) {
        const feedback = await binding.reviewAssessment(input);
        if (feedback.issues.length) return { isError: true, failureKind: "precondition", executionState: "not_started",
          content: [{ type: "text", text: JSON.stringify({ kind: "goal_assessment_rejected", message: "Goal assessment rejected. Correct the references or coverage using existing results before rerunning tools.", ...feedback }) }] };
      }
      await context.agent.emit({ type: "domain.event", data: { name: "goal.assessment", payload: {
        ...input, evidenceRefs: input.evidenceRefs ?? [],
        goalId: binding.goalId, objectiveVersion: binding.objectiveVersion, runId: context.agent.scope.runId,
        ...(wait ? { wait: { ...wait, ownerRunId: context.agent.scope.runId,
          goalId: binding.goalId, objectiveVersion: binding.objectiveVersion } } : {}),
      } } });
      return { content: [{ type: "text", text: "Goal assessment recorded." }] };
    },
  };
}

// This small validator protects direct host calls too. No persistence or protocol imports.
function validSchema(value: unknown, schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema.oneOf)) return schema.oneOf.filter(branch => validSchema(value, branch)).length === 1;
  if ("const" in schema && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === "string") return typeof value === "string" && Boolean(value.trim())
    && value.length >= Number(schema.minLength ?? 0) && value.length <= Number(schema.maxLength ?? Infinity)
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
    && (typeof schema.pattern !== "string" || new RegExp(schema.pattern).test(value));
  if (schema.type === "integer") return Number.isSafeInteger(value) && Number(value) >= Number(schema.minimum ?? -Infinity);
  if (schema.type === "array") return Array.isArray(value) && value.length >= Number(schema.minItems ?? 0)
    && value.length <= Number(schema.maxItems ?? Infinity) && value.every(item => validSchema(item, schema.items as Record<string, unknown>));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    return (schema.required as string[]).every(key => Object.hasOwn(record, key))
      && Object.keys(record).every(key => Object.hasOwn(properties, key) && validSchema(record[key], properties[key]!));
  }
  return true;
}
