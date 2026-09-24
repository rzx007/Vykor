import type {
  CreateScheduledTaskInput,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  ScheduledTaskStatusSummary,
  UpdateScheduledTaskInput,
} from "@vykor/client"

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
