import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { McpOAuthCredentialRecord } from "@openharness/core";
import type { McpOAuthCredentialStore } from "./login.js";
import { McpOAuthRuntime } from "./runtime-auth.js";
import { verifyMcpOAuthConnection } from "./verify-connection.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(closers.splice(0).map(close => close())));

describe("verifyMcpOAuthConnection", () => {
  it("uses the real SDK Streamable HTTP transport with the stored bearer token", async () => {
    let authorizedCalls = 0;
    const server = createServer(async (request, response) => {
      if (request.method === "DELETE") {
        response.statusCode = 200;
        return response.end();
      }
      if (request.method !== "POST") {
        response.statusCode = 405;
        return response.end();
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (request.headers.authorization === "Bearer access") authorizedCalls += 1;
      if (message.id === undefined) {
        response.statusCode = 202;
        return response.end();
      }
      const result = message.method === "initialize"
        ? { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
        : { tools: [] };
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/mcp`;
    const credential: McpOAuthCredentialRecord = {
      serverUrl: url,
      revision: 1,
      binding: { issuer: url, redirectUri: "http://127.0.0.1/cb", authorizationEndpoint: `${url}/authorize`, tokenEndpoint: `${url}/token` },
      registration: { client_id: "client" },
      tokens: { accessToken: "access", tokenType: "Bearer", scope: ["read"], expiresAt: Date.now() + 60_000 },
    };
    const store = {
      get: async () => credential,
      set: async () => undefined,
      delete: async () => false,
      update: async () => credential,
      runExclusive: async <T>(_name: string, operation: any) => (await operation(credential)).result as T,
    } as McpOAuthCredentialStore;
    const runtime = new McpOAuthRuntime({ store });

    await expect(verifyMcpOAuthConnection({ serverName: "local", config: { type: "http", url }, runtime })).resolves.toBeUndefined();
    expect(authorizedCalls).toBeGreaterThanOrEqual(2);
  });
});
