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
});
