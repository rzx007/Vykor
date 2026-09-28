import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpRemoteServerConfig } from "@vykor/core";
import type { McpOAuthRuntime } from "./runtime-auth.js";

export async function verifyMcpOAuthConnection(input: {
  serverName: string;
  config: McpRemoteServerConfig;
  runtime: McpOAuthRuntime;
  signal?: AbortSignal;
}): Promise<void> {
  input.signal?.throwIfAborted();
  const authenticatedFetch = input.runtime.createFetch(input.serverName, input.config);
  const transport = new StreamableHTTPClientTransport(new URL(input.config.url), {
    requestInit: { headers: input.config.headers },
    fetch: (request, init) => authenticatedFetch(request, {
      ...init,
      signal: input.signal ? AbortSignal.any([input.signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal,
    }),
  });
  const client = new Client({ name: "vykor-oauth-verify", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { signal: input.signal });
    await client.listTools(undefined, { signal: input.signal });
  } finally {
    await client.close().catch(() => undefined);
  }
}
