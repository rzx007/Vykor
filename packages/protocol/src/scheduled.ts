export { type ScheduledTaskStatus, type ScheduledTaskDestination, type ScheduledTaskExecutionMode, type ScheduledRecurrenceFormat, type ScheduledOverlapPolicy, type ScheduledMissedRunPolicy, type ScheduledPermissionProfile, type ScheduledStopPolicy, type ScheduledTaskRecord, type ScheduledRunCause, type ScheduledRunStatus, type ScheduledRunRecord } from "@vykor/domain-contracts/schedules";
import type { ScheduledTaskStatus, ScheduledTaskDestination, ScheduledTaskExecutionMode, ScheduledRecurrenceFormat, ScheduledOverlapPolicy, ScheduledMissedRunPolicy, ScheduledPermissionProfile, ScheduledStopPolicy, ScheduledTaskRecord, ScheduledRunCause, ScheduledRunStatus } from "@vykor/domain-contracts/schedules";
export interface CreateScheduledTaskInput {
  id?: string;
  name: string;
  description?: string;
  prompt: string;
  recurrence: string;
  recurrenceFormat: ScheduledRecurrenceFormat;
  timezone: string;
  status?: ScheduledTaskStatus;
  destination: ScheduledTaskDestination;
  sessionId?: string;
  projectPaths?: string[];
  executionMode?: ScheduledTaskExecutionMode;
  model?: string;
  effort?: string;
  skillNames?: string[];
  pluginNames?: string[];
  permissionProfile?: ScheduledPermissionProfile;
  overlapPolicy?: ScheduledOverlapPolicy;
  missedRunPolicy?: ScheduledMissedRunPolicy;
  stopPolicy?: ScheduledStopPolicy;
  createdBy?: ScheduledTaskRecord["createdBy"];
  createdFromSessionId?: string;
  nextRunAt?: number;
}

export type UpdateScheduledTaskInput = Partial<
  Omit<CreateScheduledTaskInput, "id" | "nextRunAt">
> & {
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  runCount?: number;
};
