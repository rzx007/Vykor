import {
  parseCreateScheduledTaskRequest,
  parseUpdateScheduledTaskRequest,
  ProtocolValidationError,
  type ScheduledTaskRecord,
} from "@vykor/protocol";
import { Hono } from "hono";

import type { ScheduledTaskService } from "../../daemon/scheduled-task-service.js";
import {
  errorResponse,
  jsonResponse,
  protocolValidationErrorResponse,
  readJson,
  readLimit,
} from "../support.js";

export interface ScheduleRoutesContext {
  schedules: Pick<
    ScheduledTaskService,
    | "createTask"
    | "getTask"
    | "listRuns"
    | "listTasks"
    | "markRunRead"
    | "removeTask"
    | "status"
    | "trigger"
    | "updateTask"
  >;
}

function scheduleError(error: unknown, fallbackStatus = 400): Response {
  if (error instanceof ProtocolValidationError || error instanceof SyntaxError) {
    return protocolValidationErrorResponse(error);
  }
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("not found")
    ? 404
    : message.includes("running")
      ? 409
      : fallbackStatus;
  return errorResponse(status, message);
}

export function createScheduleRoutes(context: ScheduleRoutesContext): Hono {
  return new Hono()
    .get("/status", () => jsonResponse(context.schedules.status()))
    .get("/tasks", (c) => {
      const status = c.req.query("status");
      if (status && !["active", "paused", "completed"].includes(status)) {
        return errorResponse(400, "Unknown scheduled task status");
      }
      return jsonResponse({
        tasks: context.schedules.listTasks({
          ...(status
            ? { status: status as ScheduledTaskRecord["status"] }
            : {}),
        }),
      });
    })
    .post("/tasks", async (c) => {
      try {
        const input = parseCreateScheduledTaskRequest(await readJson(c));
        return jsonResponse(
          {
            task: context.schedules.createTask(input),
          },
          201,
        );
      } catch (error) {
        return scheduleError(error);
      }
    })
    .get("/tasks/:id", (c) => {
      try {
        return jsonResponse({
          task: context.schedules.getTask(c.req.param("id")),
        });
      } catch (error) {
        return scheduleError(error);
      }
    })
    .patch("/tasks/:id", async (c) => {
      try {
        const input = parseUpdateScheduledTaskRequest(await readJson(c));
        return jsonResponse({
          task: context.schedules.updateTask(c.req.param("id"), input),
        });
      } catch (error) {
        return scheduleError(error);
      }
    })
    .delete("/tasks/:id", (c) => {
      try {
        context.schedules.removeTask(c.req.param("id"));
        return jsonResponse({ removed: true });
      } catch (error) {
        return scheduleError(error);
      }
    })
    .post("/tasks/:id/run", async (c) => {
      try {
        return jsonResponse({
          run: await context.schedules.trigger(c.req.param("id")),
        });
      } catch (error) {
        return scheduleError(error, 500);
      }
    })
    .get("/runs", (c) => {
      const unread = c.req.query("unread");
      if (unread && unread !== "true" && unread !== "false") {
        return errorResponse(400, "unread must be true or false");
      }
      return jsonResponse({
        runs: context.schedules.listRuns({
          taskId: c.req.query("taskId") ?? undefined,
          ...(unread ? { unread: unread === "true" } : {}),
          limit: readLimit(c.req.query("limit")),
        }),
      });
    })
    .patch("/runs/:id/read", async (c) => {
      try {
        const body = await readJson(c);
        return jsonResponse({
          run: context.schedules.markRunRead(
            c.req.param("id"),
            body.unread === true,
          ),
        });
      } catch (error) {
        return scheduleError(error);
      }
    });
}
