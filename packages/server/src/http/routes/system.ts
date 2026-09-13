import { Hono } from "hono";

import {
  mergeCommandCatalog,
  type CommandCatalogProvider,
} from "../../commands/index.js";
import {
  applicationErrorResponse,
  errorResponse,
  jsonResponse,
  readJson,
  type OpenHarnessServerHealth,
} from "../support.js";
import type {
  ModelService,
  ProviderService,
  SettingsService,
} from "../../application/index.js";
import type { DaemonControlService } from "../../application/control/index.js";
import type { ApplicationRetentionService } from "../../application/retention/application-retention-service.js";
import {
  DEFAULT_ATTACHMENT_LIMITS,
  CURRENT_PROTOCOL_VERSION,
  type AttachmentLimits,
  type ServerCapabilities,
} from "@openharness/protocol";
import { settingsPatchRuntimeImpact } from "../../application/default-services/settings-service.js";

export interface SystemRoutesContext {
  version?: string;
  commandCatalog?: CommandCatalogProvider;
  settingsService?: SettingsService;
  providerService?: ProviderService;
  modelService?: ModelService;
  control: Pick<
    DaemonControlService,
    | "acquireGlobalMutation"
    | "closeAllRuntimes"
    | "invalidateRuntimes"
    | "runtimeSnapshot"
    | "inspectRun"
    | "listProjectionDiagnostics"
  >;
  capabilities?: ServerCapabilities;
  attachmentLimits?: AttachmentLimits;
  retention?: Pick<
    ApplicationRetentionService,
    "scanAttachments" | "repairAttachments" | "gcAttachments"
  >;
}

export function createSystemRoutes(context: SystemRoutesContext): Hono {
  return new Hono()
    .get("/capabilities", async () =>
      jsonResponse(
        context.capabilities ??
          ({
            serverVersion: context.version ?? "0.1.0",
            protocol: { version: CURRENT_PROTOCOL_VERSION },
            features: {
              steer: 1,
              runAttempts: 1,
              toolAttempts: 1,
              jobs: 2,
              schedules: 1,
              workflow: 2,
              durableChannels: 1,
              backup: 1,
              retention: 1,
              attachments: 1,
              pluginCapabilities: 1,
            },
            attachments: {
              limits: context.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS,
              uploadModes: ["single"],
            },
            ...(context.settingsService?.agentEnvironmentCapabilities
              ? {
                  agentEnvironments:
                    await context.settingsService.agentEnvironmentCapabilities(),
                }
              : {}),
          } satisfies ServerCapabilities),
      ),
    )
    .get("/health", () => {
      const snapshot = context.control.runtimeSnapshot();
      return jsonResponse({
        ok: true,
        ...(context.version ? { version: context.version } : {}),
        startedAt: snapshot.startedAt,
        uptimeMs: snapshot.uptimeMs,
        sessionCount: snapshot.sessions.total,
        activeRunCount: snapshot.coordinator.activeRunCount,
        queuedRunCount: snapshot.coordinator.queuedRunCount,
      } satisfies OpenHarnessServerHealth);
    })
    .get("/debug/runtime", () =>
      jsonResponse(context.control.runtimeSnapshot()),
    )
    .get("/debug/runs/:runId", (c) => {
      const inspection = context.control.inspectRun(c.req.param("runId"), {
        includeContent: c.req.query("includeContent") === "true",
      });
      return inspection
        ? jsonResponse(inspection)
        : errorResponse(404, "Run not found");
    })
    .get("/debug/projection-settlements", (c) =>
      jsonResponse(
        context.control.listProjectionDiagnostics({
          includeContent: c.req.query("includeContent") === "true",
        }),
      ),
    )
    .get("/attachments/storage", async () => {
      if (!context.retention) {
        return errorResponse(
          501,
          "Attachment storage diagnostics are not configured",
        );
      }
      try {
        return jsonResponse(await context.retention.scanAttachments());
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .post("/attachments/storage/actions", async (c) => {
      if (!context.retention) {
        return errorResponse(
          501,
          "Attachment storage diagnostics are not configured",
        );
      }
      const body = (await readJson(c)) as { action?: unknown };
      if (!["repair-safe", "gc"].includes(String(body.action))) {
        return errorResponse(400, "action must be repair-safe or gc");
      }
      const lease = context.control.acquireGlobalMutation();
      if (!lease)
        return errorResponse(
          409,
          "Cannot clean attachment storage while runs are active",
        );
      try {
        return jsonResponse(
          body.action === "repair-safe"
            ? await context.retention.repairAttachments()
            : await context.retention.gcAttachments(),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResponse(
          message.includes("attachment_gc_busy") ? 409 : 500,
          message,
        );
      } finally {
        lease.release();
      }
    })
    .get("/commands", async (c) => {
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        const extras = context.commandCatalog
          ? await context.commandCatalog.list({ cwd })
          : [];
        return jsonResponse({ commands: mergeCommandCatalog(extras) });
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .get("/settings", async () => {
      if (!context.settingsService)
        return errorResponse(501, "Settings service is not configured");
      try {
        return jsonResponse({ settings: await context.settingsService.get() });
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .patch("/settings", async (c) => {
      if (!context.settingsService)
        return errorResponse(501, "Settings service is not configured");
      const body = await readJson(c);
      const impact = settingsPatchRuntimeImpact(
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {},
      );
      const lease = context.control.acquireGlobalMutation();
      if (!lease) {
        if (impact === "restart") {
          return errorResponse(
            409,
            "Cannot update daemon settings while session runs are active",
          );
        }
        try {
          const result = await context.settingsService.patch(body);
          if (result.restartRuntimes) {
            return errorResponse(
              409,
              "Cannot update daemon settings while session runs are active",
            );
          }
          if (result.invalidateRuntimes) {
            await context.control.invalidateRuntimes();
          }
          return jsonResponse({ settings: result.settings });
        } catch (error) {
          return errorResponse(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      try {
        const result = await context.settingsService.patch(body);
        if (result.restartRuntimes) await context.control.closeAllRuntimes();
        else if (result.invalidateRuntimes) {
          await context.control.invalidateRuntimes();
        }
        return jsonResponse({ settings: result.settings });
      } catch (error) {
        return errorResponse(
          400,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        lease.release();
      }
    })
    .get("/providers", async () => {
      if (!context.providerService)
        return errorResponse(501, "Provider service is not configured");
      try {
        return jsonResponse({
          providers: await context.providerService.list(),
        });
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .post("/providers/custom", async (c) => {
      if (!context.providerService?.create)
        return errorResponse(501, "Custom provider creation is not configured");
      const lease = context.control.acquireGlobalMutation();
      if (!lease)
        return errorResponse(
          409,
          "Cannot update providers while session runs are active",
        );
      try {
        const provider = await context.providerService.create(
          (await readJson(c)) as never,
        );
        await context.control.closeAllRuntimes();
        return jsonResponse({ provider }, 201);
      } catch (error) {
        return providerMutationErrorResponse(error);
      } finally {
        lease.release();
      }
    })
    .post("/providers/catalog/:id/connect", async (c) => {
      if (!context.providerService?.connectCatalog) {
        return errorResponse(
          501,
          "Catalog provider connections are not configured",
        );
      }
      const lease = context.control.acquireGlobalMutation();
      if (!lease)
        return errorResponse(
          409,
          "Cannot update providers while session runs are active",
        );
      try {
        const body = (await readJson(c)) as { apiKey?: unknown };
        const provider = await context.providerService.connectCatalog(
          c.req.param("id"),
          typeof body.apiKey === "string" ? body.apiKey : "",
        );
        await context.control.closeAllRuntimes();
        return jsonResponse({ provider });
      } catch (error) {
        return providerMutationErrorResponse(error);
      } finally {
        lease.release();
      }
    })
    .delete("/providers/catalog/:id/connect", async (c) => {
      if (!context.providerService?.disconnectCatalog) {
        return errorResponse(
          501,
          "Catalog provider connections are not configured",
        );
      }
      const lease = context.control.acquireGlobalMutation();
      if (!lease)
        return errorResponse(
          409,
          "Cannot update providers while session runs are active",
        );
      try {
        await context.providerService.disconnectCatalog(c.req.param("id"));
        await context.control.closeAllRuntimes();
        return jsonResponse({ ok: true });
      } catch (error) {
        return providerMutationErrorResponse(error);
      } finally {
        lease.release();
      }
    })
    .patch("/providers/custom/:id", async (c) => {
      if (!context.providerService?.update)
        return errorResponse(501, "Custom provider updates are not configured");
      const lease = context.control.acquireGlobalMutation();
      if (!lease)
        return errorResponse(
          409,
          "Cannot update providers while session runs are active",
        );
      try {
        const provider = await context.providerService.update(
          c.req.param("id"),
          (await readJson(c)) as never,
        );
        await context.control.closeAllRuntimes();
        return jsonResponse({ provider });
      } catch (error) {
        return providerMutationErrorResponse(error);
      } finally {
        lease.release();
      }
    })
    .delete("/providers/custom/:id", async (c) => {
      if (!context.providerService?.remove)
        return errorResponse(501, "Custom provider removal is not configured");
      const lease = context.control.acquireGlobalMutation();
      if (!lease)
        return errorResponse(
          409,
          "Cannot update providers while session runs are active",
        );
      try {
        await context.providerService.remove(c.req.param("id"));
        await context.control.closeAllRuntimes();
        return jsonResponse({ ok: true });
      } catch (error) {
        return providerMutationErrorResponse(error);
      } finally {
        lease.release();
      }
    })
    .get("/models", async () => {
      if (!context.modelService)
        return errorResponse(501, "Model service is not configured");
      try {
        return jsonResponse({ providers: await context.modelService.list() });
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
}

function providerMutationErrorResponse(error: unknown): Response {
  return applicationErrorResponse(error, 400);
}
