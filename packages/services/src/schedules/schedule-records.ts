import type {
  ScheduledRunRecord,
  ScheduledTaskRecord,
} from "@vykor/protocol";
import type { scheduledRuns, scheduledTasks } from "../session-runtime/schema.js";

export const encodeScheduleValue = (value: unknown): string =>
  JSON.stringify(value ?? {});

export function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

export function scheduledTaskFromRow(
  row: typeof scheduledTasks.$inferSelect,
): ScheduledTaskRecord {
  return {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    prompt: row.prompt,
    recurrence: row.recurrence,
    recurrenceFormat:
      row.recurrenceFormat as ScheduledTaskRecord["recurrenceFormat"],
    timezone: row.timezone,
    status: row.status as ScheduledTaskRecord["status"],
    destination: row.destination as ScheduledTaskRecord["destination"],
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    projectPaths: parseJson<string[]>(row.projectPathsJson, []),
    executionMode: row.executionMode as ScheduledTaskRecord["executionMode"],
    ...(row.model ? { model: row.model } : {}),
    ...(row.effort ? { effort: row.effort } : {}),
    skillNames: parseJson<string[]>(row.skillNamesJson, []),
    pluginNames: parseJson<string[]>(row.pluginNamesJson, []),
    permissionProfile: parseJson<ScheduledTaskRecord["permissionProfile"]>(
      row.permissionProfileJson,
      { mode: "workspace_write" },
    ),
    overlapPolicy: row.overlapPolicy as ScheduledTaskRecord["overlapPolicy"],
    missedRunPolicy:
      row.missedRunPolicy as ScheduledTaskRecord["missedRunPolicy"],
    ...(row.stopPolicyJson
      ? { stopPolicy: parseJson(row.stopPolicyJson, {}) }
      : {}),
    createdBy: row.createdBy as ScheduledTaskRecord["createdBy"],
    ...(row.createdFromSessionId
      ? { createdFromSessionId: row.createdFromSessionId }
      : {}),
    ...(row.lastRunAt ? { lastRunAt: row.lastRunAt } : {}),
    ...(row.nextRunAt ? { nextRunAt: row.nextRunAt } : {}),
    runCount: row.runCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function scheduledRunFromRow(
  row: typeof scheduledRuns.$inferSelect,
): ScheduledRunRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    cause: row.cause as ScheduledRunRecord["cause"],
    status: row.status as ScheduledRunRecord["status"],
    scheduledFor: row.scheduledFor,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.error ? { error: row.error } : {}),
    unread: row.unread === 1,
    ...(row.attentionReason
      ? { attentionReason: row.attentionReason }
      : {}),
    createdAt: row.createdAt,
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
    updatedAt: row.updatedAt,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
