import { createWorkflowNotification, createWorkflowResultFromSnapshot, type WorkflowRunSnapshot } from "@vykor/coordinator";
import type { JobKind, JobReadResult, JobSnapshot, JobStatus } from "@vykor/jobs";
import type { SessionExecutionRecord } from "@vykor/protocol";
import type { TerminalSessionInfo } from "@vykor/terminal";

const DEFAULT_OUTPUT_LIMIT = 12_000;

export function terminalSnapshot(terminal: TerminalSessionInfo): JobSnapshot {
  const updated = terminal.exitedAt ?? terminal.createdAt;
  return {
    id: terminal.id,
    kind: "terminal",
    label: terminal.name,
    ownerSession: terminal.sessionId!,
    status: terminal.status,
    capabilities: { read: true, wait: true, send: terminal.status === "running", cancel: terminal.status === "running" },
    cwd: terminal.cwd,
    startedAt: Date.parse(terminal.createdAt),
    updatedAt: Date.parse(updated),
    ...(terminal.exitedAt ? { finishedAt: Date.parse(terminal.exitedAt) } : {}),
    ...(terminal.exitCode !== undefined ? { detail: `exit code: ${terminal.exitCode ?? "signal"}` } : {}),
    ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
    metadata: { runtime: terminal.runtime, shell: terminal.shell, source: terminal.source },
  };
}

export function taskSnapshot(task: SessionExecutionRecord): JobSnapshot {
  return {
    id: task.id,
    kind: taskKind(task.type),
    label: task.description,
    ownerSession: task.sessionId,
    status: taskStatus(task.status),
    capabilities: {
      read: true,
      wait: true,
      send: taskAcceptsInput(task),
      cancel: task.status === "pending" || task.status === "running",
    },
    cwd: task.cwd,
    startedAt: task.startedAt ?? task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.error ? { detail: task.error } : {}),
    ...(task.status !== "pending" && task.status !== "running" &&
      task.metadata.executionBackend === "detached_process" &&
      (task.metadata.processExitCode === null ||
        (typeof task.metadata.processExitCode === "number" && Number.isInteger(task.metadata.processExitCode)))
      ? { exitCode: task.metadata.processExitCode as number | null } : {}),
    metadata: { ...task.metadata, ...(task.childSessionId ? { childSessionId: task.childSessionId } : {}) },
  };
}

export function workflowSnapshot(workflow: WorkflowRunSnapshot, cwd: string): JobSnapshot {
  const cancelled = workflow.termination === "cancelled";
  return {
    id: qualifiedWorkflowId(workflow.runId),
    kind: "workflow",
    label: workflow.summary,
    ownerSession: workflow.ownerSession!,
    status: workflow.status === "running" ? "running" : cancelled ? "killed" : workflow.status,
    capabilities: { read: true, wait: true, send: false, cancel: workflow.status === "running" },
    cwd,
    startedAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    ...(workflow.status !== "running" ? { finishedAt: workflow.updatedAt } : {}),
    metadata: {
      mode: workflow.plan.mode,
      totalTasks: workflow.plan.tasks.length,
      runningTasks: workflow.runningTaskIds.length,
      pendingTasks: workflow.pendingTaskIds.length,
    },
  };
}

function taskKind(type: string): JobKind {
  return type === "shell" || type === "dream" ? type : "agent";
}

function taskStatus(status: SessionExecutionRecord["status"]): JobStatus {
  if (status === "completed" || status === "failed") return status;
  if (status === "stopped" || status === "interrupted") return "killed";
  return "running";
}

export function taskAcceptsInput(task: SessionExecutionRecord): boolean {
  return task.type === "agent" && task.status !== "stopped" && task.status !== "interrupted";
}

export function runtimeExecutionId(task: SessionExecutionRecord): string {
  if (typeof task.metadata.runtimeExecutionId === "string") return task.metadata.runtimeExecutionId;
  if (typeof task.metadata.taskManagerId === "string") return task.metadata.taskManagerId;
  return task.id;
}

export function executionBackend(task: SessionExecutionRecord): "detached_process" | "child_agent" {
  if (task.metadata.executionBackend === "child_agent") return "child_agent";
  if (task.metadata.executionBackend === "detached_process") return "detached_process";
  return task.metadata.origin === "child_session" ? "child_agent" : "detached_process";
}

export function isDetachedProcessAgentTask(task: SessionExecutionRecord): boolean {
  if (
    task.childSessionId ||
    task.metadata.executionBackend === "child_agent" ||
    task.metadata.origin === "child_session"
  ) {
    return false;
  }
  return task.type === "shell" ||
    task.metadata.executionBackend === "detached_process";
}

export function formatWorkflowOutput(workflow: WorkflowRunSnapshot): string {
  return JSON.stringify({
    summary: workflow.summary,
    status: workflow.status,
    pendingTaskIds: workflow.pendingTaskIds,
    runningTaskIds: workflow.runningTaskIds,
    results: workflow.orderedResults,
  }, null, 2);
}

export function workflowDetails(workflow: WorkflowRunSnapshot): Record<string, unknown> {
  const notification = createWorkflowNotification(createWorkflowResultFromSnapshot(workflow));
  return {
    status: workflow.status,
    termination: workflow.termination,
    plan: workflow.plan,
    pendingTaskIds: workflow.pendingTaskIds,
    blockedTaskIds: workflow.blockedTaskIds,
    blockedTasks: workflow.blockedTasks,
    runningTaskIds: workflow.runningTaskIds,
    runningTasks: workflow.runningTasks,
    results: workflow.results,
    budget: workflow.budget,
    needsReconciliation: notification.needsReconciliation,
    reconciliationIssues: notification.reconciliationIssues,
    reconciliationSummary: notification.reconciliationSummary,
    reconciliationPlan: notification.reconciliationPlan,
  };
}

export function normalizeLimit(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value)
    ? DEFAULT_OUTPUT_LIMIT
    : Math.max(1, Math.floor(value));
}

export function limitOutput(text: string, maxChars = DEFAULT_OUTPUT_LIMIT): Pick<JobReadResult, "text" | "truncated"> {
  const limit = normalizeLimit(maxChars);
  return text.length > limit ? { text: text.slice(-limit), truncated: true } : { text, truncated: false };
}

export function isFinished(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

export function readChildFailure(task: SessionExecutionRecord): Record<string, unknown> | undefined {
  const value = task.metadata.childFailure;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function qualifiedWorkflowId(runId: string): string {
  return `workflow:${runId}`;
}
