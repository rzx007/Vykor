import { Hono } from "hono";
import { FactMutationError, loadFacts, replaceFact } from "@vykor/personalization";
import { detectCredentialValue } from "@vykor/memory";
import type { DaemonControlService } from "../../application/control/index.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";

export interface FactsRoutesContext {
  control: Pick<DaemonControlService, "acquireCwdMutation" | "closeRuntimesForCwd">;
}

export function createFactsRoutes(context: FactsRoutesContext): Hono {
  return new Hono()
    .get("/", (c) => {
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        return jsonResponse({ facts: loadFacts(cwd).facts.filter((fact) => !detectCredentialValue(fact.value)) });
      } catch {
        return errorResponse(500, "Project facts file is unreadable");
      }
    })
    .post("/replace", async (c) => {
      const body = await readJson(c);
      if (typeof body.cwd !== "string" || !body.cwd.trim()) return errorResponse(400, "cwd is required");
      if (typeof body.oldKey !== "string" || !body.oldKey.trim()) return errorResponse(400, "oldKey is required");
      if (typeof body.newValue !== "string" || !body.newValue.trim()) return errorResponse(400, "newValue is required");
      if (body.sessionId !== undefined && typeof body.sessionId !== "string") return errorResponse(400, "sessionId must be a string");
      const lease = context.control.acquireCwdMutation(body.cwd);
      if (!lease) return errorResponse(409, "Cannot update facts while session runs are active for this cwd");
      try {
        const result = replaceFact(body.cwd, body.oldKey, body.newValue, { sessionId: body.sessionId });
        await context.control.closeRuntimesForCwd(body.cwd);
        return jsonResponse({ result });
      } catch (error) {
        if (error instanceof FactMutationError) {
          const status = error.code === "NOT_FOUND" ? 404
            : error.code === "INVALID_VALUE" ? 400
              : error.code === "CONFLICT" ? 409 : 500;
          return errorResponse(status, error.message);
        }
        return errorResponse(500, "Project fact replacement failed");
      } finally {
        lease.release();
      }
    });
}
