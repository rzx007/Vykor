import { runtimeMetadataChanged } from "@vykor/protocol";

import type { RuntimeMetricsSnapshot } from "../shared/runtime-metrics.js";

export const DAEMON_RESTART_RUN_REASON = "Daemon restarted before the run completed";
export const DAEMON_RESTART_INPUT_REASON = "Daemon restarted before the input was assigned to a run";
export const DAEMON_RESTART_TASK_REASON = "Daemon restarted before the task completed";
export const DAEMON_RESTART_PERMISSION_REASON = "Daemon restarted before the permission was resolved";
export const DAEMON_RESTART_WORKFLOW_REASON = "Daemon restarted before the workflow completed";

export interface VykorRuntimeSnapshot {
  startedAt: number;
  uptimeMs: number;
  sessions: { total: number; byStatus: Record<string, number> };
  runs: { total: number; byStatus: Record<string, number> };
  tasks: { total: number; byStatus: Record<string, number> };
  workflows: { total: number; byStatus: Record<string, number> };
  permissions: { total: number; byStatus: Record<string, number> };
  projectionSettlements: { total: number; pending: number; byStatus: Record<string, number> };
  sseClientCount: number;
  warmAgentCount: number;
  coordinator: { activeRunCount: number; queuedRunCount: number };
  metrics: RuntimeMetricsSnapshot;
}

export function runtimeSessionMetadataChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  return runtimeMetadataChanged(before, after);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeTraceId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : undefined;
}

export function withoutTraceId(metadata: Record<string, unknown>): Record<string, unknown> {
  const { traceId: _traceId, ...rest } = metadata;
  return rest;
}

export function countByStatus(records: ReadonlyArray<{ status: string }>): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    return counts;
  }, {});
}

export function workflowRunIdFromSessionEvent(event: {
  payload: Record<string, unknown>;
}): string | undefined {
  const workflowEvent = event.payload.event;
  return isRecord(workflowEvent) && typeof workflowEvent.runId === "string"
    ? workflowEvent.runId
    : undefined;
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every(
      (value, index) => jsonEqual(value, right[index]),
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]),
    );
  }
  return false;
}
