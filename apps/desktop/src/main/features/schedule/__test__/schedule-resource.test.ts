import { CURRENT_PROTOCOL_VERSION, HttpTransport } from "@rzx/client";
import type { CreateScheduledTaskInput, ScheduledTaskRecord } from "@vykor/protocol";
import { expect, it } from "vitest";
import { ScheduleResource } from "../schedule-resource";

it("creates scheduled tasks and queries active tasks and unread runs", async () => {
  const requests: Request[] = [];
  const input: CreateScheduledTaskInput = {
    name: "review", prompt: "Review changes", recurrence: "2099-01-01T00:00:00Z", recurrenceFormat: "once",
    timezone: "UTC", destination: "chat", sessionId: "s1",
  };
  const task: ScheduledTaskRecord = {
    ...input, id: "schedule-1", status: "active", destination: "chat", projectPaths: [], executionMode: "local",
    skillNames: [], pluginNames: [], timezone: "UTC", recurrenceFormat: "once", permissionProfile: { mode: "workspace_write" },
    overlapPolicy: "skip", missedRunPolicy: "skip", createdBy: "agent", runCount: 0, createdAt: 1, updatedAt: 1,
  };
  const resource = new ScheduleResource(new HttpTransport({ baseUrl: "http://daemon.test", fetch: async (url, init) => {
    const request = new Request(url, init);
    const path = new URL(request.url).pathname;
    if (path === "/capabilities") return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
    requests.push(request);
    if (request.method === "POST") return Response.json({ task });
    if (path.endsWith("/runs")) return Response.json({ runs: [] });
    return Response.json({ tasks: [task] });
  } }));

  await expect(resource.createTask(input)).resolves.toEqual(task);
  await expect(resource.listTasks({ status: "active" })).resolves.toEqual([task]);
  await expect(resource.listRuns({ taskId: task.id, unread: true })).resolves.toEqual([]);
  expect(requests.map(request => {
    const { pathname, search } = new URL(request.url);
    return [request.method, pathname + search];
  })).toEqual([
    ["POST", "/schedules/tasks"],
    ["GET", "/schedules/tasks?status=active"],
    ["GET", "/schedules/runs?taskId=schedule-1&unread=true"],
  ]);
  expect(await requests[0]!.json()).toEqual(input);
});
