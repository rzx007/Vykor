import type {
  GoalAssessment,
  GoalEvidenceRef,
  SessionGoal,
  SessionMessagePartRecord,
  SessionMessageRecord,
} from "@vykor/protocol";

export interface GoalEvidenceReader {
  listMessages(sessionId: string): SessionMessageRecord[];
  listMessageParts(sessionId: string): SessionMessagePartRecord[];
}

export type GoalCompletionDisposition =
  | { kind: "completed" }
  | { kind: "continue"; reason: string }
  | { kind: "waiting_user"; reason: string };

export function verifiedGoalEvidence(
  store: GoalEvidenceReader,
  goal: SessionGoal,
  assessment: GoalAssessment,
) {
  const messages = new Map(
    store.listMessages(goal.sessionId).map((message) => [message.id, message]),
  );
  const parts = store.listMessageParts(goal.sessionId);
  const unique = new Map<string, GoalEvidenceRef>();
  for (const ref of assessment.evidenceRefs) unique.set(ref.messagePartId, ref);
  for (const requirement of assessment.requirements ?? []) {
    for (const ref of requirement.evidenceRefs)
      unique.set(ref.messagePartId, ref);
  }
  return [...unique.values()].flatMap((ref) => {
    if (
      ref.goalId !== goal.id ||
      ref.revision !== goal.revision ||
      ref.runId !== assessment.runId
    )
      return [];
    const part = parts.find((item) => item.id === ref.messagePartId);
    if (
      !part ||
      messages.get(part.messageId)?.runId !== ref.runId ||
      part.type !== "tool" ||
      part.status !== "completed" ||
      part.isError ||
      part.output == null ||
      part.toolName === "GoalAssessment"
    )
      return [];
    return [part];
  });
}

export function classifyGoalCompletion(
  assessment: GoalAssessment,
  verifiedPartIds: ReadonlySet<string>,
): GoalCompletionDisposition {
  const requirements = assessment.requirements ?? [];
  if (requirements.some((item) => item.status === "needs_user")) {
    return {
      kind: "waiting_user",
      reason: "请验收目标中需要主观判断的完成条件",
    };
  }
  const unfinished =
    requirements.some((item) => item.status === "incomplete") ||
    Boolean(assessment.remainingWork?.length);
  if (unfinished) {
    return {
      kind: "continue",
      reason:
        assessment.nextStep ??
        assessment.remainingWork?.[0] ??
        "继续完成剩余要求",
    };
  }
  const allSatisfied =
    requirements.length > 0 &&
    requirements.every(
      (item) =>
        item.status === "satisfied" &&
        item.evidenceRefs.length > 0 &&
        item.evidenceRefs.every((ref) =>
          verifiedPartIds.has(ref.messagePartId),
        ),
    );
  return allSatisfied
    ? { kind: "completed" }
    : {
        kind: "waiting_user",
        reason: "完成审查缺少当前运行的有效证据，请验收目标结果",
      };
}
