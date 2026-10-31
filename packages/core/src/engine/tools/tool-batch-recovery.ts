import type { ToolExecutionResult } from "@vykor/agent-contracts";
import { toolFeedbackFields } from "./tool-result-feedback";

export const RECOVERY_TOOL_TURNS = 2;
const TOOL_CORRECTION_LIMITS = { invalid_input: 8, precondition: 5 } as const;

interface CorrectionTurns {
  invalid_input: number;
  precondition: number;
}

interface ToolBatchRecovery {
  correctionTurns: CorrectionTurns;
  recoveryToolTurnsRemaining: number | null;
  forceFinalResponse: boolean;
}

/**
 * Called only after the complete batch is saved and delivered, cancellation is
 * checked, and endRunOnSuccess is handled. State belongs to submitMessage.
 * The trajectory callback deliberately runs between the two limit checks:
 * correction exhaustion skips it; recovery exhaustion still observes the batch.
 */
export function decideToolBatchRecovery(input: {
  results: readonly ToolExecutionResult[];
  projectInstructionProgress: ReadonlySet<string>;
  correctionTurns: Readonly<CorrectionTurns>;
  recoveryToolTurnsRemaining: number | null;
  recoveringAtTurnStart: boolean;
  observeTrajectory: () => boolean;
}): ToolBatchRecovery {
  const { results, recoveringAtTurnStart } = input;
  let recoveryToolTurnsRemaining = input.recoveryToolTurnsRemaining;
  const correctionTurns = { ...input.correctionTurns };
  const ruleProgress = (result: ToolExecutionResult) => input.projectInstructionProgress.has(result.toolUseId);
  // A successful alternative cancels recovery in either result order, but only
  // an entirely successful batch resets accumulated correction failures.
  if (results.some((result) => !result.isError || ruleProgress(result)))
    recoveryToolTurnsRemaining = null;
  if (results.every((result) => !result.isError)) {
    correctionTurns.invalid_input = correctionTurns.precondition = 0;
  }
  for (const kind of ["invalid_input", "precondition"] as const) {
    const failed = results.filter(
      (result) => result.isError && result.failureKind === kind && !ruleProgress(result),
    );
    if (failed.length) correctionTurns[kind]++;
    if (correctionTurns[kind] >= TOOL_CORRECTION_LIMITS[kind]) {
      throw new ToolCorrectionsExceeded(kind, correctionTurns[kind], failed.at(-1));
    }
  }
  const forceFinalResponse = input.observeTrajectory();
  if (recoveringAtTurnStart && recoveryToolTurnsRemaining !== null) {
    recoveryToolTurnsRemaining--;
    if (recoveryToolTurnsRemaining <= 0) {
      throw new ToolCorrectionsExceeded(
        "recovery_guard",
        RECOVERY_TOOL_TURNS,
        results.filter((result) => result.isError).at(-1),
      );
    }
  }
  return { correctionTurns, recoveryToolTurnsRemaining, forceFinalResponse };
}

class ToolCorrectionsExceeded extends Error {
  constructor(
    kind: keyof typeof TOOL_CORRECTION_LIMITS | "recovery_guard",
    turns: number,
    lastFailure?: ToolExecutionResult,
  ) {
    const toolName = lastFailure?.toolName ?? "未知工具";
    const displayName =
      toolName.length > 80 ? toolName.slice(0, 80) + "…" : toolName;
    const hint = lastFailure
      ? toolFeedbackFields(lastFailure).recoveryHint
      : undefined;
    const reason =
      kind === "recovery_guard"
        ? "重复失败调用的恢复额度（" + turns + "轮）已耗尽"
        : (kind === "invalid_input" ? "工具参数" : "文件条件") +
          "在未完全成功的工具批次中累计 " +
          turns +
          " 轮失败";
    super(
      reason +
        "，本轮已停止自动纠错。最后失败工具：" +
        displayName +
        "。" +
        (hint ?? "请根据工具反馈检查参数和目标状态。") +
        " 此次停止不代表任务已完成。",
    );
    this.name =
      kind === "recovery_guard"
        ? "ToolRecoveryExceeded"
        : kind === "invalid_input"
          ? "ToolInputCorrectionsExceeded"
          : "ToolPreconditionsExceeded";
  }
}
