import { Hono, type Context } from "hono";
import {
  parsePluginUiRouteIds,
  parsePluginUiConversationRequest,
  parseSubmitPluginUiConversationInput,
  ProtocolValidationError,
} from "@vykor/protocol";
import type { SessionPluginUiConversationService } from "../../application/session/session-plugin-ui-conversation-service.js";
import { ApplicationError } from "../../shared/application-error.js";
import {
  applicationErrorResponse,
  jsonResponse,
  protocolValidationErrorResponse,
  readJson,
} from "../support.js";

export function createSessionPluginUiConversationRoutes(
  service: SessionPluginUiConversationService,
): Hono {
  const ids = (c: Context) => {
    if (new URL(c.req.url).search)
      throw new ProtocolValidationError(
        "Plugin UI routes do not accept query parameters",
      );
    return parsePluginUiRouteIds({
      sessionId: c.req.param("sessionId")!,
      instanceId: c.req.param("instanceId")!,
      ...(c.req.param("requestId")
        ? { requestId: c.req.param("requestId") }
        : {}),
    });
  };
  const body = (c: Context) =>
    readJson(
      c,
      new ProtocolValidationError(
        "Plugin UI conversation body is too large",
        "data",
        "payload_too_large",
      ),
      64 * 1024,
    );
  const app = new Hono();
  app.onError((error) =>
    error instanceof ProtocolValidationError
      ? error.details?.reason === "payload_too_large"
        ? applicationErrorResponse(
            new ApplicationError(
              413,
              "插件交接内容过大",
              "plugin_ui_payload_too_large",
            ),
          )
        : protocolValidationErrorResponse(error)
      : applicationErrorResponse(
          error instanceof ApplicationError
            ? error
            : new ApplicationError(
                503,
                "插件交接暂不可用",
                "plugin_ui_unavailable",
              ),
        ),
  );
  return app
    .post(
      "/:sessionId/plugin-ui/:instanceId/conversation/prepare",
      async (c) => {
        const { sessionId, instanceId } = ids(c);
        return jsonResponse(
          await service.prepare(
            sessionId,
            instanceId,
            parsePluginUiConversationRequest(await body(c)),
          ),
        );
      },
    )
    .post(
      "/:sessionId/plugin-ui/:instanceId/conversation/submissions",
      async (c) => {
        const { sessionId, instanceId } = ids(c);
        const receipt = await service.submit(
          sessionId,
          instanceId,
          parseSubmitPluginUiConversationInput(await body(c)),
        );
        return jsonResponse(
          { receipt },
          receipt.status === "pending" || receipt.status === "running"
            ? 202
            : 200,
        );
      },
    )
    .get(
      "/:sessionId/plugin-ui/:instanceId/conversation/submissions/:requestId",
      (c) => {
        const { sessionId, instanceId, requestId } = ids(c);
        return jsonResponse({
          receipt: service.getSubmission(sessionId, instanceId, requestId!),
        });
      },
    );
}
