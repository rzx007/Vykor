import { Hono } from "hono";
import { parsePluginUiRouteIds, ProtocolValidationError } from "@vykor/protocol";
import type { PluginUiHistoryService } from "../../application/session/plugin-ui-history-service.js";
import { ApplicationError } from "../../shared/application-error.js";
import { applicationErrorResponse, protocolValidationErrorResponse, jsonResponse } from "../support.js";
export function createSessionPluginUiHistoryRoutes(service?: PluginUiHistoryService): Hono {
  const app = new Hono();
  app.onError(error => error instanceof ProtocolValidationError ? protocolValidationErrorResponse(error)
    : applicationErrorResponse(error instanceof ApplicationError ? error : new ApplicationError(503, "历史回执暂不可用")));
  app.get("/:sessionId/plugin-ui/:instanceId/actions/:requestId", c => {
    const ids = parsePluginUiRouteIds(c.req.param());
    if (!service) throw new ApplicationError(404, "找不到历史回执");
    return jsonResponse(service.readAction(ids.sessionId, ids.instanceId, ids.requestId!));
  });
  app.get("/:sessionId/plugin-ui/:instanceId/conversation/submissions/:requestId", c => {
    const ids = parsePluginUiRouteIds(c.req.param());
    if (!service) throw new ApplicationError(404, "找不到历史回执");
    return jsonResponse({ receipt: service.getSubmission(ids.sessionId, ids.instanceId, ids.requestId!) });
  });
  const retired = () => applicationErrorResponse(new ApplicationError(410, "旧插件界面已停用，请升级到 MCP Apps", "plugin_ui_retired"));
  app.all("/:sessionId/plugin-ui", retired);
  app.all("/:sessionId/plugin-ui/*", retired);
  return app;
}
