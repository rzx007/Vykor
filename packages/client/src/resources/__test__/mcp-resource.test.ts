import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../../transport/http-transport.js";
import { McpResource } from "../mcp-resource.js";

function makeResource() {
  const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
  const transport = {
    request: vi.fn(async (path: string, options: Record<string, unknown> = {}) => {
      calls.push({ path, options });
      return { status: "connected", affectedRuntimes: 1, failures: [] };
    }),
    path: (pathname: string, query: Record<string, unknown> = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        params.set(key, String(value));
      }
      const qs = params.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
  };
  return { resource: new McpResource(transport as unknown as HttpTransport), calls };
}

describe("McpResource", () => {
  it("reads runtime status with the endpoint fingerprint as a query parameter", async () => {
    const { resource, calls } = makeResource();
    const result = await resource.runtimeStatus("linear", "A".repeat(43));

    expect(calls[0]).toMatchObject({ path: `/mcp/linear/runtime-status?fingerprint=${"A".repeat(43)}` });
    expect(calls[0]?.options.method).toBeUndefined();
    expect(result).toEqual({ status: "connected", affectedRuntimes: 1, failures: [] });
  });

  it("posts synchronize with only the fingerprint in the JSON body", async () => {
    const { resource, calls } = makeResource();
    await resource.synchronize("linear", "A".repeat(43));

    expect(calls[0]).toMatchObject({
      path: "/mcp/linear/synchronize",
      options: { method: "POST", body: { fingerprint: "A".repeat(43) } },
    });
  });

  it("posts reconcile-global with only the server name", async () => {
    const { resource, calls } = makeResource();
    await resource.reconcileGlobal("linear");

    expect(calls[0]).toMatchObject({
      path: "/mcp/linear/reconcile-global",
      options: { method: "POST", body: {} },
    });
  });

  it("encodes server names and forwards the abort signal", async () => {
    const { resource, calls } = makeResource();
    const controller = new AbortController();
    await resource.runtimeStatus("linear/prod", "A".repeat(43), { signal: controller.signal });

    expect(calls[0]?.path).toContain("/mcp/linear%2Fprod/runtime-status");
    expect(calls[0]?.options.signal).toBe(controller.signal);
  });

  it("propagates transport errors", async () => {
    const transport = {
      request: vi.fn(async () => { throw new Error("unauthorized"); }),
      path: (pathname: string) => pathname,
    };
    const resource = new McpResource(transport as unknown as HttpTransport);

    await expect(resource.synchronize("linear", "A".repeat(43))).rejects.toThrow("unauthorized");
  });

  describe("OAuth operations", () => {
    function makeOAuthResource() {
      const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
      const transport = {
        request: vi.fn(async (path: string, options: Record<string, unknown> = {}) => {
          calls.push({ path, options });
          return { loginId: "l1", state: "pending" };
        }),
        requestResponse: vi.fn(async (path: string) => {
          calls.push({ path, options: {} });
          return new Response(
            'event: mcp.oauth.login.completed\ndata: {"event":"mcp.oauth.login.completed","data":{"loginId":"l1","name":"linear","state":"completed","credentialCommitted":true,"authorizationReady":true}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
        path: (pathname: string, query: Record<string, unknown> = {}) => {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(query)) if (value != null) params.set(key, String(value));
          const qs = params.toString();
          return qs ? `${pathname}?${qs}` : pathname;
        },
      };
      return { resource: new McpResource(transport as unknown as HttpTransport), calls };
    }

    it("starts a login, submits a callback, cancels and logs out through typed endpoints", async () => {
      const { resource, calls } = makeOAuthResource();

      await resource.startLogin("linear/prod", { oauthInstanceId: "i", requestId: "r", callbackMode: "manual" });
      expect(calls[0]).toMatchObject({
        path: "/mcp/linear%2Fprod/oauth/login",
        options: { method: "POST", body: { oauthInstanceId: "i", requestId: "r", callbackMode: "manual" } },
      });

      await resource.submitCallback("l1", "https://app.example/cb?code=c");
      expect(calls[1]).toMatchObject({
        path: "/mcp/oauth/operations/l1/callback",
        options: { method: "POST", body: { callbackUrl: "https://app.example/cb?code=c" } },
      });

      await resource.cancelLogin("l1");
      expect(calls[2]).toMatchObject({ path: "/mcp/oauth/operations/l1", options: { method: "DELETE" } });

      await resource.logout("linear");
      expect(calls[3]).toMatchObject({ path: "/mcp/linear/oauth/logout", options: { method: "POST" } });
    });

    it("reads the OAuth status snapshot and a single operation", async () => {
      const { resource, calls } = makeOAuthResource();
      await resource.authStatus();
      await resource.getLogin("l1");
      expect(calls[0]?.path).toBe("/mcp/oauth/status");
      expect(calls[1]?.path).toBe("/mcp/oauth/operations/l1");
    });

    it("decodes login completion events from the SSE stream", async () => {
      const { resource } = makeOAuthResource();
      const events: string[] = [];
      for await (const event of resource.watchLogin("l1")) {
        events.push(event.event);
      }
      expect(events).toEqual(["mcp.oauth.login.completed"]);
    });

    it("cancels the response when a watcher stops reading before completion", async () => {
      let cancelled = false;
      const transport = {
        requestResponse: async () => new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"event":"mcp.oauth.login.updated","data":{"loginId":"l1","name":"linear","state":"pending","credentialCommitted":false,"authorizationReady":false}}\n\n'));
          },
          cancel() { cancelled = true; },
        })),
      };
      const resource = new McpResource(transport as unknown as HttpTransport);
      for await (const _event of resource.watchLogin("l1")) break;
      expect(cancelled).toBe(true);
    });
  });
});
