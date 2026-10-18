import { Hono } from "hono";
import { withProviderConfigurationUpdate } from "../provider-configuration-update.js";

import { errorResponse, jsonResponse, readJson } from "../support.js";
import type { AuthService } from "../../application/index.js";
import type { DaemonControlService } from "../../application/control/index.js";

export interface AuthRoutesContext {
  authService?: AuthService;
  control: Pick<DaemonControlService, "acquireGlobalMutation" | "closeAllRuntimes" | "invalidateRuntimes">;
}

export function createAuthRoutes(context: AuthRoutesContext): Hono {
  return new Hono()
    .use("*", async (c, next) => {
      if (c.req.method !== "POST") return next();
      await withProviderConfigurationUpdate(context.control, next);
    })
    .get("/", async () => {
      if (!context.authService) return errorResponse(501, "Auth service is not configured");
      try {
        return jsonResponse({ auth: await context.authService.status() });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/login", async (c) => {
      if (!context.authService) return errorResponse(501, "Auth service is not configured");
      const body = await readJson(c);
      if (typeof body.provider !== "string" || !body.provider.trim()) {
        return errorResponse(400, "provider is required");
      }
      try {
        const result = await context.authService.login({
          provider: body.provider,
          apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
        });
        await context.control.invalidateRuntimes();
        return jsonResponse(result);
      } catch (error) {
        return errorResponse(400, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/logout", async (c) => {
      if (!context.authService) return errorResponse(501, "Auth service is not configured");
      const body = await readJson(c);
      if (typeof body.provider !== "string" || !body.provider.trim()) {
        return errorResponse(400, "provider is required");
      }
      const lease = context.control.acquireGlobalMutation();
      if (!lease) {
        return errorResponse(409, "Cannot update authentication while session runs are active");
      }
      try {
        const result = await context.authService.logout({ provider: body.provider });
        await context.control.closeAllRuntimes();
        return jsonResponse(result);
      } catch (error) {
        return errorResponse(400, error instanceof Error ? error.message : String(error));
      } finally {
        lease.release();
      }
    });
}
