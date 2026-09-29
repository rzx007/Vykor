export type WorkflowMode = "parallel" | "sequential" | "pipeline";

export type WorkflowFailurePolicy = "skip-dependents" | "fail-fast" | "continue";

export type WorkflowTaskTerminalStatus = "completed" | "failed" | "killed" | "skipped";

export type WorkflowTaskStatus = "pending" | "running" | WorkflowTaskTerminalStatus;

export interface WorkflowRetryPolicy {
  /** Total attempts, including the first attempt. Defaults to 1. */
  maxAttempts?: number;
  /** Statuses that should be retried. Defaults to ["failed"]. */
  retryOn?: Array<"failed" | "killed">;
}

export interface WorkflowTask {
  id: string;
  description?: string;
  prompt?: string;
  subagentType?: string;
  model?: string;
  team?: string;
  permissionMode?: "default" | "plan" | "full_auto";
  dependsOn?: string[];
  retry?: WorkflowRetryPolicy;
  timeoutMs?: number;
  readOnly?: boolean;
  writeScope?: string[];
  isolate?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkflowSpec {
  mode: WorkflowMode;
  tasks: WorkflowTask[];
  maxConcurrency?: number;
  defaultTaskTimeoutMs?: number;
  budgetPolicyPreset?: WorkflowBudgetPolicyPreset;
  budgetPolicy?: WorkflowBudgetPolicy;
  failurePolicy?: WorkflowFailurePolicy;
}

export interface WorkflowPlan {
  mode: WorkflowMode;
  tasks: WorkflowTask[];
  maxConcurrency: number;
  defaultTaskTimeoutMs?: number;
  budgetPolicyPreset?: WorkflowBudgetPolicyPreset;
  budgetPolicy?: WorkflowBudgetPolicy;
  executionOrder: string[];
  dependencyMap: Record<string, string[]>;
  dependentsMap: Record<string, string[]>;
}

export interface WorkflowWorkerResult {
  status?: Exclude<WorkflowTaskTerminalStatus, "skipped">;
  summary: string;
  result?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowTaskBudgetUsage {
  tokensUsed?: number;
  tokenBudget?: number;
  timeUsedMs?: number;
  timeBudgetMs?: number;
}

export interface WorkflowBudgetPolicy {
  maxTokensUsed?: number;
  maxTimeUsedMs?: number;
  softMaxTokensUsed?: number;
  softMaxTimeUsedMs?: number;
  onSoftLimit?: "continue" | "serialize" | "conserve" | "serialize-and-conserve";
  conserve?: WorkflowConservePolicy;
}

export interface WorkflowConservePolicy {
  promptHint?: string;
  permissionMode?: "default" | "plan";
  maxTurns?: number;
}

export type WorkflowBudgetPolicyPreset = "cheap-review" | "safe-write" | "fast-parallel";

export const WORKFLOW_BUDGET_POLICY_PRESETS: Record<WorkflowBudgetPolicyPreset, WorkflowBudgetPolicy> = {
  "cheap-review": {
    maxTokensUsed: 12_000,
    softMaxTokensUsed: 8_000,
    onSoftLimit: "serialize-and-conserve",
    conserve: {
      permissionMode: "plan",
      maxTurns: 2,
      promptHint: "Prefer inspection, focused summaries, and minimal follow-up work once the workflow is over its cheap-review budget.",
    },
  },
  "safe-write": {
    maxTokensUsed: 24_000,
    softMaxTokensUsed: 16_000,
    onSoftLimit: "serialize-and-conserve",
    conserve: {
      permissionMode: "plan",
      maxTurns: 4,
      promptHint: "Prefer small, reviewable write steps and stop to report uncertainty once the workflow is over its safe-write budget.",
    },
  },
  "fast-parallel": {
    maxTokensUsed: 45_000,
    softMaxTokensUsed: 30_000,
    onSoftLimit: "continue",
  },
};

export interface WorkflowDiffFileSummary {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "other";
  insertions?: number;
  deletions?: number;
}

export interface WorkflowDiffSummary {
  changedFiles: string[];
  files: WorkflowDiffFileSummary[];
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  untracked: number;
  insertions: number;
  deletions: number;
}

export interface WorkflowTaskRunResult {
  taskId: string;
  status: WorkflowTaskTerminalStatus;
  summary: string;
  result?: string;
  metadata?: Record<string, unknown>;
  budget?: WorkflowTaskBudgetUsage;
  attempts: number;
  dependencies: string[];
  startedAt: number;
  finishedAt: number;
  skippedReason?: string;
  timedOut?: boolean;
  /** The runner did not confirm it stopped its worker within the cleanup grace window. */
  cleanupUnconfirmed?: boolean;
  error?: string;
}

export interface WorkflowRunnerContext {
  task: WorkflowTask;
  attempt: number;
  dependencyResults: Record<string, WorkflowTaskRunResult>;
  pipelineInput?: WorkflowTaskRunResult;
  resumeFrom?: WorkflowRunningTask;
  budgetMode?: "normal" | "conserve";
  budgetConserve?: WorkflowConservePolicy;
  reportProgress?: (progress: WorkflowTaskProgress) => void;
  /** Aborted by the scheduler when the attempt deadline is reached. */
  signal?: AbortSignal;
  /** Epoch ms by which the runner must settle; earlier than any role budget when smaller. */
  deadlineAt?: number;
}

export type WorkflowRunner = (
  context: WorkflowRunnerContext,
) => Promise<WorkflowWorkerResult> | WorkflowWorkerResult;

export interface WorkflowRunResult {
  runId?: string;
  status: "completed" | "failed";
  summary: string;
  plan: WorkflowPlan;
  results: Record<string, WorkflowTaskRunResult>;
  orderedResults: WorkflowTaskRunResult[];
  needsReconciliation?: boolean;
  reconciliationIssues?: WorkflowReconciliationIssue[];
  budget?: WorkflowBudgetUsage;
}

export interface WorkflowRunSummary {
  runId: string;
  ownerSession?: string;
  status: WorkflowRunSnapshotStatus;
  summary: string;
  mode: WorkflowMode;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  pendingTasks: number;
  runningTasks: number;
  blockedTasks: number;
  needsReconciliation: boolean;
  budget: WorkflowBudgetUsage;
  budgetPolicyPreset?: WorkflowBudgetPolicyPreset;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRunSnapshotPlan {
  mode: WorkflowMode;
  tasks: WorkflowTask[];
  maxConcurrency: number | "unbounded";
  defaultTaskTimeoutMs?: number;
  budgetPolicyPreset?: WorkflowBudgetPolicyPreset;
  budgetPolicy?: WorkflowBudgetPolicy;
  executionOrder: string[];
  dependencyMap: Record<string, string[]>;
  dependentsMap: Record<string, string[]>;
}

export interface WorkflowRunningTask {
  taskId: string;
  attempt: number;
  dependencies: string[];
  startedAt: number;
  summary: string;
  budget?: WorkflowTaskBudgetUsage;
  metadata?: Record<string, unknown>;
}

export interface WorkflowTaskProgress {
  summary?: string;
  metadata?: Record<string, unknown>;
  budget?: WorkflowTaskBudgetUsage;
}

export interface WorkflowBlockedTask {
  taskId: string;
  reason: string;
  waitingForTaskIds: string[];
  writeScope?: string[];
  conflictingWriteScope?: string[];
}

export interface WorkflowReconciliationIssue {
  issueId: string;
  type: "write-scope-overlap" | "changed-file-overlap";
  severity: "needs-reconciliation" | "actual-conflict";
  taskIds: string[];
  writeScope: string[];
  changedFiles?: string[];
  summary: string;
}

export interface WorkflowReconciliationFileSummary {
  path: string;
  issueIds: string[];
  taskIds: string[];
  statuses: Record<string, WorkflowDiffFileSummary["status"]>;
  insertions: number;
  deletions: number;
}

export interface WorkflowReconciliationTaskSummary {
  taskId: string;
  issueIds: string[];
  changedFiles: string[];
  insertions: number;
  deletions: number;
}

export interface WorkflowReconciliationSummary {
  totalIssues: number;
  actualConflicts: number;
  declaredScopeOverlaps: number;
  files: WorkflowReconciliationFileSummary[];
  tasks: WorkflowReconciliationTaskSummary[];
}

export interface WorkflowReconciliationFollowUpAction {
  actionId: string;
  issueIds: string[];
  taskId: string;
  description: string;
  prompt: string;
  writeScope: string[];
  dependsOn: string[];
}

export interface WorkflowReconciliationPlan {
  needed: boolean;
  summary: string;
  actions: WorkflowReconciliationFollowUpAction[];
}

export interface WorkflowReconciliationSpecOptions {
  actionIds?: string[];
  issueIds?: string[];
  verifyTaskId?: string;
  budgetPolicyPreset?: WorkflowBudgetPolicyPreset;
}

export interface WorkflowBudgetUsage extends WorkflowTaskBudgetUsage {
  tasks: Record<string, WorkflowTaskBudgetUsage>;
}

export type WorkflowRunSnapshotStatus = "running" | "completed" | "failed";

export interface WorkflowRunSnapshot {
  version: 1;
  runId: string;
  ownerSession?: string;
  ownerInput?: string;
  ownerRun?: string;
  status: WorkflowRunSnapshotStatus;
  termination?: "cancelled";
  summary: string;
  spec: WorkflowSpec;
  plan: WorkflowRunSnapshotPlan;
  results: Record<string, WorkflowTaskRunResult>;
  orderedResults: WorkflowTaskRunResult[];
  pendingTaskIds: string[];
  blockedTaskIds: string[];
  blockedTasks: Record<string, WorkflowBlockedTask>;
  runningTaskIds: string[];
  runningTasks: Record<string, WorkflowRunningTask>;
  budget: WorkflowBudgetUsage;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRunOptions {
  runId?: string;
  ownerSession?: string;
  ownerInput?: string;
  ownerRun?: string;
  /** Return a reason when an external controller has requested this run to stop scheduling work. */
  shouldStop?: () => string | undefined;
  onSnapshot?: (snapshot: WorkflowRunSnapshot) => void;
  onEvent?: (event: WorkflowRunEvent) => void;
  initialResults?: Record<string, WorkflowTaskRunResult>;
  initialRunningTasks?: Record<string, WorkflowRunningTask>;
  createdAt?: number;
}

export type WorkflowRunEventType =
  | "workflow_started"
  | "task_started"
  | "task_progress"
  | "task_blocked"
  | "workflow_budget_conserving"
  | "workflow_budget_exceeded"
  | "task_finished"
  | "workflow_cancelled"
  | "workflow_finished";

export interface WorkflowRunEvent {
  version: 1;
  runId: string;
  type: WorkflowRunEventType;
  timestamp: number;
  summary?: string;
  taskId?: string;
  attempt?: number;
  status?: WorkflowTaskStatus | WorkflowRunResult["status"];
  runningTask?: WorkflowRunningTask;
  blockedTask?: WorkflowBlockedTask;
  result?: WorkflowTaskRunResult;
}

export interface WorkflowNotificationTask {
  taskId: string;
  status: WorkflowTaskTerminalStatus;
  summary: string;
  attempts: number;
  dependencies: string[];
  startedAt: number;
  finishedAt: number;
  result?: string;
  metadata?: Record<string, unknown>;
  budget?: WorkflowTaskBudgetUsage;
  reconciliationIssueIds?: string[];
  skippedReason?: string;
  timedOut?: boolean;
  error?: string;
}

export interface WorkflowNotification {
  runId?: string;
  status: WorkflowRunResult["status"];
  summary: string;
  mode: WorkflowMode;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  needsReconciliation: boolean;
  reconciliationIssues: WorkflowReconciliationIssue[];
  reconciliationSummary: WorkflowReconciliationSummary;
  reconciliationPlan: WorkflowReconciliationPlan;
  budget: WorkflowBudgetUsage;
  tasks: WorkflowNotificationTask[];
}

export type WorkflowTemplateName = "research-implement-verify" | "parallel-review" | "safe-write";

export interface WorkflowSpecTemplate {
  name: WorkflowTemplateName;
  version: number;
  description: string;
  spec: WorkflowSpec;
}

export const WORKFLOW_SPEC_TEMPLATES: Record<WorkflowTemplateName, WorkflowSpecTemplate> = {
  "research-implement-verify": {
    name: "research-implement-verify",
    version: 1,
    description: "Pipeline for one focused change: inspect context, implement the change, then verify behavior.",
    spec: {
      mode: "pipeline",
      budgetPolicyPreset: "safe-write",
      tasks: [
        { id: "research", description: "Inspect the relevant code and identify the minimal change." },
        { id: "implement", description: "Apply the focused code change.", writeScope: ["."], isolate: true },
        { id: "verify", description: "Run targeted checks and summarize the result.", readOnly: true },
      ],
    },
  },
  "parallel-review": {
    name: "parallel-review",
    version: 1,
    description: "Parallel read-only review for independent areas before a Coordinator summary.",
    spec: {
      mode: "parallel",
      maxConcurrency: 3,
      budgetPolicyPreset: "cheap-review",
      tasks: [
        { id: "review-code", description: "Review implementation risks.", readOnly: true },
        { id: "review-tests", description: "Review test coverage and likely gaps.", readOnly: true },
        { id: "review-docs", description: "Review documentation or user-facing contract impact.", readOnly: true },
      ],
    },
  },
  "safe-write": {
    name: "safe-write",
    version: 1,
    description: "Serial write workflow for risky edits where each step should finish before the next begins.",
    spec: {
      mode: "sequential",
      budgetPolicyPreset: "safe-write",
      failurePolicy: "fail-fast",
      tasks: [
        { id: "plan", description: "Confirm exact files and risk before editing.", readOnly: true },
        { id: "write", description: "Make the smallest safe edit.", writeScope: ["."], isolate: true },
        { id: "check", description: "Run checks and report remaining risk.", readOnly: true },
      ],
    },
  },
};

export interface WorkflowValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  taskIds?: string[];
}

export interface WorkflowValidationReport {
  valid: boolean;
  issues: WorkflowValidationIssue[];
  plan?: WorkflowPlan;
}

