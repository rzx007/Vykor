import type { AgentPool } from "../agent/agent-pool.js";
import type { SessionRunExecutorContext } from "./session-run-executor.js";
import type { WorkspaceBaselineResult, WorkspaceChangeResult } from "./session-workspace-changes.js";

type AutoReviewContext = Pick<
  SessionRunExecutorContext,
  "autoReview" | "data" | "log" | "resolveAutoReviewMode" | "traceIdForRun" | "workspaceChanges" | "resolveLocalExecutionCwd"
>;

export async function captureAutoReviewBaseline(
  context: AutoReviewContext,
  sessionId: string,
  runId: string,
  cwd: string,
  agent?: Awaited<ReturnType<AgentPool["acquireSession"]>>,
  signal?: AbortSignal,
): Promise<void> {
  let observation: WorkspaceBaselineResult | undefined;
  if (context.workspaceChanges) {
    try {
      observation = await context.workspaceChanges.capture(runId, cwd,
        agent ? context.resolveLocalExecutionCwd?.(agent) : undefined, signal);
    } catch (error) {
      observation = { attribution: "unavailable", reason: "git_inspection_failed" };
      context.log({ level: "warn", event: "workspace_changes.capture_failed", runId, error: String(error) });
    }
  }
  const autoReview = context.autoReview;
  if (!autoReview) return;
  try {
    const mode = context.resolveAutoReviewMode
      ? await context.resolveAutoReviewMode(cwd)
      : "off";
    await autoReview.captureBaseline({ sessionId, runId, cwd, mode, ...(observation ? { observation } : {}) });
  } catch (error) {
    context.log({
      level: "error",
      event: "auto_review.capture_failed",
      traceId: context.traceIdForRun(runId),
      sessionId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function reviewAutoReview(context: AutoReviewContext, input: {
  sessionId: string;
  inputId: string;
  runId: string;
  cwd: string;
  agent: Awaited<ReturnType<AgentPool["acquireSession"]>>;
  signal: AbortSignal;
}): Promise<void> {
  let changes: WorkspaceChangeResult | undefined;
  if (context.workspaceChanges) {
    try { changes = await context.workspaceChanges.settle(input.runId, input.signal); }
    catch (error) {
      changes = { attribution: "unavailable", reason: "git_inspection_failed" };
      context.log({ level: "warn", event: "workspace_changes.settle_failed", runId: input.runId, error: String(error) });
    }
  }
  const autoReview = context.autoReview;
  if (!autoReview) return;
  try {
    const settled = context.data.runs.getRun(input.runId);
    if (settled?.status === "completed") {
      await autoReview.reviewCompletedRun({
        sessionId: input.sessionId,
        inputId: input.inputId,
        runId: input.runId,
        traceId: context.traceIdForRun(input.runId),
        cwd: input.cwd,
        agent: input.agent,
        signal: input.signal,
        ...(changes ? { changes } : {}),
      });
    } else {
      autoReview.settleUnreviewedRun({
        sessionId: input.sessionId,
        runId: input.runId,
        reason: "parent_run_not_completed",
      });
    }
  } catch (error) {
    context.log({
      level: "error",
      event: "auto_review.failed",
      traceId: context.traceIdForRun(input.runId),
      sessionId: input.sessionId,
      runId: input.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function settleUnreviewedAutoReview(
  context: AutoReviewContext,
  sessionId: string,
  runId: string,
): void {
  try {
    context.autoReview?.settleUnreviewedRun({
      sessionId,
      runId,
      reason: "parent_run_not_completed",
    });
  } catch (error) {
    context.log({
      level: "error",
      event: "auto_review.settle_failed",
      traceId: context.traceIdForRun(runId),
      sessionId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
