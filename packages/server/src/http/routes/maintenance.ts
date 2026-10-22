import { Hono, type Context } from "hono";
import type { MaintenanceApplicationService } from "../../application/maintenance/maintenance-application-service.js";
import { ApplicationError } from "../../shared/application-error.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";

export function createMaintenanceRoutes(context: {
  maintenance?: MaintenanceApplicationService;
}) {
  const service = context.maintenance;
  if (!service)
    return new Hono().all("/maintenance/*", () =>
      errorResponse(501, "当前后台未提供持久存储维护。"),
    );
  const reply =
    (action: (c: Context) => unknown | Promise<unknown>) =>
    async (c: Context) => {
      try {
        return jsonResponse(await action(c));
      } catch (error) {
        return failure(error);
      }
    };
  return new Hono()
    .use("/maintenance/*", async (c, next) => {
      try {
        if (c.req.method !== "GET" && c.req.path !== "/maintenance/usage")
          service.requireWriteReady();
      } catch (error) {
        return failure(error);
      }
      await next();
    })
    .get(
      "/maintenance/readiness",
      reply((c) => service.getReadiness(undefined, c.req.raw.signal)),
    )
    .get(
      "/maintenance/storage/health",
      reply((c) => service.getStorageHealth(undefined, c.req.raw.signal)),
    )
    .get(
      "/maintenance/restart-preview",
      reply((c) => service.getRestartPreview(undefined, c.req.raw.signal)),
    )
    .post(
      "/maintenance/prepare-restart",
      reply((c) => service.prepareRestart(undefined, c.req.raw.signal)),
    )
    .get(
      "/maintenance/cleanup/policy",
      reply((c) => service.readPolicy(undefined, c.req.raw.signal)),
    )
    .post(
      "/maintenance/cleanup/policy",
      reply(async (c) =>
        service.updatePolicy(await readJson(c), c.req.raw.signal),
      ),
    )
    .post(
      "/maintenance/cleanup/policy/run",
      reply((c) => service.runPolicyCleanup(undefined, c.req.raw.signal)),
    )
    .get(
      "/maintenance/errors",
      reply((c) => service.readErrors(undefined, c.req.raw.signal)),
    )
    .get(
      "/maintenance/environment",
      reply((c) => service.inspectEnvironment(undefined, c.req.raw.signal)),
    )
    .post(
      "/maintenance/cleanup/preview",
      reply(async (c) =>
        service.previewCleanup(await readJson(c), c.req.raw.signal),
      ),
    )
    .post(
      "/maintenance/cleanup/execute",
      reply(async (c) =>
        service.runCleanup(await readJson(c), c.req.raw.signal),
      ),
    )
    .get(
      "/maintenance/cleanup/audits",
      reply((c) => service.readCleanupAudits(undefined, c.req.raw.signal)),
    )
    .get(
      "/maintenance/diagnostics/details",
      reply((c) => service.readDiagnosticDetails(undefined, c.req.raw.signal)),
    )
    .post(
      "/maintenance/diagnostics/details",
      reply(async (c) =>
        service.updateDiagnosticDetails(await readJson(c), c.req.raw.signal),
      ),
    )
    .get(
      "/maintenance/logs",
      reply((c) => service.readLogs(undefined, c.req.raw.signal)),
    )
    .post(
      "/maintenance/usage",
      reply(async (c) =>
        service.readUsage(await readJson(c), c.req.raw.signal),
      ),
    )
    .get(
      "/maintenance/usage/settings",
      reply((c) => service.readUsageSettings(undefined, c.req.raw.signal)),
    )
    .post(
      "/maintenance/usage/price",
      reply(async (c) =>
        service.addUsagePrice(await readJson(c), c.req.raw.signal),
      ),
    )
    .post(
      "/maintenance/usage/budget",
      reply(async (c) =>
        service.updateUsageSettings(await readJson(c), c.req.raw.signal),
      ),
    )
    .get(
      "/maintenance/storage",
      reply((c) => service.readStorage(undefined, c.req.raw.signal)),
    )
    .post(
      "/maintenance/backup",
      reply(async (c) =>
        service.createBackup(await readJson(c), c.req.raw.signal),
      ),
    )
    .post(
      "/maintenance/backup/verify",
      reply(async (c) =>
        service.verifyBackup(await readJson(c), c.req.raw.signal),
      ),
    )
    .post(
      "/maintenance/backup/restore",
      reply(async (c) =>
        service.restoreBackup(await readJson(c), c.req.raw.signal),
      ),
    );
}
function failure(error: unknown) {
  return errorResponse(
    error instanceof ApplicationError ? error.status : 400,
    error instanceof Error ? error.message : String(error),
  );
}
