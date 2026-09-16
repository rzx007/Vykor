import type {
  CreateScheduledTaskInput,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  UpdateScheduledTaskInput,
} from "@openharness/protocol";
import type { HttpTransport } from "../transport/http-transport.js";
import type { ScheduledTaskStatusSummary } from "../types/index.js";

export class ScheduleResource {
  constructor(private readonly transport: HttpTransport) {}

  async getStatus(
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledTaskStatusSummary> {
    return await this.transport.request<ScheduledTaskStatusSummary>("/schedules/status", {
      signal: options.signal,
    });
  }

  async listTasks(
    options: {
      status?: ScheduledTaskRecord["status"];
      signal?: AbortSignal;
    } = {},
  ): Promise<ScheduledTaskRecord[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{ tasks: ScheduledTaskRecord[] }>(
      this.transport.path("/schedules/tasks", query),
      { signal },
    );
    return response.tasks;
  }

  async getTask(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledTaskRecord> {
    const response = await this.transport.request<{ task: ScheduledTaskRecord }>(
      `/schedules/tasks/${encodeURIComponent(id)}`,
      { signal: options.signal },
    );
    return response.task;
  }

  async createTask(
    input: CreateScheduledTaskInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledTaskRecord> {
    const response = await this.transport.request<{ task: ScheduledTaskRecord }>(
      "/schedules/tasks",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.task;
  }

  async updateTask(
    id: string,
    input: UpdateScheduledTaskInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledTaskRecord> {
    const response = await this.transport.request<{ task: ScheduledTaskRecord }>(
      `/schedules/tasks/${encodeURIComponent(id)}`,
      { method: "PATCH", body: input, signal: options.signal },
    );
    return response.task;
  }

  async removeTask(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.transport.request<{ removed: true }>(
      `/schedules/tasks/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        signal: options.signal,
      },
    );
  }

  async triggerTask(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledRunRecord> {
    const response = await this.transport.request<{ run: ScheduledRunRecord }>(
      `/schedules/tasks/${encodeURIComponent(id)}/run`,
      { method: "POST", signal: options.signal },
    );
    return response.run;
  }

  async listRuns(
    options: {
      taskId?: string;
      unread?: boolean;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ScheduledRunRecord[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{ runs: ScheduledRunRecord[] }>(
      this.transport.path("/schedules/runs", query),
      { signal },
    );
    return response.runs;
  }

  async setRunUnread(
    id: string,
    unread: boolean,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScheduledRunRecord> {
    const response = await this.transport.request<{ run: ScheduledRunRecord }>(
      `/schedules/runs/${encodeURIComponent(id)}/read`,
      { method: "PATCH", body: { unread }, signal: options.signal },
    );
    return response.run;
  }
}
