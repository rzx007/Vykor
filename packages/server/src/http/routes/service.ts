import { Hono } from "hono";

import { errorResponse, jsonResponse, readJson } from "../support.js";
import type {
  AgentPersonaService,
  ContextService,
  DreamService,
  HooksService,
  OutputStyleService,
  PluginService,
  ProfileService,
  ProjectInitService,
  SkillService,
} from "../../application/index.js";
import type { DaemonControlService } from "../../application/control/index.js";

export interface ServiceRoutesContext {
  contextService?: ContextService;
  dreamService?: DreamService;
  profileService?: ProfileService;
  outputStyleService?: OutputStyleService;
  projectInitService?: ProjectInitService;
  pluginService?: PluginService;
  skillService?: SkillService;
  agentPersonaService?: AgentPersonaService;
  hooksService?: HooksService;
  control: Pick<
    DaemonControlService,
    | "closeAllRuntimes"
    | "closeRuntimesForCwd"
    | "acquireCwdMutation"
    | "acquireGlobalMutation"
    | "inspectRuntimeHooks"
    | "runtimeInspectionAvailable"
    | "sessionExists"
  >;
}

export function createServiceRoutes(context: ServiceRoutesContext): Hono {
  return new Hono()
    .get("/context/plugins", async (c) => {
      if (!context.contextService?.plugins)
        return errorResponse(501, "Plugin catalog is not configured");
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        return jsonResponse(await context.contextService.plugins({ cwd }));
      } catch {
        return errorResponse(500, "Plugin catalog could not be loaded");
      }
    })
    .get("/context", async (c) => {
      if (!context.contextService)
        return errorResponse(501, "Context service is not configured");
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        return jsonResponse(await context.contextService.preview({ cwd }));
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .get("/context/status", async (c) => {
      if (!context.contextService)
        return errorResponse(501, "Context service is not configured");
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        return jsonResponse(await context.contextService.status({ cwd }));
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .get("/context/usage", async (c) => {
      if (!context.contextService)
        return errorResponse(501, "Context service is not configured");
      const cwd = c.req.query("cwd");
      if (!cwd) return errorResponse(400, "cwd is required");
      const sessionId = c.req.query("sessionId") || undefined;
      const refreshRaw = c.req.query("refresh");
      const refresh =
        refreshRaw === "true" || refreshRaw === "1"
          ? true
          : refreshRaw === "false" || refreshRaw === "0"
            ? false
            : undefined;
      const previousRaw = c.req.query("previousContextWindow");
      const previousContextWindow =
        previousRaw != null &&
        previousRaw !== "" &&
        Number.isFinite(Number(previousRaw))
          ? Number(previousRaw)
          : undefined;
      try {
        return jsonResponse(
          await context.contextService.usage({
            cwd,
            ...(sessionId ? { sessionId } : {}),
            ...(refresh !== undefined ? { refresh } : {}),
            ...(previousContextWindow !== undefined
              ? { previousContextWindow }
              : {}),
          }),
        );
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .post("/dream", async (c) => {
      if (!context.dreamService)
        return errorResponse(501, "Dream service is not configured");
      const body = await readJson(c);
      if (typeof body.cwd !== "string" || !body.cwd.trim()) {
        return errorResponse(400, "cwd is required");
      }
      try {
        const result = await context.dreamService.start({
          cwd: body.cwd,
          sessionId:
            typeof body.sessionId === "string" ? body.sessionId : undefined,
          preview: body.preview === true,
        });
        if (!result.started) {
          return errorResponse(409, result.reason ?? "Dream was not started");
        }
        return jsonResponse({ taskId: result.taskId }, 201);
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .get("/profile", async () => {
      if (!context.profileService)
        return errorResponse(501, "Profile service is not configured");
      try {
        return jsonResponse(await context.profileService.status());
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .post("/profile/init", async () => {
      if (!context.profileService)
        return errorResponse(501, "Profile service is not configured");
      const lease = context.control.acquireGlobalMutation();
      if (!lease) {
        return errorResponse(
          409,
          "Cannot initialize profile while session runs are active",
        );
      }
      try {
        const result = await context.profileService.init();
        await context.control.closeAllRuntimes();
        return jsonResponse(result);
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        lease.release();
      }
    })
    .get("/output-styles", async () => {
      if (!context.outputStyleService)
        return errorResponse(501, "Output style service is not configured");
      try {
        return jsonResponse({
          styles: await context.outputStyleService.list(),
        });
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .post("/project/init", async (c) => {
      if (!context.projectInitService)
        return errorResponse(501, "Project init service is not configured");
      const body = await readJson(c);
      const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        return jsonResponse(await context.projectInitService.init({ cwd }));
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .get("/plugins", async (c) => {
      if (!context.pluginService)
        return errorResponse(501, "Plugin service is not configured");
      const cwd = c.req.query("cwd") ?? undefined;
      if (!cwd) return errorResponse(400, "cwd is required");
      try {
        return jsonResponse(await context.pluginService.list({ cwd }));
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .post("/plugins/install-local", (c) =>
      installLocalPlugin(context, c, false),
    )
    .post("/plugins/link-local", (c) => installLocalPlugin(context, c, true))
    .post("/plugins/archive/preview", async (c) => {
      if (!context.pluginService?.previewArchive) return pluginArchiveErrorResponse(501, "plugin_archive_not_configured", "Plugin archive preview is not configured");
      let body: Record<string, unknown>;
      try {
        body = await readJson(c);
      } catch (error) {
        return pluginArchiveErrorResponse(400, "plugin_archive_invalid_request", error instanceof Error ? error.message : String(error));
      }
      const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      const archivePath = typeof body.archivePath === "string" ? body.archivePath : undefined;
      if (!cwd || !archivePath) return pluginArchiveErrorResponse(400, "plugin_archive_invalid_request", "cwd and archivePath are required");
      try {
        return jsonResponse(await context.pluginService.previewArchive({ cwd, archivePath }));
      } catch (error) {
        return pluginArchiveFailureResponse(error);
      }
    })
    .post("/plugins/archive/install", async (c) => {
      if (!context.pluginService?.installArchive) return pluginArchiveErrorResponse(501, "plugin_archive_not_configured", "Plugin archive installation is not configured");
      let body: Record<string, unknown>;
      try {
        body = await readJson(c);
      } catch (error) {
        return pluginArchiveErrorResponse(400, "plugin_archive_invalid_request", error instanceof Error ? error.message : String(error));
      }
      const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      const archivePath = typeof body.archivePath === "string" ? body.archivePath : undefined;
      const expectedArchiveDigest = typeof body.expectedArchiveDigest === "string" ? body.expectedArchiveDigest : undefined;
      const approvedPermissions = Array.isArray(body.approvedPermissions) && body.approvedPermissions.every((item) => typeof item === "string")
        ? body.approvedPermissions as string[]
        : undefined;
      if (!cwd || !archivePath || !expectedArchiveDigest || !approvedPermissions) {
        return pluginArchiveErrorResponse(400, "plugin_archive_invalid_request", "cwd, archivePath, expectedArchiveDigest and approvedPermissions are required");
      }
      const lease = context.control.acquireGlobalMutation();
      if (!lease) return pluginArchiveErrorResponse(409, "plugin_archive_mutation_blocked", "Cannot install plugins while session runs are active");
      try {
        const result = await context.pluginService.installArchive({ cwd, archivePath, expectedArchiveDigest, approvedPermissions });
        await context.control.closeAllRuntimes();
        return jsonResponse(result);
      } catch (error) {
        return pluginArchiveFailureResponse(error);
      } finally {
        lease.release();
      }
    })
    .post("/plugins/git/preview", async (c) => {
      if (!context.pluginService?.previewGit) return pluginArchiveErrorResponse(501, "plugin_git_not_configured", "Plugin Git preview is not configured");
      let body: Record<string, unknown>;
      try {
        body = await readJson(c);
      } catch (error) {
        return pluginArchiveErrorResponse(400, "plugin_git_invalid_request", error instanceof Error ? error.message : String(error));
      }
      const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      const url = typeof body.url === "string" ? body.url : undefined;
      const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref : undefined;
      if (!cwd || !url) return pluginArchiveErrorResponse(400, "plugin_git_invalid_request", "cwd and url are required");
      try {
        return jsonResponse(await context.pluginService.previewGit({ cwd, url, ref }));
      } catch (error) {
        return pluginArchiveFailureResponse(error);
      }
    })
    .post("/plugins/git/install", async (c) => {
      if (!context.pluginService?.installGit) return pluginArchiveErrorResponse(501, "plugin_git_not_configured", "Plugin Git installation is not configured");
      let body: Record<string, unknown>;
      try {
        body = await readJson(c);
      } catch (error) {
        return pluginArchiveErrorResponse(400, "plugin_git_invalid_request", error instanceof Error ? error.message : String(error));
      }
      const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      const url = typeof body.url === "string" ? body.url : undefined;
      const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref : undefined;
      const expectedSourceDigest = typeof body.expectedSourceDigest === "string" ? body.expectedSourceDigest : undefined;
      const approvedPermissions = Array.isArray(body.approvedPermissions) && body.approvedPermissions.every((item) => typeof item === "string")
        ? body.approvedPermissions as string[]
        : undefined;
      if (!cwd || !url || !expectedSourceDigest || !approvedPermissions) {
        return pluginArchiveErrorResponse(400, "plugin_git_invalid_request", "cwd, url, expectedSourceDigest and approvedPermissions are required");
      }
      const lease = context.control.acquireGlobalMutation();
      if (!lease) return pluginArchiveErrorResponse(409, "plugin_git_mutation_blocked", "Cannot install plugins while session runs are active");
      try {
        const result = await context.pluginService.installGit({ cwd, url, ref, expectedSourceDigest, approvedPermissions });
        await context.control.closeAllRuntimes();
        return jsonResponse(result);
      } catch (error) {
        return pluginArchiveFailureResponse(error);
      } finally {
        lease.release();
      }
    })
    .post("/plugins/:id/enable", async (c) =>
      setPluginEnabled(context, c.req.param("id"), true, await readJson(c)),
    )
    .post("/plugins/:id/disable", async (c) =>
      setPluginEnabled(context, c.req.param("id"), false, await readJson(c)),
    )
    .delete("/plugins/:id", async (c) => {
      if (!context.pluginService?.uninstall)
        return errorResponse(501, "Plugin uninstall is not configured");
      const body = await readJson(c);
      const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      if (!cwd) return errorResponse(400, "cwd is required");
      const lease = context.control.acquireGlobalMutation();
      if (!lease)
        return errorResponse(
          409,
          "Cannot uninstall plugins while session runs are active",
        );
      try {
        const result = await context.pluginService.uninstall({
          cwd,
          id: c.req.param("id"),
        });
        if (result.restartRuntimes) await context.control.closeAllRuntimes();
        return jsonResponse({ message: result.message });
      } catch (error) {
        return errorResponse(
          400,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        lease.release();
      }
    })
    .post("/plugins/reload", async (c) => {
      if (!context.pluginService)
        return errorResponse(501, "Plugin service is not configured");
      const body = await readJson(c);
      const cwd =
        typeof body.cwd === "string"
          ? body.cwd
          : (c.req.query("cwd") ?? undefined);
      if (!cwd) return errorResponse(400, "cwd is required");
      const lease = context.control.acquireCwdMutation(cwd);
      if (!lease) {
        return errorResponse(
          409,
          "Cannot reload plugins while session runs are active for this cwd",
        );
      }
      try {
        await context.control.closeRuntimesForCwd(cwd);
        const listed = await context.pluginService.list({ cwd });
        return jsonResponse({
          ...listed,
          message:
            "Plugins rediscovered; session runtimes will reload on next use.",
        });
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        lease.release();
      }
    })
    .get("/skills", async () => {
      if (!context.skillService)
        return errorResponse(501, "Skill service is not configured");
      try {
        return jsonResponse(await context.skillService.list());
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .delete("/skills/:id", async (c) => {
      if (!context.skillService)
        return errorResponse(501, "Skill service is not configured");
      const lease = context.control.acquireGlobalMutation();
      if (!lease)
        return errorResponse(
          409,
          "Cannot remove skills while session runs are active",
        );
      try {
        const body = await readJson(c);
        if (typeof body.expectedContent !== "string") {
          return errorResponse(400, "expectedContent is required");
        }
        const result = await context.skillService.remove({
          id: c.req.param("id"),
          expectedContent: body.expectedContent,
        });
        await context.control.closeAllRuntimes();
        return jsonResponse(result);
      } catch (error) {
        return errorResponse(
          400,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        lease.release();
      }
    })
    .get("/agent-personas", async () => {
      if (!context.agentPersonaService)
        return errorResponse(501, "Agent persona service is not configured");
      try {
        return jsonResponse(await context.agentPersonaService.list());
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .get("/hooks", async (c) => {
      if (!context.hooksService)
        return errorResponse(501, "Hooks service is not configured");
      const cwd = c.req.query("cwd") ?? undefined;
      if (!cwd) return errorResponse(400, "cwd is required");
      const sessionId = c.req.query("sessionId") ?? undefined;
      try {
        const listed = await context.hooksService.list({
          cwd,
          ...(sessionId ? { sessionId } : {}),
        });
        const hooks = [...listed.hooks];
        if (sessionId && context.control.runtimeInspectionAvailable) {
          if (!context.control.sessionExists(sessionId)) {
            return errorResponse(404, "Session not found");
          }
          for (const hook of await context.control.inspectRuntimeHooks(
            sessionId,
          )) {
            if (
              !hooks.some(
                (row) => row.id === hook.id && row.origin === hook.origin,
              )
            ) {
              hooks.push(hook);
            }
          }
        }
        return jsonResponse({ hooks });
      } catch (error) {
        return errorResponse(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
}

function pluginArchiveErrorResponse(
  status: number,
  code: string,
  message: string,
  diagnostics?: unknown,
): Response {
  return jsonResponse({ code, message, ...(Array.isArray(diagnostics) ? { diagnostics } : {}) }, status);
}

function pluginArchiveFailureResponse(error: unknown): Response {
  if (error && typeof error === "object" && "body" in error) {
    const body = (error as { body?: unknown }).body;
    if (body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string" && typeof (body as { message?: unknown }).message === "string") {
      const archive = body as { code: string; message: string; diagnostics?: unknown };
      const status = archive.code === "plugin_archive_changed" || archive.code === "plugin_archive_managed_conflict" || archive.code === "plugin_archive_permissions_not_approved" ? 409 : 400;
      return pluginArchiveErrorResponse(status, archive.code, archive.message, archive.diagnostics);
    }
  }
  return pluginArchiveErrorResponse(400, "plugin_archive_failed", error instanceof Error ? error.message : String(error));
}

async function setPluginEnabled(
  context: ServiceRoutesContext,
  id: string,
  enabled: boolean,
  body: Record<string, unknown>,
): Promise<Response> {
  if (!context.pluginService)
    return errorResponse(501, "Plugin service is not configured");
  if (!id) return errorResponse(400, "plugin id is required");
  const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
  if (!cwd) return errorResponse(400, "cwd is required");
  const lease = context.control.acquireGlobalMutation();
  if (!lease) {
    return errorResponse(
      409,
      "Cannot update plugins while session runs are active",
    );
  }
  try {
    const result = await context.pluginService.setEnabled({ id, cwd, enabled });
    if (result.restartRuntimes) await context.control.closeAllRuntimes();
    return jsonResponse({ message: result.message });
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    lease.release();
  }
}

async function installLocalPlugin(
  context: ServiceRoutesContext,
  c: any,
  link: boolean,
): Promise<Response> {
  if (!context.pluginService?.installLocal)
    return errorResponse(501, "Plugin installation is not configured");
  const body = await readJson(c);
  const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
  const sourcePath =
    typeof body.sourcePath === "string" ? body.sourcePath : undefined;
  const scope = body.scope;
  const approvedPermissions = Array.isArray(body.approvedPermissions)
    ? body.approvedPermissions.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  if (!cwd || !sourcePath || scope !== "user") {
    return errorResponse(400, "cwd, sourcePath and user scope are required");
  }
  const lease = context.control.acquireGlobalMutation();
  if (!lease)
    return errorResponse(
      409,
      "Cannot install plugins while session runs are active",
    );
  try {
    const result = await context.pluginService.installLocal({
      cwd,
      sourcePath,
      scope,
      approvedPermissions,
      link,
    });
    if (result.restartRuntimes) await context.control.closeAllRuntimes();
    return jsonResponse({ message: result.message });
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    lease.release();
  }
}
