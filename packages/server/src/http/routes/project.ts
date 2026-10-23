import { Hono } from "hono";

import type { ProjectApplicationService } from "../../application/projects/project-application-service.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";

export function createProjectRoutes(projects: ProjectApplicationService): Hono {
  return new Hono()
    .get("/", (c) =>
      jsonResponse({
        projects: projects.list({
          includeArchived: c.req.query("includeArchived") === "true",
        }),
      }),
    )
    .post("/inspect", async (c) => {
      const body = await readJson(c);
      if (typeof body.path !== "string")
        return errorResponse(400, "path is required");
      try {
        return jsonResponse({ project: await projects.inspect(body.path) });
      } catch (error) {
        return errorResponse(
          400,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .patch("/:projectId", async (c) => {
      const body = (await readJson(c)) as Record<string, unknown>;
      try {
        const hasDefaultShell = Object.prototype.hasOwnProperty.call(body, "defaultShell");
        if (
          hasDefaultShell &&
          body.defaultShell !== null &&
          typeof body.defaultShell !== "string"
        ) {
          return errorResponse(400, "defaultShell must be a string or null");
        }
        const project = hasDefaultShell
          ? projects.setDefaultShell(
              c.req.param("projectId"),
              typeof body.defaultShell === "string" ? body.defaultShell : null,
            )
          : typeof body.name === "string"
            ? projects.rename(c.req.param("projectId"), body.name)
            : typeof body.pinned === "boolean"
              ? projects.setPinned(c.req.param("projectId"), body.pinned)
              : null;
        return project
          ? jsonResponse({ project })
          : errorResponse(400, "name, pinned or defaultShell is required");
      } catch (error) {
        return errorResponse(
          404,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .post("/:projectId/rebind", async (c) => {
      const body = await readJson(c);
      if (typeof body.path !== "string")
        return errorResponse(400, "path is required");
      try {
        return jsonResponse({
          project: await projects.rebind(c.req.param("projectId"), body.path),
        });
      } catch (error) {
        return errorResponse(
          400,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .delete("/:projectId", (c) => {
      try {
        return jsonResponse({
          project: projects.archive(c.req.param("projectId")),
        });
      } catch (error) {
        return errorResponse(
          404,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
}
