import { workflowBudgetFromMetadata } from "./budget.js";
import type {
  WorkflowConservePolicy,
  WorkflowPlan,
  WorkflowRetryPolicy,
  WorkflowRunner,
  WorkflowRunningTask,
  WorkflowTask,
  WorkflowTaskBudgetUsage,
  WorkflowTaskProgress,
  WorkflowTaskRunResult,
  WorkflowWorkerResult,
} from "./model.js";

export async function runWorkflowTask(
  task: WorkflowTask,
  runner: WorkflowRunner,
  dependencyResults: Record<string, WorkflowTaskRunResult>,
  pipelineInput: WorkflowTaskRunResult | undefined,
  resumeFrom: WorkflowRunningTask | undefined,
  timeoutMs: number | undefined,
  budgetMode: "normal" | "conserve",
  budgetConserve: WorkflowConservePolicy | undefined,
  reportProgress: (progress: WorkflowTaskProgress) => void,
): Promise<WorkflowTaskRunResult> {
  const retry = normalizeRetry(task.retry);
  const startedAt = Date.now();
  let lastResult: WorkflowWorkerResult | undefined;
  let lastError: string | undefined;
  let lastProgressMetadata: Record<string, unknown> | undefined;
  let lastProgressBudget: WorkflowTaskBudgetUsage | undefined;
  const recordProgress = (progress: WorkflowTaskProgress) => {
    lastProgressMetadata = progress.metadata ?? lastProgressMetadata;
    lastProgressBudget = progress.budget ?? workflowBudgetFromMetadata(progress.metadata) ?? lastProgressBudget;
    reportProgress({
      ...progress,
      budget: progress.budget ?? workflowBudgetFromMetadata(progress.metadata),
    });
  };

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    let acceptingProgress = true;
    try {
      recordProgress({
        summary: attempt === 1 ? "Task running" : `Retry attempt ${attempt} running`,
      });
      lastResult = await runRunnerAttempt(
        (signal, deadlineAt) => runner({
          task,
          attempt,
          dependencyResults,
          pipelineInput,
          resumeFrom: attempt === 1 ? resumeFrom : undefined,
          budgetMode,
          budgetConserve,
          reportProgress: progress => { if (acceptingProgress) recordProgress(progress); },
          signal,
          deadlineAt,
        }),
        timeoutMs,
        cleanupUnconfirmed => recordProgress({ summary: "Waiting for actual worker stop", metadata: { ...lastProgressMetadata, stopping: true, ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}) } }),
      );
      const status = lastResult.status ?? "completed";
      if (lastResult.metadata?.cleanupUnconfirmed || lastResult.metadata?.retryable === false || status === "completed" || !retry.retryOn.includes(status) || attempt === retry.maxAttempts) {
        return {
          ...lastResult,
          taskId: task.id,
          status,
          budget: workflowBudgetFromMetadata(lastResult.metadata) ?? lastProgressBudget,
          attempts: attempt,
          dependencies: [...(task.dependsOn ?? [])],
          startedAt,
          finishedAt: Date.now(),
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const timeoutError = error instanceof WorkflowTaskTimeoutError ? error : undefined;
      const timedOut = timeoutError !== undefined;
      if (timeoutError?.lateResult) lastResult = timeoutError.lateResult;
      const uncertain = timeoutError?.cleanupUnconfirmed || hasUnconfirmedCleanup(error);
      const errorMetadata = hasUnconfirmedCleanup(error) ? (error as { metadata?: Record<string, unknown> }).metadata : undefined;
      if (uncertain || !retry.retryOn.includes("failed") || attempt === retry.maxAttempts) {
        return {
          taskId: task.id,
          status: "failed",
          summary: lastError,
          result: timeoutError?.lateResult?.result,
          metadata: timeoutError?.lateResult?.metadata ?? (uncertain ? { ...lastProgressMetadata, ...errorMetadata, cleanupUnconfirmed: true, stopping: true } : undefined),
          budget: workflowBudgetFromMetadata(timeoutError?.lateResult?.metadata) ?? lastProgressBudget,
          attempts: attempt,
          dependencies: [...(task.dependsOn ?? [])],
          startedAt,
          finishedAt: Date.now(),
          timedOut,
          ...(uncertain ? { cleanupUnconfirmed: true } : {}),
          error: lastError,
        };
      }
    } finally { acceptingProgress = false; }
  }

  return {
    taskId: task.id,
    status: "failed",
    summary: lastResult?.summary ?? lastError ?? "Task failed",
    result: lastResult?.result,
    metadata: lastResult?.metadata,
    budget: workflowBudgetFromMetadata(lastResult?.metadata) ?? lastProgressBudget,
    attempts: retry.maxAttempts,
    dependencies: [...(task.dependsOn ?? [])],
    startedAt,
    finishedAt: Date.now(),
    error: lastError,
  };
}

const CLEANUP_GRACE_MS = 5_000;

async function runRunnerAttempt(
  start: (signal: AbortSignal, deadlineAt: number | undefined) => Promise<WorkflowWorkerResult> | WorkflowWorkerResult,
  timeoutMs: number | undefined,
  onStopping: (cleanupUnconfirmed: boolean) => void,
): Promise<WorkflowWorkerResult> {
  const controller = new AbortController();
  if (timeoutMs === undefined) return await start(controller.signal, undefined);

  const deadlineAt = Date.now() + timeoutMs;
  const resultPromise = Promise.resolve().then(() => start(controller.signal, deadlineAt));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    // Natural completion wins: the timer is cleared without aborting the runner.
    const winner = await Promise.race([
      resultPromise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timeout = setTimeout(() => {
          onStopping(false);
          controller.abort(new WorkflowTaskTimeoutError(timeoutMs));
          resolve({ timedOut: true });
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (!winner.timedOut) return winner.value;

    // The runner may still be settling its own worker; give it a bounded window
    // before reporting that cleanup is unconfirmed.
    const settled = await Promise.race([
      resultPromise.then(
        (value) => ({ confirmed: true as const, value }),
        error => { if (hasUnconfirmedCleanup(error)) throw error; return { confirmed: true as const }; },
      ),
      new Promise<{ confirmed: false }>((resolve) => {
        graceTimer = setTimeout(() => resolve({ confirmed: false }), CLEANUP_GRACE_MS);
        graceTimer.unref?.();
      }),
    ]);
    // The grace is diagnostic, never evidence that a real worker stopped.
    // Keep this attempt owned until its original runner confirms settlement.
    if (!settled.confirmed) {
      onStopping(true);
      const lateResult = await resultPromise.catch(error => { if (hasUnconfirmedCleanup(error)) throw error; return undefined; });
      throw new WorkflowTaskTimeoutError(timeoutMs, false, lateResult);
    }
    // Once the deadline wins, a late success must not turn a timed-out task
    // into a completed one. Keep any late result only as partial evidence.
    throw new WorkflowTaskTimeoutError(
      timeoutMs,
      !settled.confirmed,
      settled.confirmed && "value" in settled ? settled.value : undefined,
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
}

class WorkflowTaskTimeoutError extends Error {
  constructor(
    timeoutMs: number,
    readonly cleanupUnconfirmed = false,
    readonly lateResult?: WorkflowWorkerResult,
  ) {
    super(`Task timed out after ${timeoutMs}ms`);
    this.name = "WorkflowTaskTimeoutError";
  }
}

export function resolveTaskTimeoutMs(plan: WorkflowPlan, task: WorkflowTask): number | undefined {
  const timeoutMs = task.timeoutMs ?? plan.defaultTaskTimeoutMs;
  return timeoutMs === undefined ? undefined : Math.floor(timeoutMs);
}

function normalizeRetry(policy: WorkflowRetryPolicy | undefined): Required<WorkflowRetryPolicy> {
  return {
    maxAttempts: Math.max(1, Math.floor(policy?.maxAttempts ?? 1)),
    retryOn: policy?.retryOn ?? ["failed"],
  };
}

function hasUnconfirmedCleanup(error: unknown): boolean {
  return typeof error === "object" && error !== null && "cleanupUnconfirmed" in error && error.cleanupUnconfirmed === true;
}
