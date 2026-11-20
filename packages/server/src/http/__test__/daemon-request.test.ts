import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { requestDaemon } from "../daemon-request.js";
import { protocolMiddleware } from "../protocol-middleware.js";

const servers: ReturnType<typeof serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
async function endpoint() {
  const app = new Hono();
  app.use("*", protocolMiddleware);
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== "Bearer owned-daemon-token") return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.post("/maintenance/prepare-root-migration", async c => c.json({ prepared: true, query: c.req.query("mode"), body: await c.req.json() }));
  app.get("/redirect", c => c.redirect("/debug/process"));
  app.get("/debug/process", c => c.json({ pid: process.pid }));
  const server = await new Promise<ReturnType<typeof serve>>(resolve => {
    const listening = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned HTTP fixture did not listen");
  return { url: `http://127.0.0.1:${address.port}`, token: "owned-daemon-token" };
}

it("sends the current protocol and daemon token while retaining the maintenance request", async () => {
  const daemon = await endpoint();
  const response = await requestDaemon(daemon, "/maintenance/prepare-root-migration?mode=drain", {
    method: "POST", headers: { "content-type": "application/json", "x-vykor-protocol-version": "invalid", authorization: "Bearer wrong" },
    body: JSON.stringify({ maintenance: true }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ prepared: true, query: "drain", body: { maintenance: true } });
  expect((await requestDaemon({ ...daemon, token: "wrong" }, "/debug/process")).status).toBe(401);
});

it("keeps the identity probe's redirect refusal", async () => {
  await expect(requestDaemon(await endpoint(), "/redirect", { redirect: "error" })).rejects.toThrow();
});

it("keeps the caller's abort signal", async () => {
  const daemon = await endpoint(), controller = new AbortController();
  controller.abort(new Error("owned migration lease compromised"));
  await expect(requestDaemon(daemon, "/debug/process", { signal: controller.signal })).rejects.toThrow("owned migration lease compromised");
});
