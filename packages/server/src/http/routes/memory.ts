import { Hono } from "hono";

import {
  applicationErrorResponse,
  errorResponse,
  jsonResponse,
  readJson,
} from "../support.js";
import type { MemoryService } from "../../application/index.js";
import type { DaemonControlService } from "../../application/control/index.js";

export interface MemoryRoutesContext {
  memoryService?: MemoryService;
  control: Pick<
    DaemonControlService,
    "acquireCwdMutation" | "closeRuntimesForCwd"
  >;
}

export function createMemoryRoutes(context: MemoryRoutesContext): Hono {
  return new Hono()
    .get("/", async (c) => {
      if (!context.memoryService)
        return errorResponse(501, "Memory service is not configured");
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        return jsonResponse(await context.memoryService.list({ cwd }));
      } catch (error) {
        return applicationErrorResponse(error);
      }
    })
    .get("/:entryId", async (c) => {
      if (!context.memoryService)
        return errorResponse(501, "Memory service is not configured");
      const cwd = c.req.query("cwd");
      const entryId = c.req.param("entryId");
      if (!cwd) return errorResponse(400, "cwd is required");
      if (!entryId) return errorResponse(400, "entryId is required");
      try {
        const entry = await context.memoryService.get({ cwd, id: entryId });
        if (!entry)
          return errorResponse(404, `Memory entry not found: ${entryId}`);
        return jsonResponse({ entry });
      } catch (error) {
        return applicationErrorResponse(error);
      }
    })
    .post("/", async (c) => {
      if (!context.memoryService)
        return errorResponse(501, "Memory service is not configured");
      const body = await readJson(c);
      if (typeof body.cwd !== "string")
        return errorResponse(400, "cwd is required");
      if (typeof body.content !== "string" || !body.content.trim()) {
        return errorResponse(400, "content is required");
      }
      const lease = context.control.acquireCwdMutation(body.cwd);
      if (!lease) {
        return errorResponse(
          409,
          "Cannot update memory while session runs are active for this cwd",
        );
      }
      const tags = Array.isArray(body.tags)
        ? body.tags.filter((tag): tag is string => typeof tag === "string")
        : undefined;
      try {
        const entry = await context.memoryService.add({
          cwd: body.cwd,
          content: body.content,
          tags,
        });
        await context.control.closeRuntimesForCwd(body.cwd);
        return jsonResponse({ entry }, 201);
      } catch (error) {
        return applicationErrorResponse(error);
      } finally {
        lease.release();
      }
    })
    .delete("/:entryId", async (c) => {
      if (!context.memoryService)
        return errorResponse(501, "Memory service is not configured");
      const cwd = c.req.query("cwd");
      const entryId = c.req.param("entryId");
      if (!cwd) return errorResponse(400, "cwd is required");
      if (!entryId) return errorResponse(400, "entryId is required");
      const lease = context.control.acquireCwdMutation(cwd);
      if (!lease) {
        return errorResponse(
          409,
          "Cannot update memory while session runs are active for this cwd",
        );
      }
      try {
        const deleted = await context.memoryService.remove({
          cwd,
          id: entryId,
          expectedRevision: c.req.query("expectedRevision"),
        });
        if (!deleted)
          return errorResponse(404, `Memory entry not found: ${entryId}`);
        await context.control.closeRuntimesForCwd(cwd);
        return jsonResponse({ deleted: true, id: entryId });
      } catch (error) {
        return applicationErrorResponse(error);
      } finally {
        lease.release();
      }
    })
    .patch("/:entryId", async (c) => {
      if (!context.memoryService?.update)
        return errorResponse(501, "Memory editing is not configured");
      const body = await readJson(c);
      if (
        typeof body.cwd !== "string" ||
        typeof body.content !== "string" ||
        !body.content.trim() ||
        typeof body.expectedRevision !== "string"
      )
        return errorResponse(
          400,
          "cwd, content and expectedRevision are required",
        );
      const lease = context.control.acquireCwdMutation(body.cwd);
      if (!lease)
        return errorResponse(
          409,
          "Cannot edit memory while tasks or memory extraction are active for this cwd",
        );
      try {
        await context.control.closeRuntimesForCwd(body.cwd);
        const entry = await context.memoryService.update({
          cwd: body.cwd,
          id: c.req.param("entryId"),
          content: body.content,
          expectedRevision: body.expectedRevision,
        });
        return jsonResponse({ entry });
      } catch (error) {
        return applicationErrorResponse(error);
      } finally {
        lease.release();
      }
    })
    .post("/clear", async (c) => {
      if (!context.memoryService?.clear)
        return errorResponse(501, "Memory clearing is not configured");
      const body = await readJson(c);
      if (
        typeof body.cwd !== "string" ||
        !Array.isArray(body.expectedEntries) ||
        body.expectedEntries.some(
          (item) =>
            !item ||
            typeof item !== "object" ||
            typeof item.id !== "string" ||
            typeof item.revision !== "string",
        )
      )
        return errorResponse(400, "cwd and versioned entry list are required");
      const lease = context.control.acquireCwdMutation(body.cwd);
      if (!lease)
        return errorResponse(
          409,
          "Cannot clear memory while tasks or extraction are active for this cwd",
        );
      try {
        await context.control.closeRuntimesForCwd(body.cwd);
        return jsonResponse(
          await context.memoryService.clear({
            cwd: body.cwd,
            expectedEntries: body.expectedEntries as Array<{
              id: string;
              revision: string;
            }>,
          }),
        );
      } catch (error) {
        return applicationErrorResponse(error);
      } finally {
        lease.release();
      }
    });
}
