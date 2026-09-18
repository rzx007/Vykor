import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpRemoteServerConfig } from "@openharness/core";
import type { McpOAuthRuntime } from "./runtime-auth.js";

export async function verifyMcpOAuthConnection(input: {
  serverName: string;
  config: McpRemoteServerConfig;
  runtime: McpOAuthRuntime;
}): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(input.config.url), {
    requestInit: { headers: input.config.headers },
    fetch: input.runtime.createFetch(input.serverName, input.config),
  });
  const client = new Client({ name: "openharness-oauth-verify", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    await client.listTools();
  } finally {
    await client.close().catch(() => undefined);
  }
}
