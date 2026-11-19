import { ScheduleResource } from "./schedule-resource"
import type {
  CreateDesktopScheduledTaskInput,
  DesktopScheduledRun,
  DesktopScheduledStatus,
  DesktopScheduledTask,
  ListDesktopScheduledRunsInput,
  UpdateDesktopScheduledTaskInput,
} from "../../../shared/schedule-types"

import { desktopSessionService } from "../session/session-service"

class DesktopScheduleService {
  status(): Promise<DesktopScheduledStatus> {
    return withDaemonRetry((client) => client.getStatus())
  }

  list(): Promise<DesktopScheduledTask[]> {
    return withDaemonRetry((client) => client.listTasks())
  }

  create(input: CreateDesktopScheduledTaskInput): Promise<DesktopScheduledTask> {
    return withDaemonRetry((client) => client.createTask(input))
  }

  update(id: string, input: UpdateDesktopScheduledTaskInput): Promise<DesktopScheduledTask> {
    return withDaemonRetry((client) => client.updateTask(id, input))
  }

  async remove(id: string): Promise<void> {
    await withDaemonRetry((client) => client.removeTask(id))
  }

  runNow(id: string): Promise<DesktopScheduledRun> {
    return withDaemonRetry((client) => client.triggerTask(id))
  }

  listRuns(input: ListDesktopScheduledRunsInput): Promise<DesktopScheduledRun[]> {
    return withDaemonRetry((client) => client.listRuns(input))
  }

  setRunUnread(id: string, unread: boolean): Promise<DesktopScheduledRun> {
    return withDaemonRetry((client) => client.setRunUnread(id, unread))
  }
}

export const desktopScheduleService = new DesktopScheduleService()

async function withDaemonRetry<T>(
  operation: (client: ScheduleResource) => Promise<T>
): Promise<T> {
  try {
    return await operation(new ScheduleResource(await desktopSessionService.daemonTransport()))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !message.includes("Failed to fetch") &&
      !message.includes("ECONNREFUSED") &&
      !message.includes("ECONNRESET")
    ) {
      throw error
    }
    return await operation(new ScheduleResource(await desktopSessionService.refreshDaemonTransport()))
  }
}
