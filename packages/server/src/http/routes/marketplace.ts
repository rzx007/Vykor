import { Hono } from "hono";
import { errorResponse, jsonResponse, readJson } from "../support.js";
import type { PluginMarketplaceService } from "../../application/default-services/marketplace-service.js";
function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    throw new Error(`${name} is required`);
  return value;
}
export function createMarketplaceRoutes(
  service?: PluginMarketplaceService,
): Hono {
  return new Hono()
    .use("*", async (c, next) => {
      if (!service)
        return errorResponse(501, "Plugin marketplace is not configured");
      return next();
    })
    .onError((error, c) => errorResponse(400, error.message))
    .get("/catalog", async (c) =>
      jsonResponse(
        await service!.catalog({
          cwd: text(c.req.query("cwd"), "cwd"),
          refresh: c.req.query("refresh") === "true",
        }),
      ),
    )
    .get("/sources", async () => jsonResponse(await service!.sources()))
    .post("/sources", async (c) => {
      const body = await readJson(c);
      return jsonResponse(await service!.addSource(text(body.url, "url")));
    })
    .patch("/sources/:sourceId", async (c) => {
      const body = await readJson(c);
      if (typeof body.enabled !== "boolean")
        throw new Error("enabled must be a boolean");
      return jsonResponse(
        await service!.setSourceEnabled(c.req.param("sourceId"), body.enabled),
      );
    })
    .delete("/sources/:sourceId", async (c) =>
      jsonResponse(await service!.removeSource(c.req.param("sourceId"))),
    )
    .post("/preview", async (c) => {
      const body = await readJson(c);
      return jsonResponse(
        await service!.preview({
          cwd: text(body.cwd, "cwd"),
          sourceId: text(body.sourceId, "sourceId"),
          pluginId: text(body.pluginId, "pluginId"),
          version: text(body.version, "version"),
        }),
      );
    })
    .post("/cancel", async (c) => {
      const body = await readJson(c);
      return jsonResponse(
        await service!.cancel(text(body.candidateId, "candidateId")),
      );
    })
    .post("/install", async (c) => {
      const body = await readJson(c);
      if (
        !Array.isArray(body.approvedPermissions) ||
        body.approvedPermissions.length > 256 ||
        body.approvedPermissions.some((x) => typeof x !== "string") ||
        (body.allowSourceChange !== undefined &&
          typeof body.allowSourceChange !== "boolean")
      )
        throw new Error("Invalid plugin permission approval");
      return jsonResponse(
        await service!.install({
          cwd: text(body.cwd, "cwd"),
          candidateId: text(body.candidateId, "candidateId"),
          operationId: text(body.operationId, "operationId"),
          approvedPermissions: body.approvedPermissions as string[],
          ...(body.allowSourceChange === undefined
            ? {}
            : { allowSourceChange: body.allowSourceChange as boolean }),
        }),
      );
    })
    .get("/operations/:operationId", async (c) =>
      jsonResponse(await service!.operation(c.req.param("operationId"))),
    );
}
