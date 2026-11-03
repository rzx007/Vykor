import type { ApprovalReviewEvidence, ApprovalReviewInput, ApprovalReviewOutcome } from "@vykor/agent-contracts/permissions";
import type { SessionInputRecord, SessionRunRecord } from "@vykor/domain-contracts/sessions";
import { withoutHostPluginMetadata } from "@vykor/domain-contracts/inputs";

export type ApprovalReviewServiceInput = Omit<ApprovalReviewInput, "evidence"> & {
  evidence: Omit<ApprovalReviewEvidence, "userInstruction" | "userInstructionHistory">;
};

export interface PermissionApprovalReviewServiceOptions {
  getInput(inputId: string): SessionInputRecord | undefined;
  getRun(runId: string): SessionRunRecord | undefined;
  /** Inputs already projected as user messages in this exact conversation. */
  listUserInputs?(sessionId: string): SessionInputRecord[];
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
      if (!instruction?.trim() || (prompt && (prompt.id !== input.inputId || prompt.sessionId !== input.sessionId || !isDirectHumanInput(prompt)))
        || run?.metadata?.parentRunId !== undefined
        || (input.runId && (!run || run.sessionId !== input.sessionId || (independent ? run.inputId !== undefined || input.inputId !== run.id : run.inputId !== input.inputId)
          || (run.status !== "pending" && run.status !== "running")))
        || !input.requestId || !input.tool.name || !input.tool.source
        || !Number.isInteger(input.runtimeRevision) || input.runtimeRevision < 0) {
        return unavailable("无法核实本次操作对应的用户指令，需要你确认。");
      }
      const previousInputs = prompt && options.listUserInputs
        ? options.listUserInputs(input.sessionId)
          .filter(previous => previous.sessionId === input.sessionId && previous.id !== prompt.id
            && Number.isInteger(previous.seq) && previous.seq > 0 && previous.seq < prompt.seq)
        : [];
      if ((prompt && hasSensitiveInput(prompt)) || previousInputs.some(hasSensitiveInput)) {
        return unavailable("审查资料包含敏感用户输入，需要你直接确认。");
      }
      const history = previousInputs
        .filter(previous => previous.content.trim() && isDirectHumanInput(previous))
        .sort((left, right) => left.seq - right.seq)
        .map(previous => ({ inputId: previous.id, content: previous.content }));
      const evidence: ApprovalReviewEvidence = { ...input.evidence, userInstruction: instruction };
      // Authorization fields must come only from durable host records, even if
      // a caller bypassed the TypeScript input contract.
      delete evidence.userInstructionHistory;
      if (history.length) evidence.userInstructionHistory = history;
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

/** Machine-generated prompts can be references, never fresh human authorization. */
function isDirectHumanInput(input: SessionInputRecord): boolean {
  return input.metadata.goalRunKind !== "continuation" && input.metadata.transcriptVisibility !== "hidden"
    && input.metadata.approvalInstructionSource !== "external"
    && Object.keys(withoutHostPluginMetadata(input.metadata)).length === Object.keys(input.metadata).length;
}

function hasSensitiveInput(input: SessionInputRecord): boolean {
  return input.metadata.sensitiveInput === true || input.metadata.autoReviewSensitive === true;
}

function unavailable(reason: string): ApprovalReviewOutcome {
  return { decision: "ask_user", risk: "unknown", authorization: "missing", reason, failure: "unavailable" };
}
