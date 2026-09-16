import type { MiddlewareHandler } from "hono";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@openharness/protocol";

/** Reject a different OpenHarness wire version before authentication or route side effects. */
export const protocolMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.path === "/health" || c.req.path === "/capabilities") {
    await next();
    return;
  }
  const version = c.req.header(PROTOCOL_VERSION_HEADER);
  if (version !== String(CURRENT_PROTOCOL_VERSION)) {
    return c.json({
      error: "protocol_version_mismatch",
      expected: CURRENT_PROTOCOL_VERSION,
      received: version === undefined ? null : /^\d+$/.test(version) ? Number(version) : version,
    }, 426);
  }
  await next();
};
