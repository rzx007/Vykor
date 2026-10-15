import { validHostFileFacts } from "@vykor/core";
import { posix, win32 } from "node:path";
import type { GoalAssessment, GoalEvidenceRef, GoalRequirement, GoalVersion, SessionGoal, SessionMessagePartRecord, SessionMessageRecord, SessionRunRecord } from "@vykor/protocol";

export interface GoalEvidenceReaderContext {
  conversations: {
    listMessages(sessionId: string): SessionMessageRecord[];
    listMessageParts(sessionId: string): SessionMessagePartRecord[];
  };
  runs: {
    getRun(runId: string): SessionRunRecord | undefined;
    listGoalRuns?(goalId: string, objectiveVersion?: number): SessionRunRecord[];
  };
  goals: { getGoalVersion(goalId: string, objectiveVersion: number): GoalVersion | undefined };
}
export interface VerifiedGoalEvidence {
  requirementId: string;
  origin: Pick<GoalEvidenceRef, "goalId" | "objectiveVersion" | "runId" | "messagePartId">;
  verifiedForVersion: number;
  /** File changes can advance a check without proving the check passed. */
  supportsCompletion?: boolean;
  facts: {
    environmentKey?: string; command?: string; expected?: string;
    artifacts?: Array<{ subjectKey: string; beforeDigest?: string; afterDigest: string }>;
    external?: {
      waitOwnerRunId: string; targetRunId: string;
      observedStatus: "pending" | "running" | "completed" | "failed" | "interrupted";
      status: "completed" | "failed" | "interrupted"; resultPartId: string;
    };
  };
}
export interface VerifiedGoalDiagnostic {
  origin: VerifiedGoalEvidence["origin"];
  kind: "tool_error" | "run_error" | "unavailable_resource";
  summary: string;
}

function origin(ref: GoalEvidenceRef): VerifiedGoalEvidence["origin"] {
  return { goalId: ref.goalId, objectiveVersion: ref.objectiveVersion, runId: ref.runId, messagePartId: ref.messagePartId };
}
function bound(run: SessionRunRecord | undefined, goalId: string, version: number): run is SessionRunRecord {
  return Boolean(run && run.metadata.goalId === goalId && run.metadata.goalObjectiveVersion === version);
}
function terminal(run: SessionRunRecord): boolean {
  return ["completed", "failed", "interrupted"].includes(run.status);
}
function descendant(context: GoalEvidenceReaderContext, source: SessionRunRecord, root: SessionRunRecord): boolean {
  const visited = new Set<string>();
  let current = source;
  while (current.id !== root.id) {
    if (visited.has(current.id) || visited.size >= 128 || !bound(current, String(root.metadata.goalId), Number(root.metadata.goalObjectiveVersion))) return false;
    visited.add(current.id);
    const parentId = current.metadata.parentRunId;
    if (typeof parentId !== "string") return false;
    const parent = context.runs.getRun(parentId);
    if (!bound(parent, String(root.metadata.goalId), Number(root.metadata.goalObjectiveVersion))) return false;
    current = parent;
  }
  return true;
}
function lookupPart(context: GoalEvidenceReaderContext, run: SessionRunRecord, partId: string): SessionMessagePartRecord | undefined {
  const part = context.conversations.listMessageParts(run.sessionId).find(item => item.id === partId);
  if (!part || part.sessionId !== run.sessionId) return undefined;
  const message = context.conversations.listMessages(run.sessionId).find(item => item.id === part.messageId);
  return message?.runId === run.id ? part : undefined;
}
function rootFor(context: GoalEvidenceReaderContext, goal: SessionGoal, assessment: GoalAssessment, preview = false): SessionRunRecord | undefined {
  const root = context.runs.getRun(assessment.runId);
  return assessment.goalId === goal.id && assessment.objectiveVersion === goal.objectiveVersion
    && bound(root, goal.id, goal.objectiveVersion) && root.sessionId === goal.sessionId && !root.metadata.parentRunId
    && (terminal(root) || preview && root.status === "running" && goal.status === "active" && goal.currentRunId === root.id) ? root : undefined;
}
function readSource(context: GoalEvidenceReaderContext, goal: SessionGoal, root: SessionRunRecord, ref: GoalEvidenceRef, preview = false, allowRejection = false) {
  if (ref.goalId !== goal.id || ref.objectiveVersion > goal.objectiveVersion || ref.objectiveVersion < 1) return undefined;
  const run = context.runs.getRun(ref.runId);
  if (!bound(run, goal.id, ref.objectiveVersion) || !(terminal(run) || preview && run.id === root.id && run.status === "running")) return undefined;
  const historical = ref.objectiveVersion !== goal.objectiveVersion || !descendant(context, run, root);
  if (historical) {
    const version = context.goals.getGoalVersion(goal.id, ref.objectiveVersion);
    if (!version || version.goalId !== goal.id || version.frozenAt === undefined || !ref.revalidation) return undefined;
  }
  const part = lookupPart(context, run, ref.messagePartId);
  if (!part || !["completed", "failed"].includes(part.status) || part.toolName === "GoalRead" || part.toolName === "GoalAssessment" && !allowRejection) return undefined;
  return { run, part, historical };
}
function successful(part: SessionMessagePartRecord): boolean {
  return part.type === "tool" && part.status === "completed" && !part.isError && part.output != null && part.metadata.executionState === "completed";
}
function artifactFiles(artifact: string, receipt: NonNullable<ReturnType<typeof validHostFileFacts>>) {
  const pathApi = receipt.pathStyle === "windows" || /^[a-zA-Z]:[\\/]/.test(artifact) ? win32 : posix;
  const normalize = (path: string) => pathApi === win32 ? pathApi.normalize(path).toLowerCase() : pathApi.normalize(path);
  const path = pathApi.isAbsolute(artifact) ? normalize(artifact) : receipt.executionRoot ? normalize(pathApi.resolve(receipt.executionRoot, artifact)) : undefined;
  return { path, matching: receipt.files.filter(file => normalize(file.path) === path) };
}
function expectedToolResult(part: SessionMessagePartRecord, verification: Extract<GoalRequirement["verification"], { kind: "tool_result" }>): boolean {
  if (part.toolName !== verification.toolName) return false;
  if (verification.outcome === "success") return !["GoalRead", "GoalAssessment"].includes(verification.toolName) && successful(part);
  // Only host-produced GoalAssessment rejections can prove this negative test.
  if (verification.toolName !== "GoalAssessment" || part.type !== "tool" || part.status !== "failed" || !part.isError) return false;
  const output = part.output as { failureKind?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (output?.failureKind !== "precondition" || !Array.isArray(output.content)) return false;
  return output.content.some(block => {
    if (block.type !== "text" || !block.text) return false;
    try {
      const feedback = JSON.parse(block.text);
      return feedback?.kind === "goal_assessment_rejected" && Array.isArray(feedback.evidenceIssues)
        && feedback.evidenceIssues.some((issue: { code?: string }) => issue?.code === verification.rejectionCode);
    } catch { return false; }
  });
}
function refsByRequirement(assessment: GoalAssessment): Array<{ requirementId: string; ref: GoalEvidenceRef }> {
  const values = [
    ...(assessment.requirements ?? []).flatMap(item => item.evidenceRefs.map(ref => ({ requirementId: item.requirementId, ref }))),
    ...(assessment.progressSignals ?? []).flatMap(item => item.evidenceRefs.map(ref => ({ requirementId: item.requirementId, ref }))),
  ];
  return [...new Map(values.map(value => [`${value.requirementId}\0${value.ref.runId}\0${value.ref.messagePartId}`, value])).values()];
}
function sameVerification(left: GoalRequirement, right: GoalRequirement): boolean {
  return JSON.stringify(left.verification) === JSON.stringify(right.verification) && JSON.stringify(left.constraints) === JSON.stringify(right.constraints);
}

/** Creation order within one tool batch cannot prove completion order. */
function artifactObservationStillCurrent(
  context: GoalEvidenceReaderContext, goal: SessionGoal, root: SessionRunRecord,
  sourceRun: SessionRunRecord, sourcePart: SessionMessagePartRecord,
  environmentKey: string, subjectKey: string, digest: string,
): boolean {
  // Completed tool results can invalidate an observation before their Run ends.
  const runs = [...new Map([root, sourceRun, ...(context.runs.listGoalRuns?.(goal.id, goal.objectiveVersion) ?? [])]
    .filter(run => bound(run, goal.id, goal.objectiveVersion) && (run.id === sourceRun.id || descendant(context, run, root)))
    .map(run => [run.id, run])).values()];
  for (const run of runs) {
    const messages = context.conversations.listMessages(run.sessionId);
    for (const part of context.conversations.listMessageParts(run.sessionId)) {
      const message = messages.find(item => item.id === part.messageId);
      if (message?.runId !== run.id || part.id === sourcePart.id || !successful(part)) continue;
      const receipt = validHostFileFacts(part.metadata.hostFileFacts);
      if (receipt?.environmentKey !== environmentKey || !receipt.files.some(file => file.subjectKey === subjectKey && file.afterDigest !== digest)) continue;
      const sourceMessage = run.id === sourceRun.id ? messages.find(item => item.id === sourcePart.messageId) : undefined;
      const candidateGeneration = part.metadata.modelGeneration as { generationId?: string; committed?: boolean; superseded?: boolean } | undefined;
      const sourceGeneration = sourcePart.metadata.modelGeneration as typeof candidateGeneration;
      // Different committed model turns of one Run are sequential. Same-turn tools may overlap.
      const definitelyEarlier = sourceMessage && message.id !== sourceMessage.id && Number.isSafeInteger(message.seq)
        && Number.isSafeInteger(sourceMessage.seq) && message.seq < sourceMessage.seq
        && candidateGeneration?.committed === true && sourceGeneration?.committed === true
        && !candidateGeneration.superseded && !sourceGeneration.superseded
        && typeof candidateGeneration.generationId === "string" && typeof sourceGeneration.generationId === "string"
        && candidateGeneration.generationId !== sourceGeneration.generationId;
      if (!definitelyEarlier) return false;
    }
  }
  return true;
}

/** Historical checks without a host-recorded complete dependency set are deliberately not reusable. */
function historicalArtifactValid(context: GoalEvidenceReaderContext, goal: SessionGoal, root: SessionRunRecord, ref: GoalEvidenceRef, requirement: GoalRequirement, part: SessionMessagePartRecord, preview = false): boolean {
  const review = ref.revalidation;
  const facts = validHostFileFacts(part.metadata.hostFileFacts);
  const previous = context.goals.getGoalVersion(goal.id, ref.objectiveVersion)?.requirements.find(item => item.id === requirement.id);
  if (requirement.verification.kind !== "artifact_review" || !previous || !sameVerification(previous, requirement) || !review || !facts
    || review.environmentKey !== facts.environmentKey || !review.messagePartIds.length
    || review.command !== undefined || review.expected !== undefined) return false;
  const original = facts.files;
  if (review.dependencies.length !== original.length || new Set(review.dependencies.map(item => item.subjectKey)).size !== original.length
    || !original.every(file => review.dependencies.some(dependency => dependency.subjectKey === file.subjectKey && dependency.digest === file.afterDigest))) return false;
  const currentSessions = [...new Set((context.runs.listGoalRuns?.(goal.id, goal.objectiveVersion) ?? [root])
    .filter(run => bound(run, goal.id, goal.objectiveVersion) && descendant(context, run, root)).map(run => run.sessionId))];
  const observed = review.messagePartIds.flatMap(id => {
    const candidates = currentSessions.flatMap(sessionId => context.conversations.listMessageParts(sessionId)).filter(item => item.id === id);
    return candidates.flatMap(candidate => {
      const message = context.conversations.listMessages(candidate.sessionId).find(item => item.id === candidate.messageId);
      const current = message?.runId ? context.runs.getRun(message.runId) : undefined;
      if (!bound(current, goal.id, goal.objectiveVersion) || !(terminal(current) || preview && current.id === root.id && current.status === "running") || !descendant(context, current, root) || !successful(candidate)) return [];
      const receipt = validHostFileFacts(candidate.metadata.hostFileFacts);
      return receipt?.environmentKey === facts.environmentKey ? receipt.files.filter(file => file.operation === "read"
        && artifactObservationStillCurrent(context, goal, root, current, candidate, receipt.environmentKey, file.subjectKey, file.afterDigest)) : [];
    });
  });
  return original.every(file => observed.some(current => current.subjectKey === file.subjectKey && current.afterDigest === file.afterDigest));
}
function externalEvidence(context: GoalEvidenceReaderContext, goal: SessionGoal, root: SessionRunRecord, requirementId: string, ref: GoalEvidenceRef): VerifiedGoalEvidence | undefined {
  const wait = root.metadata.goalWaitSource as import("@vykor/protocol").GoalExternalWait | undefined;
  if (!wait || wait.kind !== "external" || wait.goalId !== goal.id || wait.objectiveVersion !== goal.objectiveVersion
    || wait.targetRunId !== ref.runId || ref.goalId !== goal.id || ref.objectiveVersion !== goal.objectiveVersion
    || wait.observedStatus === undefined || !Number.isSafeInteger(wait.deadlineAt)) return undefined;
  const owner = context.runs.getRun(wait.ownerRunId);
  const target = context.runs.getRun(wait.targetRunId);
  if (!bound(owner, goal.id, goal.objectiveVersion) || owner.sessionId !== goal.sessionId || owner.metadata.parentRunId
    || !bound(target, goal.id, goal.objectiveVersion) || !terminal(target) || target.id === owner.id || !descendant(context, target, owner)
    || target.finishedAt === undefined || target.finishedAt > wait.deadlineAt) return undefined;
  const part = lookupPart(context, target, ref.messagePartId);
  if (!part || !["completed", "failed"].includes(part.status) || part.output == null && !part.text
    || part.toolName === "GoalRead" || part.toolName === "GoalAssessment") return undefined;
  return { requirementId, origin: origin(ref), verifiedForVersion: goal.objectiveVersion, supportsCompletion: false, facts: { external: {
    waitOwnerRunId: owner.id, targetRunId: target.id, observedStatus: wait.observedStatus,
    status: target.status as "completed" | "failed" | "interrupted", resultPartId: part.id,
  } } };
}

/** Verify only durable Run/Part facts. This function never reads workspace files or executes checks. */
export function readGoalEvidence(context: GoalEvidenceReaderContext, goal: SessionGoal, assessment: GoalAssessment, options: { preview?: boolean } = {}): VerifiedGoalEvidence[] {
  const root = rootFor(context, goal, assessment, options.preview);
  if (!root) return [];
  return refsByRequirement(assessment).flatMap(({ requirementId, ref }) => {
    const requirement = goal.requirements.find(item => item.id === requirementId);
    if (!requirement || requirement.verification.kind === "user_acceptance") return [];
    const external = externalEvidence(context, goal, root, requirementId, ref);
    const externalRun = external ? context.runs.getRun(ref.runId) : undefined;
    const externalPart = externalRun ? lookupPart(context, externalRun, ref.messagePartId) : undefined;
    const source = externalRun && externalPart && requirement.verification.kind !== "tool_result" ? { run: externalRun, part: externalPart, historical: false } : readSource(context, goal, root, ref, options.preview,
      requirement.verification.kind === "tool_result" && requirement.verification.outcome === "rejected");
    if (!source || !(source.run.status === "completed" || options.preview && source.run.id === root.id && source.run.status === "running")
      || !(requirement.verification.kind === "tool_result" ? expectedToolResult(source.part, requirement.verification) : successful(source.part))
      || source.historical && !historicalArtifactValid(context, goal, root, ref, requirement, source.part, options.preview)) return external ? [external] : [];
    const receipt = validHostFileFacts(source.part.metadata.hostFileFacts);
    const command = typeof source.part.input?.command === "string" ? source.part.input.command.trim() : undefined;
    let supportsCompletion = requirement.verification.kind !== "check" || (source.part.toolName === "Shell" && Boolean(command)
      && (requirement.verification.commandPolicy !== "required" || Boolean(requirement.verification.command) && command === requirement.verification.command!.trim()));
    if (!supportsCompletion && !receipt) return external ? [external] : [];
    // A current model review must point to the actual named artifact and explain the formal standard.
    if (requirement.verification.kind === "artifact_review") {
      const artifact = requirement.verification.artifact;
      if (!receipt) return external ? [external] : [];
      const { path, matching } = artifactFiles(artifact, receipt);
      if (!path || !matching.length) return external ? [external] : [];
      supportsCompletion = matching.some(file => file.afterDigest !== "missing" && (source.historical
        || artifactObservationStillCurrent(context, goal, root, source.run, source.part, receipt.environmentKey, file.subjectKey, file.afterDigest)));
    }
    return [{ requirementId, origin: origin(ref), verifiedForVersion: goal.objectiveVersion, supportsCompletion, facts: {
      ...(external ? external.facts : {}),
      ...(receipt ? { environmentKey: receipt.environmentKey, artifacts: receipt.files.map(file => ({ subjectKey: file.subjectKey, ...(file.beforeDigest === undefined ? {} : { beforeDigest: file.beforeDigest }), afterDigest: file.afterDigest })) } : {}),
      ...(command === undefined ? {} : { command }),
      ...(requirement.verification.kind === "check" ? { expected: requirement.verification.expected } : {}),
    } }];
  });
}

/** Structured diagnostics use the same identity, path and freshness boundaries as evidence verification. */
export function goalEvidenceRejection(
  context: GoalEvidenceReaderContext,
  goal: SessionGoal,
  assessment: GoalAssessment,
  requirement: GoalRequirement,
  ref: GoalEvidenceRef,
): { requirementId: string; messagePartId: string; code: string; message: string } {
  const issue = (code: string, message: string) => ({ requirementId: requirement.id, messagePartId: ref.messagePartId, code, message });
  const root = rootFor(context, goal, assessment, true);
  if (!root) return issue("assessment_run_invalid", "当前评估不属于允许的目标版本或运行。");
  const run = context.runs.getRun(ref.runId);
  if (ref.goalId !== goal.id || ref.objectiveVersion > goal.objectiveVersion || ref.objectiveVersion < 1 || !bound(run, goal.id, ref.objectiveVersion))
    return issue("evidence_identity_mismatch", "证据的目标、版本或运行身份不匹配。");
  if (!(run.status === "completed" || run.id === root.id && run.status === "running"))
    return issue("source_run_incomplete", "证据来源运行尚未正常结束，不能作为完成证明。");
  const part = lookupPart(context, run, ref.messagePartId);
  if (!part) return issue("evidence_not_found", "找不到此运行中的记录，请使用真实 Tool-Result-Id。");
  if (!["completed", "failed"].includes(part.status)) return issue("tool_result_incomplete", "所引用的工具尚未完成，不能作为完成证明。");
  if (part.toolName === "GoalRead" || part.toolName === "GoalAssessment" && !(requirement.verification.kind === "tool_result" && requirement.verification.outcome === "rejected"))
    return issue("control_result_not_evidence", "Goal 控制工具不能作为工作完成证据；仅明确要求的宿主拒绝记录可单独验收。");
  const source = readSource(context, goal, root, ref, true, requirement.verification.kind === "tool_result" && requirement.verification.outcome === "rejected");
  if (!source) return issue("historical_revalidation_required", "记录不属于本轮或缺少允许的历史复核。");
  if (source.historical && !historicalArtifactValid(context, goal, root, ref, requirement, part, true))
    return issue("historical_revalidation_invalid", "历史证据未通过完整的当前文件复核；工具调用记录不跨轮次复用。");
  if (requirement.verification.kind === "tool_result") {
    if (part.toolName !== requirement.verification.toolName)
      return issue("verification_tool_mismatch", `要求 ${requirement.verification.toolName} 调用记录，实际引用 ${part.toolName}。`);
    if (requirement.verification.outcome === "rejected")
      return issue("rejection_code_mismatch", `没有匹配的宿主拒绝原因 ${requirement.verification.rejectionCode}；任意报错或类型不匹配不能代替。`);
  }
  if (!successful(source.part))
    return issue("tool_result_unsuccessful", "工具尚未完成、失败或结果不确定，不能证明检查通过。");
  if (requirement.verification.kind === "check") {
    if (
      source.part.toolName !== "Shell" ||
      typeof source.part.input?.command !== "string"
    )
      return issue("verification_tool_mismatch", "读取或控制工具不能证明命令检查通过，请引用实际成功的 Shell 检查结果；文件当前内容应使用 artifact_review，历史调用事实应使用 tool_result。");
    if (
      requirement.verification.commandPolicy === "required" &&
      source.part.input.command.trim() !==
        requirement.verification.command?.trim()
    )
      return issue("command_mismatch", `用户指定必须执行的命令不匹配。要求=${requirement.verification.command}; 实际=${source.part.input.command}`.slice(0, 1000));
  }
  if (requirement.verification.kind === "artifact_review") {
    const receipt = validHostFileFacts(part.metadata.hostFileFacts);
    if (!receipt) return issue("artifact_facts_missing", "该结果没有宿主记录的文件摘要；Shell 打印路径或哈希不能代替文件工具记录。");
    const artifact = requirement.verification.artifact;
    const { path, matching } = artifactFiles(artifact, receipt);
    if (!path || !matching.length) return issue("artifact_path_mismatch", `目标产物路径=${path ?? artifact}；实际记录路径=${receipt.files.map(file => file.path).join(", ")}。`);
    if (matching.every(file => file.afterDigest === "missing")) return issue("artifact_missing", `目标文件已删除或不存在：${path}。`);
    if (matching.every(file => file.afterDigest === "missing" || !artifactObservationStillCurrent(context, goal, root, run, part, receipt.environmentKey, file.subjectKey, file.afterDigest)))
      return issue("artifact_stale", `旧文件证据已失效：${path} 在其他成功工具记录中已有不同摘要，请重新读取。`);
  }
  return issue("evidence_not_sufficient", "此记录未满足该条件的证据规则。");
}

export function describeGoalEvidenceRejection(
  context: GoalEvidenceReaderContext, goal: SessionGoal, assessment: GoalAssessment, requirement: GoalRequirement, ref: GoalEvidenceRef,
): string {
  const issue = goalEvidenceRejection(context, goal, assessment, requirement, ref);
  return `[${issue.code}] ${issue.requirementId} / ${issue.messagePartId}: ${issue.message}`;
}

export function readGoalDiagnostics(context: GoalEvidenceReaderContext, goal: SessionGoal, assessment: GoalAssessment): VerifiedGoalDiagnostic[] {
  const root = rootFor(context, goal, assessment);
  if (!root) return [];
  const refs = [...assessment.evidenceRefs, ...refsByRequirement(assessment).map(item => item.ref)];
  const diagnostics = new Map<string, VerifiedGoalDiagnostic>();
  for (const ref of refs) {
    const external = externalEvidence(context, goal, root, "", ref);
    const externalRun = external ? context.runs.getRun(ref.runId) : undefined;
    const externalPart = externalRun ? lookupPart(context, externalRun, ref.messagePartId) : undefined;
    const source = externalRun && externalPart ? { run: externalRun, part: externalPart, historical: false } : readSource(context, goal, root, ref);
    if (!source || source.historical) continue;
    if (source.part.type === "tool" && (source.part.isError || source.part.status === "failed")) {
      const output = source.part.output;
      const blocks = output && typeof output === "object" && "content" in output ? output.content : output;
      const summary = (Array.isArray(blocks) ? blocks.filter(item => item?.type === "text" && typeof item.text === "string").map(item => item.text).join("\n") : typeof blocks === "string" ? blocks : source.part.text ?? "工具调用失败").slice(0, 4000);
      diagnostics.set(`${source.run.id}\0${source.part.id}`, { origin: origin(ref), kind: "tool_error", summary });
    }
  }
  if (root.status !== "completed" && root.error) diagnostics.set(root.id, { origin: { goalId: goal.id, objectiveVersion: goal.objectiveVersion, runId: root.id, messagePartId: "" }, kind: "run_error", summary: root.error.slice(0, 4000) });
  return [...diagnostics.values()];
}
