/** Schedule operations accepted by the application; storage commands remain Services-owned. */
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
