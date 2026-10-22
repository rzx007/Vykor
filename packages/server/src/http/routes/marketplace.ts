import { Hono } from "hono";
import { ProtocolValidationError, parseMarketplaceCatalogRequest, parseMarketplaceAddSourceRequest,
  parseMarketplaceSourceEnabledRequest, parseMarketplacePreviewRequest, parseMarketplaceCancelRequest,
  parseMarketplaceInstallRequest, type MarketplaceCancelResponse } from "@vykor/protocol";
import { errorResponse, jsonResponse, readJson } from "../support.js";
import { marketplaceCatalogDto, marketplaceSourcesDto, marketplacePreviewDto, marketplaceOperationDto } from "../mappers/marketplace.js";
import type { PluginMarketplaceService } from "../../application/default-services/marketplace-service.js";

export function createMarketplaceRoutes(service?: PluginMarketplaceService): Hono {
  return new Hono()
    .use("*", async (_c, next) => {
      if (!service) return errorResponse(501, "Plugin marketplace is not configured");
      return next();
    })
    .onError(error => error instanceof ProtocolValidationError
      ? jsonResponse({ error: error.toProtocolError() }, 400) : errorResponse(400, error.message))
    .get("/catalog", async c => jsonResponse(marketplaceCatalogDto(await service!.catalog(parseMarketplaceCatalogRequest(c.req.query())))))
    .get("/sources", async () => jsonResponse(marketplaceSourcesDto(await service!.sources())))
    .post("/sources", async c => {
      const input = parseMarketplaceAddSourceRequest(await readJson(c));
      return jsonResponse(marketplaceSourcesDto(await service!.addSource(input.url)));
    })
    .patch("/sources/:sourceId", async c => {
      const input = parseMarketplaceSourceEnabledRequest(await readJson(c));
      return jsonResponse(marketplaceSourcesDto(await service!.setSourceEnabled(c.req.param("sourceId"), input.enabled)));
    })
    .delete("/sources/:sourceId", async c => jsonResponse(marketplaceSourcesDto(await service!.removeSource(c.req.param("sourceId")))))
    .post("/preview", async c => jsonResponse(marketplacePreviewDto(await service!.preview(parseMarketplacePreviewRequest(await readJson(c))))))
    .post("/cancel", async c => {
      const input = parseMarketplaceCancelRequest(await readJson(c));
      await service!.cancel(input.candidateId);
      return jsonResponse({ cancelled: true } satisfies MarketplaceCancelResponse);
    })
    .post("/install", async c => jsonResponse(marketplaceOperationDto(await service!.install(parseMarketplaceInstallRequest(await readJson(c))))))
    .get("/operations/:operationId", async c => jsonResponse(marketplaceOperationDto(await service!.operation(c.req.param("operationId")))));
}
