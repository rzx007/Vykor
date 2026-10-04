import { Hono, type Context } from "hono";
import { parseDismissPluginUiInput, parseInvokePluginUiActionInput, parsePluginUiRouteIds, ProtocolValidationError } from "@vykor/protocol";
import type { SessionPluginUiService } from "../../application/session/session-plugin-ui-service.js";
import { ApplicationError } from "../../shared/application-error.js";
import { applicationErrorResponse, jsonResponse, protocolValidationErrorResponse, readJson } from "../support.js";

export function createSessionPluginUiRoutes(service: SessionPluginUiService): Hono {
  const ids = (c: Context) => {
    if (new URL(c.req.url).search) throw new ProtocolValidationError("Plugin UI routes do not accept query parameters");
    return parsePluginUiRouteIds({ sessionId: c.req.param("sessionId")!, instanceId: c.req.param("instanceId")!,
      ...(c.req.param("requestId") ? { requestId: c.req.param("requestId") } : {}) });
  };
  const app = new Hono();
  // Unknown failures are sanitized here; the shared mapper handles all explicit boundary codes.
  app.onError(error => error instanceof ProtocolValidationError ? protocolValidationErrorResponse(error)
    : applicationErrorResponse(error instanceof ApplicationError ? error
      : new ApplicationError(503, "插件界面暂不可用", "plugin_ui_unavailable")));
  return app
    .get("/:sessionId/plugin-ui/:instanceId", async c => {
      const { sessionId, instanceId } = ids(c);
      return jsonResponse(await service.get(sessionId, instanceId));
    })
    .get("/:sessionId/plugin-ui/:instanceId/document", async c => {
      const { sessionId, instanceId } = ids(c);
      return jsonResponse(await service.getDocument(sessionId, instanceId));
    })
    .post("/:sessionId/plugin-ui/:instanceId/actions", async c => {
      const { sessionId, instanceId } = ids(c);
      const receipt = await service.invokeAction(sessionId, instanceId, parseInvokePluginUiActionInput(await readJson(c,
        new ProtocolValidationError("Plugin UI request body is too large", "args", "payload_too_large"))));
      return jsonResponse({ receipt }, ["pending", "running"].includes(receipt.status) ? 202 : 200);
    })
    .get("/:sessionId/plugin-ui/:instanceId/actions/:requestId", c => {
      const { sessionId, instanceId, requestId } = ids(c);
      return jsonResponse(service.readAction(sessionId, instanceId, requestId!));
    })
    .post("/:sessionId/plugin-ui/:instanceId/dismiss", async c => {
      const { sessionId, instanceId } = ids(c);
      return jsonResponse({ instance: await service.dismiss(sessionId, instanceId, parseDismissPluginUiInput(await readJson(c))) });
    });
}
