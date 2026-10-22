import { Hono } from "hono";
import type {
  ProjectFactsService,
  ReplaceProjectFactInput,
} from "../../application/personalization/project-facts-service.js";
import { ApplicationError } from "../../shared/application-error.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";
export interface FactsRoutesContext {
  facts: Pick<ProjectFactsService, "list" | "replace">;
}
export function createFactsRoutes(context: FactsRoutesContext): Hono {
  const fail = (error: unknown) =>
    errorResponse(
      error instanceof ApplicationError ? error.status : 500,
      error instanceof Error ? error.message : String(error),
    );
  return new Hono()
    .get("/", (c) => {
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        return jsonResponse(context.facts.list(cwd));
      } catch (error) {
        return fail(error);
      }
    })
    .post("/replace", async (c) => {
      try {
        return jsonResponse(
          await context.facts.replace(
            (await readJson(c)) as unknown as ReplaceProjectFactInput,
          ),
        );
      } catch (error) {
        return fail(error);
      }
    });
}
