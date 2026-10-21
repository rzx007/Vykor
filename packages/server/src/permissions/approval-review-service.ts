import type {
  ApprovalReviewEvidence, ApprovalReviewInput, ApprovalReviewOutcome,
  SessionInputRecord, SessionRunRecord,
} from "@vykor/protocol";

export type ApprovalReviewServiceInput = Omit<ApprovalReviewInput, "evidence"> & {
  evidence: Omit<ApprovalReviewEvidence, "userInstruction">;
};

export interface PermissionApprovalReviewServiceOptions {
  getInput(inputId: string): SessionInputRecord | undefined;
  getRun(runId: string): SessionRunRecord | undefined;
  /** Resolves independent host-admitted app Runs, including exact tool/args and current ownership. */
  appInstruction?(input: ApprovalReviewServiceInput, run: SessionRunRecord): string | undefined;
  review(input: ApprovalReviewInput, signal?: AbortSignal): Promise<ApprovalReviewOutcome>;
}

/** Binds approval evidence to the durable human input, never to an agent summary. */
export function createPermissionApprovalReviewService(options: PermissionApprovalReviewServiceOptions) {
  return {
    async review(input: ApprovalReviewServiceInput, signal?: AbortSignal): Promise<ApprovalReviewOutcome> {
      if (signal?.aborted) throw signal.reason ?? new Error("Approval review interrupted");
      const prompt = options.getInput(input.inputId);
      const run = input.runId ? options.getRun(input.runId) : undefined;
      const independent = !prompt && run ? options.appInstruction?.(input, run) : undefined;
      const instruction = independent ?? prompt?.content;
      if (!instruction?.trim() || (prompt && prompt.sessionId !== input.sessionId)
        || run?.metadata?.parentRunId !== undefined
        || (input.runId && (!run || run.sessionId !== input.sessionId || (independent ? run.inputId !== undefined || input.inputId !== run.id : run.inputId !== input.inputId)
          || (run.status !== "pending" && run.status !== "running")))
        || !input.requestId || !input.tool.name || !input.tool.source
        || !Number.isInteger(input.runtimeRevision) || input.runtimeRevision < 0) {
        return unavailable("无法核实本次操作对应的用户指令，需要你确认。");
      }
      const evidence: ApprovalReviewEvidence = { ...input.evidence, userInstruction: instruction };
      const reviewInput: ApprovalReviewInput = { ...input, evidence };
      // Do not silently trim away qualifications that could change authorization.
      if (instruction.length > 16_000 || JSON.stringify(reviewInput).length > 65_536) {
        return unavailable("审查所需资料超出范围，需要你确认。");
      }
      try {
        return await options.review(reviewInput, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        return unavailable("自动审查暂时不可用，需要你确认。");
      }
    },
  };
}

function unavailable(reason: string): ApprovalReviewOutcome {
  return { decision: "ask_user", risk: "unknown", authorization: "missing", reason, failure: "unavailable" };
}
