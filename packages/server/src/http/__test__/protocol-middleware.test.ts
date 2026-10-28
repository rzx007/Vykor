import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { protocolMiddleware } from "../protocol-middleware.js";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";

describe("protocol middleware", () => {
  it.each([undefined, "3", "5", String(CURRENT_PROTOCOL_VERSION + 1), "bad", "4.0", "04", "4e0"])(
    "rejects %s before authentication, database writes or process startup",
    async (version) => {
      const auth = vi.fn();
      const write = vi.fn();
      const spawn = vi.fn();
      const app = new Hono().use("*", protocolMiddleware)
        .use("*", async (_c, next) => { auth(); await next(); })
        .post("/sessions", (c) => { write(); spawn(); return c.json({ ok: true }); });
      const response = await app.request("/sessions", {
        method: "POST",
        headers: version === undefined ? {} : { "x-vykor-protocol-version": version },
      });
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual({
        error: "protocol_version_mismatch",
        expected: CURRENT_PROTOCOL_VERSION,
        received: version === undefined ? null : ["3", "5", String(CURRENT_PROTOCOL_VERSION + 1), "04"].includes(version) ? Number(version) : version,
      });
      expect(auth).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("allows current requests and only the two discovery paths without a version", async () => {
    const handler = vi.fn();
    const app = new Hono().use("*", protocolMiddleware).all("*", (c) => {
      handler();
      return c.json({ ok: true });
    });
    for (const path of ["/health", "/capabilities"]) {
      expect((await app.request(path)).status).toBe(200);
    }
    expect((await app.request("/sessions", {
      headers: { "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION) },
    })).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(3);
    expect((await app.request("/health/extra")).status).toBe(426);
  });
});
