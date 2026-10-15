import type { AdmitPromptAttachmentInput } from "./session.js";
import type { SessionUserInputItem } from "./session-input-items.js";
import { parsePromptAttachments, parseSessionInputItems, ProtocolValidationError } from "./requests.js";

export type GoalStatus = "active" | "waiting_user" | "blocked" | "paused" | "completed" | "cancelled";
export type GoalPhase = "preparing" | "executing";
export type GoalChangeKind = "create" | "refine" | "pivot";
export type GoalUserActor = { kind: "local_user" } | { kind: "authenticated_user"; id: string };
export type GoalRequirementSource =
  | { kind: "input"; inputId: string; quote: string }
  | { kind: "document"; path: string; digest: string; quote: string; evidencePartId: string };
export interface GoalRequirement {
  id: string;
  text: string;
  source: GoalRequirementSource[];
  verification:
    | { kind: "check"; method: string; command?: string; commandPolicy?: "suggested" | "required"; environment: string; expected: string }
    | { kind: "artifact_review"; artifact: string; standard: string }
    | { kind: "user_acceptance"; question: string };
  constraints: string[];
  replaces?: string[];
}
export type PreparedGoalRequirement = Omit<GoalRequirement, "id" | "replaces"> & { previousRequirementId?: string };
export interface GoalVersion {
  goalId: string; objectiveVersion: number; previousVersion?: number;
  objective: string; requirements: GoalRequirement[]; frozenAt?: number;
  changeKind: GoalChangeKind; changeReason: string;
  requestId: string; actor: GoalUserActor; inputIds: string[]; createdAt: number;
}
export interface PreparationEpisode {
  episodeId: string; goalId: string; objectiveVersion: number;
  inputIds: string[]; modelAttempts: number; readToolCalls: number;
  runId?: string; readyRunId?: string;
  state: "accepted" | "running" | "waiting_user" | "ready" | "stopped";
}
export interface GoalUserAcceptanceReceipt {
  requestId: string; inputId: string; actor: GoalUserActor; at: number;
  questionId: string; objectiveVersion: number; requirementIds: string[];
}

export type GoalAction = "pause" | "resume" | "cancel" | "confirm" | "budget";

export interface GoalUsage {
  knownTokens: number;
  incomplete: boolean;
  unknownAttempts: number;
  partialAttempts: number;
  inFlightAttempts: number;
  runTimeMs: number;
  seq: number;
  updatedAt: number;
}

export interface GoalModelAttemptKey {
  runId: string;
  generationId: string;
  attempt: number;
}

export interface GoalStopReason {
  code: "user_paused" | "user_cancelled" | "updating_objective" | "auto_turn_limit"
    | "run_error" | "assessment_invalid" | "wait_invalid" | "wait_timeout"
    | "external_failed" | "no_progress" | "startup_recovery" | "token_budget"
    | "usage_unknown" | "provider_limit" | "preparation_incomplete";
  at: number;
  runId?: string;
  detail?: string;
}

export interface GoalExternalWait {
  kind: "external";
  targetRunId: string;
  ownerRunId: string;
  goalId: string;
  objectiveVersion: number;
  deadlineAt: number;
  observedStatus?: "pending" | "running" | "completed" | "failed" | "interrupted";
}

export type GoalWait =
  | {
      kind: "user";
      questionId: string;
      question: string;
      purpose: "clarification" | "acceptance";
      objectiveVersion: number;
      requirementIds?: string[];
      replyInputId?: string;
    }
  | { kind: "approval"; permissionRequestId: string }
  | GoalExternalWait;

export interface GoalEvidenceRef {
  goalId: string;
  objectiveVersion: number;
  runId: string;
  messagePartId: string;
  criterion: string;
  revalidation?: {
    messagePartIds: string[]; environmentKey: string; command?: string; expected?: string;
    dependencies: Array<{ subjectKey: string; digest: string }>;
  };
}

export interface GoalRequirementAssessment {
  requirementId: string;
  explanation: string;
  status: "satisfied" | "incomplete" | "needs_user";
  evidenceRefs: GoalEvidenceRef[];
}
export interface GoalProgressSignal {
  requirementId: string;
  kind: "requirement_satisfied" | "artifact_changed" | "external_terminal";
  evidenceRefs: GoalEvidenceRef[];
  subjectKey: string;
}
export type VerifiedGoalProgressSignal = {
  requirementId: string; subjectKey: string;
  origins: Array<Pick<GoalEvidenceRef, "goalId" | "objectiveVersion" | "runId" | "messagePartId">>;
} & (
  | { kind: "requirement_satisfied"; from: "incomplete"; to: "satisfied" }
  | { kind: "artifact_changed"; beforeDigest: string; afterDigest: string }
  | { kind: "external_terminal"; waitOwnerRunId: string; targetRunId: string; observedStatus: "pending" | "running";
      terminalStatus: "completed" | "failed" | "interrupted"; resultPartId: string }
);
export interface GoalHostProgress {
  verifiedSignals: VerifiedGoalProgressSignal[];
  stagnationCount: number; noProgressCount: number;
}
export interface GoalHostEvidence {
  requirementId: string;
  origin: Pick<GoalEvidenceRef, "goalId" | "objectiveVersion" | "runId" | "messagePartId">;
  verifiedForVersion: number;
  supportsCompletion?: boolean;
  facts: {
    environmentKey?: string; command?: string; expected?: string;
    artifacts?: Array<{ subjectKey: string; beforeDigest?: string; afterDigest: string }>;
    external?: { waitOwnerRunId: string; targetRunId: string;
      observedStatus: "pending" | "running" | "completed" | "failed" | "interrupted";
      status: "completed" | "failed" | "interrupted"; resultPartId: string };
  };
}

export interface GoalProgressAssessment {
  kind: "progress" | "waiting" | "no_progress";
  summary: string;
  blockerKey?: string;
}

export interface SessionGoal {
  id: string;
  sessionId: string;
  objective: string;
  objectiveVersion: number;
  phase: GoalPhase;
  requirements: GoalRequirement[];
  preparationEpisodeId?: string;
  versionSummary?: Pick<GoalVersion, "changeKind" | "changeReason" | "createdAt">;
  pluginId?: string;
  revision: number;
  status: GoalStatus;
  maxAutoTurns: number;
  tokenBudget?: number;
  usage: GoalUsage;
  autoTurnsUsed: number;
  noProgressCount: number;
  stagnationCount: number;
  blockerKey?: string;
  currentRunId?: string;
  reason?: string;
  stopReason?: GoalStopReason;
  wait?: GoalWait;
  evidence: string[];
  assessment?: GoalAssessment;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionGoalInput {
  requestId: string;
  objective: string;
  maxAutoTurns?: number;
  tokenBudget?: number;
  items?: SessionUserInputItem[];
  attachments?: AdmitPromptAttachmentInput[];
}

export interface UpdateSessionGoalInput {
  requestId: string;
  expectedRevision: number;
  objective: string;
  changeKind: "refine" | "pivot";
  changeReason: string;
  replaceRequirementIds?: string[];
  items?: SessionUserInputItem[];
  attachments?: AdmitPromptAttachmentInput[];
}

export interface GoalActionInput {
  requestId: string;
  expectedRevision: number;
  action: GoalAction;
  tokenBudget?: number | null;
  additionalAutoTurns?: number;
  questionId?: string;
  response?: string;
  objectiveVersion?: number;
  reprepare?: boolean;
}

export interface GoalAssessment {
  goalId: string;
  objectiveVersion: number;
  runId: string;
  decision: "ready" | "continue" | "complete" | "waiting_user" | "blocked";
  progress: string;
  progressAssessment: GoalProgressAssessment;
  evidence: string[];
  evidenceRefs: GoalEvidenceRef[];
  requirements?: GoalRequirementAssessment[];
  preparedRequirements?: PreparedGoalRequirement[];
  progressSignals?: GoalProgressSignal[];
  hostProgress?: GoalHostProgress;
  hostEvidence?: GoalHostEvidence[];
  hostDiagnostics?: Array<{
    origin: Pick<GoalEvidenceRef, "goalId" | "objectiveVersion" | "runId" | "messagePartId">;
    kind: "tool_error" | "run_error" | "unavailable_resource"; summary: string;
  }>;
  userReceipts?: GoalUserAcceptanceReceipt[];
  remainingWork?: string[];
  nextStep?: string;
  reason?: string;
  wait?: GoalWait;
}

/** Zero means no automatic-turn limit. */
export const DEFAULT_GOAL_AUTO_TURNS = 0;
export const MAX_GOAL_AUTO_TURNS = 1_000;
export const MAX_GOAL_OBJECTIVE_CHARS = 32_000;

export function parseCreateSessionGoalInput(value: unknown): CreateSessionGoalInput {
  const record = goalRecord(value);
  rejectGoalFields(record, ["actor", "origin"]);
  return {
    requestId: requiredGoalString(record.requestId, "requestId", 128),
    objective: requiredGoalString(record.objective, "objective", MAX_GOAL_OBJECTIVE_CHARS),
    ...(record.tokenBudget === undefined ? {} : { tokenBudget: goalPositiveTimestamp(record.tokenBudget, "tokenBudget") }),
    ...(record.maxAutoTurns === undefined
      ? {}
      : {
          maxAutoTurns: goalPositiveInteger(record.maxAutoTurns, "maxAutoTurns", true),
        }),
    ...parseGoalContent(record),
  };
}

export function parseUpdateSessionGoalInput(value: unknown): UpdateSessionGoalInput {
  const record = goalRecord(value);
  rejectGoalFields(record, ["actor", "origin"]);
  if (record.changeKind !== "refine" && record.changeKind !== "pivot") throw new ProtocolValidationError("invalid_goal_change_kind", "changeKind");
  return {
    requestId: requiredGoalString(record.requestId, "requestId", 128),
    expectedRevision: goalNonNegativeInteger(record.expectedRevision, "expectedRevision"),
    objective: requiredGoalString(record.objective, "objective", MAX_GOAL_OBJECTIVE_CHARS),
    changeKind: record.changeKind,
    changeReason: requiredGoalString(record.changeReason, "changeReason", 4000),
    ...(record.replaceRequirementIds === undefined ? {} : { replaceRequirementIds: parseGoalIdentifierArray(record.replaceRequirementIds, "replaceRequirementIds") }),
    ...parseGoalContent(record),
  };
}

export function parseGoalActionInput(value: unknown): GoalActionInput {
  const record = goalRecord(value);
  if (record.action !== "pause" && record.action !== "resume" && record.action !== "cancel" && record.action !== "confirm" && record.action !== "budget") {
    throw new ProtocolValidationError("invalid_goal_action", "action");
  }
  if (record.action === "budget") {
    const fields = new Set(["requestId", "expectedRevision", "action", "tokenBudget"]);
    if (Object.keys(record).some(key => !fields.has(key))) throw new ProtocolValidationError("Budget action accepts only tokenBudget", "action");
    return {
      requestId: requiredGoalString(record.requestId, "requestId", 128),
      expectedRevision: goalNonNegativeInteger(record.expectedRevision, "expectedRevision"),
      action: "budget",
      tokenBudget: record.tokenBudget === null ? null : goalPositiveTimestamp(record.tokenBudget, "tokenBudget"),
    };
  }
  if (Object.hasOwn(record, "tokenBudget")) throw new ProtocolValidationError("Only budget accepts tokenBudget", "tokenBudget");
  rejectGoalFields(record, ["actor", "origin"]);
  if (record.reprepare !== undefined && (record.action !== "resume" || typeof record.reprepare !== "boolean")) throw new ProtocolValidationError("invalid_goal_reprepare", "reprepare");
  if (record.action !== "resume" && (record.additionalAutoTurns !== undefined || record.response !== undefined)) {
    throw new ProtocolValidationError("Only resume accepts additionalAutoTurns or response", "action");
  }
  if (record.action === "confirm") requiredGoalString(record.questionId, "questionId", 256);
  if (record.action === "confirm" || record.questionId !== undefined) {
    goalPositiveTimestamp(record.objectiveVersion, "objectiveVersion");
    requiredGoalString(record.questionId, "questionId", 256);
  } else if (record.objectiveVersion !== undefined) throw new ProtocolValidationError("goal_version_requires_answer", "objectiveVersion");
  if ((record.action === "pause" || record.action === "cancel") && record.questionId !== undefined) {
    throw new ProtocolValidationError("This action does not answer a question", "questionId");
  }
  return {
    requestId: requiredGoalString(record.requestId, "requestId", 128),
    expectedRevision: goalNonNegativeInteger(record.expectedRevision, "expectedRevision"),
    action: record.action,
    ...(record.objectiveVersion === undefined ? {} : { objectiveVersion: goalPositiveTimestamp(record.objectiveVersion, "objectiveVersion") }),
    ...(record.reprepare === undefined ? {} : { reprepare: record.reprepare }),
    ...(record.questionId === undefined
      ? {}
      : {
          questionId: requiredGoalString(record.questionId, "questionId", 256),
        }),
    ...(record.response === undefined
      ? {}
      : {
          response: requiredGoalString(record.response, "response", MAX_GOAL_OBJECTIVE_CHARS),
        }),
    ...(record.additionalAutoTurns === undefined
      ? {}
      : {
          additionalAutoTurns: goalPositiveInteger(record.additionalAutoTurns, "additionalAutoTurns"),
        }),
  };
}

function goalRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolValidationError("invalid_goal_input", "goal");
  return value as Record<string, unknown>;
}

function requiredGoalString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
  const normalized = value.trim();
  if (normalized.length > max) throw new ProtocolValidationError(`goal_${field}_limit_exceeded`, field);
  return normalized;
}

function goalNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
  return value as number;
}

function goalPositiveInteger(value: unknown, field: string, allowUnlimited = false): number {
  const integer = goalNonNegativeInteger(value, field);
  if (integer < (allowUnlimited ? 0 : 1) || integer > MAX_GOAL_AUTO_TURNS) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
  return integer;
}
function parseGoalContent(record: Record<string, unknown>): Pick<CreateSessionGoalInput, "items" | "attachments"> {
  return {
    ...(record.items === undefined ? {} : { items: parseSessionInputItems(record.items) }),
    ...(record.attachments === undefined ? {} : { attachments: parsePromptAttachments(record.attachments) }),
  };
}

export type GoalAssessmentBinding = Pick<GoalAssessment, "goalId" | "objectiveVersion" | "runId"> & {
  phase?: GoalPhase; requirements?: GoalRequirement[];
};

/** Outer identity and phase come from the host. Explicit evidence origins remain intact. */
export function parseGoalAssessment(value: unknown, binding: GoalAssessmentBinding): GoalAssessment {
  const record = goalRecord(value);
  rejectGoalFields(record, ["hostProgress", "hostDiagnostics", "hostEvidence", "userReceipts", "receipt", "actor", "origin"]);
  const phase = binding.phase ?? "executing";
  const decision = record.decision;
  if (phase === "preparing"
    ? decision !== "ready" && decision !== "waiting_user"
    : decision !== "continue" && decision !== "complete" && decision !== "waiting_user" && decision !== "blocked") {
    throw new ProtocolValidationError("invalid_goal_decision", "decision");
  }
  if (!Array.isArray(record.evidence) || record.evidence.length > 32) throw new ProtocolValidationError("invalid_goal_evidence", "evidence");
  const refs = parseGoalEvidenceRefs(record.evidenceRefs ?? [], binding);
  const savedWait = record.wait && typeof record.wait === "object" && !Array.isArray(record.wait) ? (record.wait as Record<string, unknown>) : undefined;
  const questionValue = record.question ?? (savedWait?.kind === "user" ? savedWait.question : undefined);
  const question = questionValue === undefined ? undefined : requiredGoalString(questionValue, "question", 4000);
  const progressAssessment = parseGoalProgressAssessment(record.progressAssessment);
  if ((decision === "blocked" || progressAssessment.kind === "no_progress") && !progressAssessment.blockerKey) {
    throw new ProtocolValidationError("goal_no_progress_requires_blocker_key", "progressAssessment");
  }
  if (phase === "preparing") rejectGoalFields(record, ["requirements", "progressSignals"]);
  else rejectGoalFields(record, ["preparedRequirements"]);
  const preparedRequirements = phase === "preparing" && record.preparedRequirements !== undefined
    ? parsePreparedGoalRequirements(record.preparedRequirements) : undefined;
  if (decision === "ready" && !preparedRequirements?.length) throw new ProtocolValidationError("goal_ready_requires_requirements", "preparedRequirements");
  const requirements = phase === "executing" ? parseGoalRequirements(record.requirements, binding) : undefined;
  const progressSignals = phase === "executing" ? parseGoalProgressSignals(record.progressSignals, binding, requirements!) : undefined;
  const remainingWork = parseGoalTextArray(record.remainingWork, "remainingWork");
  if (decision === "complete") {
    if (!requirements?.length) throw new ProtocolValidationError("goal_complete_requires_requirements", "requirements");
  }
  const externalWait =
    progressAssessment.kind === "waiting" && savedWait?.kind === "external"
      ? {
          kind: "external" as const,
          targetRunId: requiredGoalString(savedWait.targetRunId, "targetRunId", 256),
          ownerRunId: binding.runId,
          goalId: binding.goalId,
          objectiveVersion: binding.objectiveVersion,
          deadlineAt: goalPositiveTimestamp(savedWait.deadlineAt, "deadlineAt"),
        }
      : undefined;
  if (phase === "preparing" && savedWait?.kind === "external") throw new ProtocolValidationError("goal_preparation_external_wait_invalid", "wait");
  return {
    goalId: binding.goalId, objectiveVersion: binding.objectiveVersion, runId: binding.runId,
    decision: decision as GoalAssessment["decision"],
    progress: requiredGoalString(record.progress, "progress", 4000),
    progressAssessment,
    evidence: record.evidence.map((text) => requiredGoalString(text, "evidence", 4000)),
    evidenceRefs: refs,
    ...(requirements === undefined ? {} : { requirements }),
    ...(preparedRequirements === undefined ? {} : { preparedRequirements }),
    ...(progressSignals === undefined ? {} : { progressSignals }),
    ...(remainingWork === undefined ? {} : { remainingWork }),
    ...(record.nextStep === undefined ? {} : { nextStep: requiredGoalString(record.nextStep, "nextStep", 4000) }),
    ...(record.reason === undefined ? {} : { reason: requiredGoalString(record.reason, "reason", 4000) }),
    ...(externalWait ? { wait: externalWait } : {}),
    ...(decision === "waiting_user"
      ? {
          wait: {
            kind: "user" as const,
            questionId: `goal-question-${binding.runId}`,
            question: question ?? "请补充继续目标所需的信息。",
            purpose: "clarification" as const,
            objectiveVersion: binding.objectiveVersion,
          },
        }
      : {}),
  };
}

function goalPositiveTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
  return value as number;
}

function parseGoalProgressAssessment(value: unknown): GoalProgressAssessment {
  const record = goalRecord(value);
  if (record.kind !== "progress" && record.kind !== "waiting" && record.kind !== "no_progress") {
    throw new ProtocolValidationError("invalid_goal_progress_kind", "progressAssessment");
  }
  return {
    kind: record.kind,
    summary: requiredGoalString(record.summary, "progressSummary", 4000),
    ...(record.blockerKey === undefined
      ? {}
      : {
          blockerKey: requiredGoalString(record.blockerKey, "blockerKey", 256),
        }),
  };
}

function parseGoalTextArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
  return value.map((item) => requiredGoalString(item, field, 4000));
}

function parseGoalRequirements(value: unknown, binding: GoalAssessmentBinding): GoalRequirementAssessment[] {
  if (!Array.isArray(value) || value.length > 64) throw new ProtocolValidationError("invalid_goal_requirements", "requirements");
  const requirements = value.map((item) => {
    const record = goalRecord(item);
    rejectGoalFields(record, ["requirement", "source", "text", "verification"]);
    if (record.status !== "satisfied" && record.status !== "incomplete" && record.status !== "needs_user") {
      throw new ProtocolValidationError("invalid_goal_requirement_status", "requirements");
    }
    return {
      requirementId: requiredGoalString(record.requirementId, "requirementId", 256),
      explanation: requiredGoalString(record.explanation, "explanation", 4000),
      status: record.status,
      evidenceRefs: parseGoalEvidenceRefs(record.evidenceRefs ?? [], binding),
    } satisfies GoalRequirementAssessment;
  });
  const ids = new Set(requirements.map(item => item.requirementId));
  if (ids.size !== requirements.length || (binding.requirements && (ids.size !== binding.requirements.length || binding.requirements.some(item => !ids.has(item.id))))) {
    throw new ProtocolValidationError("goal_assessment_requirement_coverage_invalid", "requirements");
  }
  return requirements;
}

function rejectGoalFields(record: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) if (Object.hasOwn(record, field)) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
}

function parseGoalIdentifierArray(value: unknown, field: string, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
  const ids = value.map(item => requiredGoalString(item, field, 256));
  if (new Set(ids).size !== ids.length) throw new ProtocolValidationError(`invalid_goal_${field}`, field);
  return ids;
}

function parseGoalDigest(value: unknown): string {
  if (typeof value !== "string" || (value !== "missing" && !/^sha256:[a-f0-9]{64}$/.test(value))) throw new ProtocolValidationError("invalid_goal_digest", "digest");
  return value;
}

function parseGoalEvidenceRefs(value: unknown, binding: GoalAssessmentBinding): GoalEvidenceRef[] {
  if (!Array.isArray(value) || value.length > 32) throw new ProtocolValidationError("invalid_goal_evidence_refs", "evidenceRefs");
  return value.map(item => {
    const ref = goalRecord(item);
    const explicit = ref.goalId !== undefined || ref.objectiveVersion !== undefined;
    // runId alone may identify a trusted current descendant; the evidence reader verifies membership.
    const goalId = explicit ? requiredGoalString(ref.goalId, "goalId", 256) : binding.goalId;
    const objectiveVersion = explicit ? goalPositiveTimestamp(ref.objectiveVersion, "objectiveVersion") : binding.objectiveVersion;
    const runId = ref.runId === undefined ? binding.runId : requiredGoalString(ref.runId, "runId", 256);
    if (goalId !== binding.goalId || objectiveVersion > binding.objectiveVersion || (explicit && ref.runId === undefined)) throw new ProtocolValidationError("invalid_goal_evidence_origin", "evidenceRefs");
    let revalidation: GoalEvidenceRef["revalidation"];
    if (ref.revalidation !== undefined) {
      const review = goalRecord(ref.revalidation);
      if (!Array.isArray(review.dependencies) || review.dependencies.length > 64) throw new ProtocolValidationError("invalid_goal_dependencies", "revalidation");
      revalidation = {
        messagePartIds: parseGoalIdentifierArray(review.messagePartIds, "messagePartIds", 32),
        environmentKey: requiredGoalString(review.environmentKey, "environmentKey", 256),
        ...(review.command === undefined ? {} : { command: requiredGoalString(review.command, "command", 4000) }),
        ...(review.expected === undefined ? {} : { expected: requiredGoalString(review.expected, "expected", 4000) }),
        dependencies: review.dependencies.map(item => { const dependency = goalRecord(item); return {
          subjectKey: requiredGoalString(dependency.subjectKey, "subjectKey", 256), digest: parseGoalDigest(dependency.digest),
        }; }),
      };
      if (!revalidation.messagePartIds.length || new Set(revalidation.dependencies.map(item => item.subjectKey)).size !== revalidation.dependencies.length) {
        throw new ProtocolValidationError("invalid_goal_revalidation", "revalidation");
      }
    }
    return { goalId, objectiveVersion, runId, messagePartId: requiredGoalString(ref.messagePartId, "messagePartId", 256),
      criterion: requiredGoalString(ref.criterion, "criterion", 4000), ...(revalidation ? { revalidation } : {}) };
  });
}

function parseGoalProgressSignals(value: unknown, binding: GoalAssessmentBinding, requirements: GoalRequirementAssessment[]): GoalProgressSignal[] {
  if (!Array.isArray(value) || value.length > 64) throw new ProtocolValidationError("invalid_goal_progress_signals", "progressSignals");
  const ids = new Set(requirements.map(item => item.requirementId));
  return value.map(item => {
    const signal = goalRecord(item);
    if (signal.kind !== "requirement_satisfied" && signal.kind !== "artifact_changed" && signal.kind !== "external_terminal") throw new ProtocolValidationError("invalid_goal_progress_signal_kind", "progressSignals");
    const requirementId = requiredGoalString(signal.requirementId, "requirementId", 256);
    if (!ids.has(requirementId)) throw new ProtocolValidationError("invalid_goal_progress_requirement", "progressSignals");
    return { requirementId, kind: signal.kind, subjectKey: requiredGoalString(signal.subjectKey, "subjectKey", 256), evidenceRefs: parseGoalEvidenceRefs(signal.evidenceRefs, binding) };
  });
}

export function parsePreparedGoalRequirements(value: unknown): PreparedGoalRequirement[] {
  if (!Array.isArray(value) || value.length > 64) throw new ProtocolValidationError("invalid_goal_prepared_requirements", "preparedRequirements");
  return value.map(item => {
    const record = goalRecord(item);
    rejectGoalFields(record, ["id", "replaces"]);
    if (!Array.isArray(record.source) || !record.source.length || record.source.length > 32) throw new ProtocolValidationError("invalid_goal_requirement_source", "source");
    const source: GoalRequirementSource[] = record.source.map(item => {
      const source = goalRecord(item);
      if (source.kind === "input") return { kind: "input", inputId: requiredGoalString(source.inputId, "inputId", 256), quote: requiredGoalString(source.quote, "quote", 4000) };
      if (source.kind === "document") {
        const digest = parseGoalDigest(source.digest);
        if (digest === "missing") throw new ProtocolValidationError("invalid_goal_document_digest", "digest");
        return { kind: "document", path: requiredGoalString(source.path, "path", 4000), digest,
          quote: requiredGoalString(source.quote, "quote", 4000), evidencePartId: requiredGoalString(source.evidencePartId, "evidencePartId", 256) };
      }
      throw new ProtocolValidationError("invalid_goal_requirement_source", "source");
    });
    const raw = goalRecord(record.verification);
    if (raw.commandPolicy !== undefined && (raw.kind !== "check" || raw.commandPolicy !== "suggested" && raw.commandPolicy !== "required"
      || raw.commandPolicy === "required" && raw.command === undefined)) throw new ProtocolValidationError("invalid_goal_command_policy", "commandPolicy");
    let verification: GoalRequirement["verification"];
    if (raw.kind === "check") verification = { kind: "check", method: requiredGoalString(raw.method, "method", 4000),
      environment: requiredGoalString(raw.environment, "environment", 4000), expected: requiredGoalString(raw.expected, "expected", 4000),
      ...(raw.command === undefined ? {} : { command: requiredGoalString(raw.command, "command", 4000) }),
      ...(raw.commandPolicy === undefined ? {} : { commandPolicy: raw.commandPolicy as "suggested" | "required" }) };
    else if (raw.kind === "artifact_review") verification = { kind: "artifact_review", artifact: requiredGoalString(raw.artifact, "artifact", 4000), standard: requiredGoalString(raw.standard, "standard", 4000) };
    else if (raw.kind === "user_acceptance") verification = { kind: "user_acceptance", question: requiredGoalString(raw.question, "question", 4000) };
    else throw new ProtocolValidationError("invalid_goal_verification", "verification");
    const constraints = parseGoalTextArray(record.constraints, "constraints");
    if (!constraints) throw new ProtocolValidationError("invalid_goal_constraints", "constraints");
    return { text: requiredGoalString(record.text, "text", 4000), source, verification, constraints,
      ...(record.previousRequirementId === undefined ? {} : { previousRequirementId: requiredGoalString(record.previousRequirementId, "previousRequirementId", 256) }) };
  });
}
