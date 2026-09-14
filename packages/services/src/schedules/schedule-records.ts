import type { ScheduledRunRecord, ScheduledTaskRecord } from "@openharness/protocol";

export const encodeScheduleValue = (value: unknown): string => JSON.stringify(value ?? {});

export function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export function scheduledTaskFromRow(row: Record<string, unknown>): ScheduledTaskRecord {
  return {
    id: row.id as string, name: row.name as string,
    ...(row.description ? { description: row.description as string } : {}),
    prompt: row.prompt as string, recurrence: row.recurrence as string,
    recurrenceFormat: row.recurrence_format as ScheduledTaskRecord["recurrenceFormat"],
    timezone: row.timezone as string, status: row.status as ScheduledTaskRecord["status"],
    destination: row.destination as ScheduledTaskRecord["destination"],
    ...(row.session_id ? { sessionId: row.session_id as string } : {}),
    projectPaths: parseJson<string[]>(row.project_paths_json, []),
    executionMode: row.execution_mode as ScheduledTaskRecord["executionMode"],
    ...(row.model ? { model: row.model as string } : {}),
    ...(row.effort ? { effort: row.effort as string } : {}),
    skillNames: parseJson<string[]>(row.skill_names_json, []),
    pluginNames: parseJson<string[]>(row.plugin_names_json, []),
    permissionProfile: parseJson<ScheduledTaskRecord["permissionProfile"]>(row.permission_profile_json, { mode: "workspace_write" }),
    overlapPolicy: row.overlap_policy as ScheduledTaskRecord["overlapPolicy"],
    missedRunPolicy: row.missed_run_policy as ScheduledTaskRecord["missedRunPolicy"],
    ...(row.stop_policy_json ? { stopPolicy: parseJson(row.stop_policy_json, {}) } : {}),
    createdBy: row.created_by as ScheduledTaskRecord["createdBy"],
    ...(row.created_from_session_id ? { createdFromSessionId: row.created_from_session_id as string } : {}),
    ...(row.last_run_at ? { lastRunAt: row.last_run_at as number } : {}),
    ...(row.next_run_at ? { nextRunAt: row.next_run_at as number } : {}),
    runCount: row.run_count as number, createdAt: row.created_at as number, updatedAt: row.updated_at as number,
  };
}

export function scheduledRunFromRow(row: Record<string, unknown>): ScheduledRunRecord {
  return {
    id: row.id as string, taskId: row.task_id as string,
    cause: row.cause as ScheduledRunRecord["cause"], status: row.status as ScheduledRunRecord["status"],
    scheduledFor: row.scheduled_for as number,
    ...(row.session_id ? { sessionId: row.session_id as string } : {}),
    ...(row.run_id ? { runId: row.run_id as string } : {}),
    ...(row.summary ? { summary: row.summary as string } : {}),
    ...(row.error ? { error: row.error as string } : {}), unread: row.unread === 1,
    ...(row.attention_reason ? { attentionReason: row.attention_reason as string } : {}),
    createdAt: row.created_at as number,
    ...(row.started_at ? { startedAt: row.started_at as number } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at as number } : {}),
    updatedAt: row.updated_at as number,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
