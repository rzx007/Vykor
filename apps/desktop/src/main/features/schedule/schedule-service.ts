import type { OpenHarnessClient } from "@openharness/client"
import type {
  CreateDesktopScheduledTaskInput,
  DesktopScheduledRun,
  DesktopScheduledStatus,
  DesktopScheduledTask,
  ListDesktopScheduledRunsInput,
  UpdateDesktopScheduledTaskInput,
} from "../../../shared/schedule-types"

import { desktopSessionService } from "../session/session-service"

type ScheduleClient = Pick<OpenHarnessClient, "schedules">

class DesktopScheduleService {
  status(): Promise<DesktopScheduledStatus> {
    return withDaemonRetry((client) => client.schedules.getStatus())
  }

  list(): Promise<DesktopScheduledTask[]> {
    return withDaemonRetry((client) => client.schedules.listTasks())
  }

  create(input: CreateDesktopScheduledTaskInput): Promise<DesktopScheduledTask> {
    return withDaemonRetry((client) => client.schedules.createTask(input))
  }

  update(id: string, input: UpdateDesktopScheduledTaskInput): Promise<DesktopScheduledTask> {
    return withDaemonRetry((client) => client.schedules.updateTask(id, input))
  }

  async remove(id: string): Promise<void> {
    await withDaemonRetry((client) => client.schedules.removeTask(id))
  }

  runNow(id: string): Promise<DesktopScheduledRun> {
    return withDaemonRetry((client) => client.schedules.triggerTask(id))
  }

  listRuns(input: ListDesktopScheduledRunsInput): Promise<DesktopScheduledRun[]> {
    return withDaemonRetry((client) => client.schedules.listRuns(input))
  }

  setRunUnread(id: string, unread: boolean): Promise<DesktopScheduledRun> {
    return withDaemonRetry((client) => client.schedules.setRunUnread(id, unread))
  }
}

export const desktopScheduleService = new DesktopScheduleService()

async function withDaemonRetry<T>(
  operation: (client: ScheduleClient) => Promise<T>
): Promise<T> {
  try {
    return await operation(await desktopSessionService.daemonClient())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !message.includes("Failed to fetch") &&
      !message.includes("ECONNREFUSED") &&
      !message.includes("ECONNRESET")
    ) {
      throw error
    }
    return await operation(await desktopSessionService.refreshDaemonClient())
  }
}
