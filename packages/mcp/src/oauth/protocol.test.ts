import { describe, expect, it, vi } from "vitest";
import { discoverOAuth, timedFetch } from "./protocol.js";
import { createServer } from "node:http";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("discoverOAuth", () => {
  it("does not forward secret request bodies through cross-origin redirects", async () => {
    let leaked = false;
    const sink = createServer((_request, response) => { leaked = true; response.end("ok"); });
    await new Promise<void>(resolve => sink.listen(0, "127.0.0.1", resolve));
    const source = createServer((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${(sink.address() as { port: number }).port}/leak` });
      response.end();
    });
    await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve));
    try {
      await timedFetch(fetch, `http://127.0.0.1:${(source.address() as { port: number }).port}/token`, { method: "POST", body: "refresh_token=secret" }).catch(() => undefined);
      expect(leaked).toBe(false);
    } finally {
      await Promise.all([source, sink].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
  });
  it("reports that OAuth is unnecessary when initialize succeeds without a challenge", async () => {
    const fetch = vi.fn(async () => new Response(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"public","version":"1"}}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof globalThis.fetch;

    await expect(discoverOAuth("https://mcp.public.test/mcp", fetch)).rejects.toMatchObject({
      code: "oauth-not-required",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the challenged metadata URL and expects the MCP endpoint as the resource", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://mcp.challenge.test/mcp") {
        return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.challenge.test/.well-known/oauth-protected-resource/mcp"' } });
      }
      if (url.includes("oauth-protected-resource")) {
        return json({ resource: "https://mcp.challenge.test/mcp", authorization_servers: ["https://auth.challenge.test"] });
      }
      if (url.includes("oauth-authorization-server")) {
        return json({ issuer: "https://auth.challenge.test", authorization_endpoint: "https://auth.challenge.test/a", token_endpoint: "https://auth.challenge.test/t", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await discoverOAuth("https://mcp.challenge.test/mcp", fetch);
    expect(result.source).toBe("challenge");
    expect(result.resourceUrl.href).toBe("https://mcp.challenge.test/mcp");
    expect(result.authorization.issuer).toBe("https://auth.challenge.test");
  });

  it("rejects a sibling resource advertised by the challenge", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://mcp.sibling.test/mcp") {
        return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.sibling.test/.well-known/oauth-protected-resource/mcp"' } });
      }
      if (url.includes("oauth-protected-resource")) {
        return json({ resource: "https://mcp.sibling.test/other", authorization_servers: ["https://auth.sibling.test"] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    await expect(discoverOAuth("https://mcp.sibling.test/mcp", fetch)).rejects.toMatchObject({
      code: "oauth-resource-mismatch",
    });
  });

  it("falls back to the origin root well-known and expects the origin resource", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://mcp.root.test/mcp") return new Response("", { status: 401 });
      if (url === "https://mcp.root.test/.well-known/oauth-protected-resource/mcp") return new Response("", { status: 404 });
      if (url === "https://mcp.root.test/.well-known/oauth-protected-resource") {
        return json({ resource: "https://mcp.root.test/", authorization_servers: ["https://auth.root.test"] });
      }
      if (url.includes("oauth-authorization-server")) {
        return json({ issuer: "https://auth.root.test", authorization_endpoint: "https://auth.root.test/a", token_endpoint: "https://auth.root.test/t", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await discoverOAuth("https://mcp.root.test/mcp", fetch);
    expect(result.source).toBe("origin-well-known");
    expect(result.resourceUrl.href).toBe("https://mcp.root.test/");
  });

  it("lets an explicit resource override the challenge and discovers from its own well-known", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://mcp.explicit.test/mcp") {
        // A misleading challenge must not replace the configured resource.
        return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://evil.test/.well-known/oauth-protected-resource"' } });
      }
      if (url === "https://mcp.explicit.test/.well-known/oauth-protected-resource") {
        return json({ resource: "https://mcp.explicit.test/", authorization_servers: ["https://auth.explicit.test"] });
      }
      if (url.includes("oauth-authorization-server")) {
        return json({ issuer: "https://auth.explicit.test", authorization_endpoint: "https://auth.explicit.test/a", token_endpoint: "https://auth.explicit.test/t", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await discoverOAuth("https://mcp.explicit.test/mcp", fetch, { resourceUrl: "https://mcp.explicit.test" });
    expect(result.source).toBe("explicit");
    expect(result.resourceUrl.href).toBe("https://mcp.explicit.test/");
    expect(fetch.mock.calls.map(call => String(call[0]))).not.toContain("https://evil.test/.well-known/oauth-protected-resource");
  });
});
