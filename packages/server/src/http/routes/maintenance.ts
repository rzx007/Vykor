import { Hono, type Context } from "hono";
import { cleanupPreviewDto, cleanupResultDto, storageReportDto, usageReportDto } from "../mappers/maintenance.js";
import type { MaintenanceApplicationService } from "../../application/maintenance/maintenance-application-service.js";
import type { RegisteredDaemonControl } from "../../daemon-host/registered-daemon.js";
import { ApplicationError } from "../../shared/application-error.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";

export function createMaintenanceRoutes(context: {
  maintenance?: MaintenanceApplicationService;
  registeredDaemon?: RegisteredDaemonControl;
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
    .post("/maintenance/prepare-root-migration", reply(() => service.prepareDataRootMigration()))
    .post("/maintenance/data-switch", async (c) => {
      if (!context.registeredDaemon || c.req.header("origin"))
        return errorResponse(404, "当前后台未提供本机数据切换。");
      try {
        const { id, directory, storePath } = await readJson(c);
        if ((id !== undefined && typeof id !== "string") || typeof directory !== "string" || typeof storePath !== "string")
          return errorResponse(400, "数据切换需要完整的目录和数据库路径。");
        return jsonResponse(await context.registeredDaemon.requestSwitch(
          { id, directory, storePath }, service.holdRestart,
        ), 202);
      } catch (error) {
        return failure(error);
      }
    })
    .get("/maintenance/data-switch/:id", (c) => {
      if (!context.registeredDaemon || c.req.header("origin"))
        return errorResponse(404, "当前后台未提供本机数据切换。");
      const result = context.registeredDaemon.getSwitchResult(c.req.param("id"));
      return result ? jsonResponse(result) : errorResponse(404, "未找到这次数据切换。");
    })
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
        cleanupPreviewDto(await service.previewCleanup(await readJson(c), c.req.raw.signal)),
      ),
    )
    .post(
      "/maintenance/cleanup/execute",
      reply(async (c) =>
        cleanupResultDto(await service.runCleanup(await readJson(c), c.req.raw.signal)),
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
        usageReportDto(await service.readUsage(await readJson(c), c.req.raw.signal)),
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
      reply(async (c) => storageReportDto(await service.readStorage(undefined, c.req.raw.signal))),
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
