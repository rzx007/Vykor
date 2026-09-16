import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { protocolMiddleware } from "./protocol-middleware.js";

describe("protocol middleware", () => {
  it.each([undefined, "3", "5", "bad", "4.0", "04", "4e0"])(
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
        headers: version === undefined ? {} : { "x-openharness-protocol-version": version },
      });
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual({
        error: "protocol_version_mismatch",
        expected: 4,
        received: version === undefined ? null : ["3", "5", "04"].includes(version) ? Number(version) : version,
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
      headers: { "x-openharness-protocol-version": "4" },
    })).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(3);
    expect((await app.request("/health/extra")).status).toBe(426);
  });
});
