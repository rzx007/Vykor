import type {
  CreateScheduledTaskInput,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  UpdateScheduledTaskInput,
} from "@vykor/protocol"

export type DesktopScheduledTask = ScheduledTaskRecord
export type DesktopScheduledRun = ScheduledRunRecord
export type DesktopScheduledStatus = ScheduledTaskStatusSummary
export type CreateDesktopScheduledTaskInput = CreateScheduledTaskInput
export type UpdateDesktopScheduledTaskInput = UpdateScheduledTaskInput

export interface ListDesktopScheduledRunsInput {
  taskId?: string
  unread?: boolean
  limit?: number
}

export interface ScheduledTaskStatusSummary {
  running: true;
  tasks: number;
  active: number;
  paused: number;
  executing: number;
  unread: number;
}
