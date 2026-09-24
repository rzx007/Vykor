import { useEffect, useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { JobReadResult, JobSnapshot } from "@vykor/client";
import { useListNavigation } from "../hooks/useListNavigation";
import type { JobDetailRemoteState, JobRemoteState } from "../jobs/job-remote-state";
import { useTheme } from "../theme/ThemeContext";

export interface JobsPanelProps {
  state: JobRemoteState;
  detailState: JobDetailRemoteState;
  onRefresh(): void;
  onSelect(jobId: string): void;
  onCancel(jobId: string): void;
}

type JobKindFilter = JobSnapshot["kind"] | undefined;
type JobStatusFilter = JobSnapshot["status"] | undefined;
type WorkflowStepRow = { taskId: string; status: string; summary?: string };

const VISIBLE_JOBS = 7;
const VISIBLE_OUTPUT_LINES = 6;
const VISIBLE_WORKFLOW_STEPS = 5;
const JOB_KINDS: JobSnapshot["kind"][] = ["terminal", "shell", "agent", "dream", "workflow"];
const JOB_STATUSES: JobSnapshot["status"][] = ["running", "stopping", "completed", "killed", "failed"];

export function JobsPanel({ state, detailState, onRefresh, onSelect, onCancel }: JobsPanelProps) {
  const { theme } = useTheme();
  const c = theme.colors;
  const [kindFilter, setKindFilter] = useState<JobKindFilter>();
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>();
  const visibleJobs = useMemo(
    () => state.jobs.filter((job) => (!kindFilter || job.kind === kindFilter) && (!statusFilter || job.status === statusFilter)),
    [kindFilter, state.jobs, statusFilter],
  );
  const { index, setIndex, moveUp, moveDown } = useListNavigation(visibleJobs.length);
  const cursorIndex = Math.min(index, Math.max(0, visibleJobs.length - 1));
  const selectedJob = visibleJobs[cursorIndex];

  useEffect(() => {
    if (index !== cursorIndex) setIndex(cursorIndex);
  }, [cursorIndex, index, setIndex]);

  useKeyboard((key) => {
    if (key.name === "up") { moveUp(); return; }
    if (key.name === "down") { moveDown(); return; }
    if (key.name === "return" && selectedJob) { onSelect(selectedJob.id); return; }
    if (key.name === "r") { onRefresh(); return; }
    if (key.name === "c" && selectedJob?.capabilities.cancel) { onCancel(selectedJob.id); return; }
    if (key.name === "k") {
      setKindFilter((current) => nextFilter(JOB_KINDS, current));
      setIndex(0);
      return;
    }
    if (key.name === "f") {
      setStatusFilter((current) => nextFilter(JOB_STATUSES, current));
      setIndex(0);
    }
  });

  const windowStart = Math.max(0, Math.min(cursorIndex - 3, Math.max(0, visibleJobs.length - VISIBLE_JOBS)));
  const jobWindow = visibleJobs.slice(windowStart, windowStart + VISIBLE_JOBS);

  return (
    <box flexDirection="column">
      <text attributes={TextAttributes.BOLD} fg={c.accent}>Jobs</text>
      <text fg={c.muted}>r refresh  enter detail  c cancel  k kind  f status</text>
      <text fg={c.muted}>{formatListSummary(state.jobs.length, visibleJobs.length, kindFilter, statusFilter)}</text>
      <ListRemoteState state={state} />
      {visibleJobs.length > 0 ? (
        <box flexDirection="column">
          {jobWindow.map((job, visibleIndex) => {
            const isCursor = windowStart + visibleIndex === cursorIndex;
            return <JobRow key={job.id} job={job} selected={isCursor} />;
          })}
        </box>
      ) : state.status === "ready" || state.status === "idle" ? (
        <text fg={c.muted}>{state.status === "ready" ? "No Jobs in this session" : "Jobs have not been loaded"}</text>
      ) : null}
      {detailState.status === "idle" ? null : <JobDetail state={detailState} />}
    </box>
  );
}

function ListRemoteState({ state }: { state: JobRemoteState }) {
  const { theme } = useTheme();
  const c = theme.colors;
  if (state.status === "loading") return <text fg={c.warning}>Loading Jobs</text>;
  if (state.status === "error") {
    return (
      <box flexDirection="column">
        <text fg={c.error}>{`Jobs unavailable: ${state.error}`}</text>
        {state.jobs.length > 0 ? <text fg={c.warning}>Showing cached Jobs</text> : null}
      </box>
    );
  }
  return null;
}

function JobRow({ job, selected }: { job: JobSnapshot; selected: boolean }) {
  const { theme } = useTheme();
  const c = theme.colors;
  const marker = statusMarker(job.status);
  const foreground = selected ? c.background : statusColor(job.status, c);
  return (
    <box flexDirection="column" backgroundColor={selected ? c.accent : undefined}>
      <text fg={foreground}>{`${marker} ${job.kind} ${job.status} ${truncate(job.label, 50)}`}</text>
      <text fg={selected ? c.background : c.muted}>{`  ${truncate(job.id, 24)}  ${truncate(job.cwd, 44)}`}</text>
    </box>
  );
}

function JobDetail({ state }: { state: Exclude<JobDetailRemoteState, { status: "idle" }> }) {
  const { theme } = useTheme();
  const c = theme.colors;
  if (state.status === "loading") {
    return (
      <box flexDirection="column">
        <text fg={c.warning}>Loading detail…</text>
        {state.previous ? <DetailResult result={state.previous} /> : null}
      </box>
    );
  }
  if (state.status === "error") {
    return (
      <box flexDirection="column">
        <text fg={c.error}>{`Detail unavailable: ${state.error}`}</text>
        {state.previous ? <DetailResult result={state.previous} /> : null}
      </box>
    );
  }
  return <DetailResult result={state.result} />;
}

function DetailResult({ result }: { result: JobReadResult }) {
  const { theme } = useTheme();
  const c = theme.colors;
  const { snapshot } = result;
  const steps = snapshot.kind === "workflow" ? workflowSteps(result.details) : [];
  const reconciliation = snapshot.kind === "workflow" ? reconciliationSummary(result.details) : undefined;
  return (
    <box flexDirection="column">
      <text>{" "}</text>
      <text attributes={TextAttributes.BOLD} fg={c.muted}>DETAIL</text>
      <text fg={statusColor(snapshot.status, c)}>{`${snapshot.kind} ${snapshot.status} ${snapshot.label}`}</text>
      <text fg={c.muted}>{`id: ${snapshot.id}`}</text>
      <text fg={c.muted}>{`cwd: ${snapshot.cwd}`}</text>
      <text fg={c.muted}>{`started: ${new Date(snapshot.startedAt).toISOString()}`}</text>
      {lastOutputLines(result.text).map((line, index) => <text key={`${index}-${line}`} fg={c.foreground}>{line}</text>)}
      {snapshot.kind === "workflow" && steps.length > 0 ? (
        <box flexDirection="column">
          <text attributes={TextAttributes.BOLD} fg={c.muted}>STEPS</text>
          {steps.slice(0, VISIBLE_WORKFLOW_STEPS).map((step) => (
            <text key={step.taskId} fg={statusColor(step.status, c)}>
              {`${step.taskId} ${step.status}${step.summary ? ` ${step.summary}` : ""}`}
            </text>
          ))}
          {steps.length > VISIBLE_WORKFLOW_STEPS ? <text fg={c.muted}>{`+${steps.length - VISIBLE_WORKFLOW_STEPS} steps`}</text> : null}
        </box>
      ) : null}
      {reconciliation ? <text fg={c.warning}>{reconciliation}</text> : null}
    </box>
  );
}

function nextFilter<T extends string>(values: readonly T[], current: T | undefined): T | undefined {
  if (!current) return values[0];
  const currentIndex = values.indexOf(current);
  if (currentIndex < 0 || currentIndex === values.length - 1) return undefined;
  return values[currentIndex + 1];
}

function formatListSummary(total: number, visible: number, kind: JobKindFilter, status: JobStatusFilter): string {
  const filters = [kind ? `kind=${kind}` : undefined, status ? `status=${status}` : undefined]
    .filter((value): value is string => value !== undefined);
  return `${visible}/${total} Jobs${filters.length ? `  ${filters.join(" ")}` : ""}`;
}

function statusMarker(status: JobSnapshot["status"]): string {
  if (status === "completed") return "✓";
  if (status === "killed") return "■";
  if (status === "failed") return "✗";
  return "●";
}

function statusColor(
  status: string,
  colors: { success: string; warning: string; error: string; muted: string },
): string {
  if (status === "running" || status === "completed") return colors.success;
  if (status === "failed") return colors.error;
  if (status === "stopping" || status === "killed") return colors.warning;
  return colors.muted;
}

function lastOutputLines(text: string): string[] {
  if (!text) return [];
  return text.split(/\r?\n/).slice(-VISIBLE_OUTPUT_LINES);
}

function workflowSteps(details: Record<string, unknown> | undefined): WorkflowStepRow[] {
  if (!isRecord(details) || !isRecord(details.plan) || !Array.isArray(details.plan.tasks)) return [];
  const results = isRecord(details.results) ? details.results : {};
  const runningTasks = isRecord(details.runningTasks) ? details.runningTasks : {};
  const blockedTasks = isRecord(details.blockedTasks) ? details.blockedTasks : {};
  const pendingTaskIds = stringSet(details.pendingTaskIds);
  const runningTaskIds = stringSet(details.runningTaskIds);
  const blockedTaskIds = stringSet(details.blockedTaskIds);

  return details.plan.tasks.flatMap((task): WorkflowStepRow[] => {
    if (!isRecord(task)) return [];
    const taskId = nonEmptyString(task.taskId) ?? nonEmptyString(task.id);
    if (!taskId) return [];
    const result = isRecord(results[taskId]) ? results[taskId] : undefined;
    const running = isRecord(runningTasks[taskId]) ? runningTasks[taskId] : undefined;
    const blocked = isRecord(blockedTasks[taskId]) ? blockedTasks[taskId] : undefined;
    const status = nonEmptyString(task.status)
      ?? nonEmptyString(result?.status)
      ?? (blockedTaskIds.has(taskId) || blocked ? "blocked" : undefined)
      ?? (runningTaskIds.has(taskId) || running ? "running" : undefined)
      ?? (pendingTaskIds.has(taskId) ? "pending" : "pending");
    const summary = nonEmptyString(task.summary)
      ?? nonEmptyString(result?.summary)
      ?? nonEmptyString(running?.summary)
      ?? nonEmptyString(blocked?.reason)
      ?? nonEmptyString(task.description);
    return [{ taskId, status, ...(summary ? { summary } : {}) }];
  });
}

function reconciliationSummary(details: Record<string, unknown> | undefined): string | undefined {
  if (!isRecord(details)) return undefined;
  const reconciliation = isRecord(details.reconciliation) ? details.reconciliation : undefined;
  const plan = isRecord(details.reconciliationPlan) ? details.reconciliationPlan : undefined;
  const summary = isRecord(details.reconciliationSummary) ? details.reconciliationSummary : undefined;
  return nonEmptyString(reconciliation?.summary)
    ?? nonEmptyString(plan?.summary)
    ?? nonEmptyString(summary?.summary);
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}
