import type {
  PermissionRequestRecord,
  ProjectionSettlementRecord,
  SessionExecutionRecord,
  SessionMessagePartRecord,
  SessionRunAttemptRecord,
  SessionRunRecord,
} from "@vykor/protocol";

export interface RuntimeMetricHistogram {
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface RuntimeMetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, RuntimeMetricHistogram>;
}

export function emptyRuntimeMetricsSnapshot(): RuntimeMetricsSnapshot {
  return { counters: {}, gauges: {}, histograms: {} };
}

/** Builds bounded-label operational metrics from durable facts; never throws into runtime execution. */
export function buildRuntimeMetricsSnapshot(input: {
  runs: SessionRunRecord[];
  attempts: SessionRunAttemptRecord[];
  parts: SessionMessagePartRecord[];
  tasks: SessionExecutionRecord[];
  permissions: PermissionRequestRecord[];
  settlements: ProjectionSettlementRecord[];
  workflows?: Array<{ status: string; createdAt: number; updatedAt: number }>;
}): RuntimeMetricsSnapshot {
  try {
    const result = emptyRuntimeMetricsSnapshot();
    for (const run of input.runs) {
      increment(result.counters, metric("vykor_runs_total", { status: run.status }));
      observe(result.histograms, "vykor_run_duration_ms", duration(run.startedAt, run.finishedAt));
    }
    result.gauges.vykor_runs_active = input.runs.filter((run) => run.status === "pending" || run.status === "running").length;
    for (const attempt of input.attempts) {
      const labels = { provider: attempt.provider ?? "unknown", model: attempt.model ?? "unknown", status: attempt.status };
      increment(result.counters, metric("vykor_run_attempts_total", labels));
      observe(result.histograms, metric("vykor_model_request_duration_ms", labels), duration(attempt.startedAt, attempt.finishedAt));
      incrementBy(result.counters, metric("vykor_tokens_total", { provider: labels.provider, model: labels.model, direction: "input" }), attempt.inputTokens ?? 0);
      incrementBy(result.counters, metric("vykor_tokens_total", { provider: labels.provider, model: labels.model, direction: "output" }), attempt.outputTokens ?? 0);
    }
    for (const part of input.parts.filter((part) => part.type === "tool")) {
      const failureKind = typeof part.metadata.failureKind === "string" ? part.metadata.failureKind : "none";
      increment(result.counters, metric("vykor_tool_calls_total", {
        tool: part.toolName ?? "unknown",
        status: part.status,
        failure_kind: failureKind,
      }));
      observe(result.histograms, metric("vykor_tool_call_duration_ms", { tool: part.toolName ?? "unknown" }), duration(part.createdAt, part.updatedAt));
    }
    result.gauges.vykor_permissions_pending = input.permissions.filter((row) => row.status === "pending").length;
    result.gauges.vykor_child_agents_active = input.tasks.filter((row) =>
      row.type === "agent" && (row.status === "pending" || row.status === "running")).length;
    result.gauges.vykor_workflows_active = (input.workflows ?? []).filter((row) => row.status === "running").length;
    for (const workflow of input.workflows ?? []) {
      increment(result.counters, metric("vykor_workflows_total", { status: workflow.status }));
      if (workflow.status !== "running") {
        observe(result.histograms, "vykor_workflow_duration_ms", duration(workflow.createdAt, workflow.updatedAt));
      }
    }
    result.gauges.vykor_projection_settlements_pending = input.settlements.filter((row) =>
      row.status === "pending" || row.status === "retrying").length;
    for (const row of input.settlements) {
      incrementBy(result.counters, metric("vykor_projection_failures_total", {
        projector: row.projector,
        action: row.action,
      }), row.attemptCount);
    }
    return result;
  } catch {
    return emptyRuntimeMetricsSnapshot();
  }
}

function metric(name: string, labels: Record<string, string>): string {
  const suffix = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",");
  return suffix ? `${name}{${suffix}}` : name;
}

function increment(target: Record<string, number>, key: string): void { incrementBy(target, key, 1); }
function incrementBy(target: Record<string, number>, key: string, value: number): void {
  target[key] = (target[key] ?? 0) + value;
}
function duration(startedAt?: number, finishedAt?: number): number | undefined {
  return startedAt !== undefined && finishedAt !== undefined ? Math.max(0, finishedAt - startedAt) : undefined;
}
function observe(target: Record<string, RuntimeMetricHistogram>, key: string, value?: number): void {
  if (value === undefined) return;
  const current = target[key];
  target[key] = current
    ? { count: current.count + 1, sum: current.sum + value, min: Math.min(current.min, value), max: Math.max(current.max, value) }
    : { count: 1, sum: value, min: value, max: value };
}
