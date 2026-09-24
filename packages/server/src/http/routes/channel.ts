import { Hono } from "hono";

import {
  parseDurableChannelMessageInput,
  parseRecordChannelDeliveryInput,
} from "@vykor/protocol";

import type { ChannelApplicationService } from "../../application/channel/channel-application-service.js";
import {
  applicationErrorResponse,
  jsonResponse,
  protocolValidationErrorResponse,
  readJson,
  readLimit,
} from "../support.js";

export function createChannelRoutes(
  channels: Pick<
    ChannelApplicationService,
    "handleMessage" | "pendingDeliveries" | "recordDelivery" | "status"
  >,
): Hono {
  return new Hono()
    .post("/messages", async (c) => {
      try {
        return jsonResponse(
          await channels.handleMessage(
            parseDurableChannelMessageInput(await readJson(c)),
          ),
          202,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes(" is required") ||
            error.message.includes(" must be "))
        ) {
          return protocolValidationErrorResponse(error);
        }
        return applicationErrorResponse(error);
      }
    })
    .post("/deliveries/:deliveryId/result", async (c) => {
      try {
        return jsonResponse({
          delivery: channels.recordDelivery(
            c.req.param("deliveryId"),
            parseRecordChannelDeliveryInput(await readJson(c)),
          ),
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes("status must be") ||
            error.message.includes(" must be a string"))
        ) {
          return protocolValidationErrorResponse(error);
        }
        return applicationErrorResponse(error);
      }
    })
    .get("/status", (c) =>
      jsonResponse(
        channels.status({
          connector: c.req.query("connector") ?? undefined,
          limit: readLimit(c.req.query("limit")),
        }),
      ),
    )
    .get("/deliveries/pending", (c) =>
      jsonResponse({
        deliveries: channels.pendingDeliveries({
          connector: c.req.query("connector") ?? undefined,
          limit: readLimit(c.req.query("limit")),
        }),
      }),
    );
}
