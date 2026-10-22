import { describe, expect, it } from "vitest";

import { assertValidMcpServerConfig, McpServerConfigError } from "./mcp-config-validation.js";

function expectInvalid(config: unknown, field: string): void {
  try {
    assertValidMcpServerConfig("srv", config);
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(McpServerConfigError);
    expect((error as McpServerConfigError).field).toBe(field);
  }
}

describe("assertValidMcpServerConfig", () => {
  it("accepts real stdio, http and sse configs", () => {
    expect(() => assertValidMcpServerConfig("srv", {
      type: "stdio",
      command: "npx",
      args: ["beui"],
      env: { KEY: "value" },
      cwd: ".",
      enabled: false,
    })).not.toThrow();
    expect(() => assertValidMcpServerConfig("srv", {
      type: "http",
      url: "https://mcp.example/mcp",
      headers: { Authorization: "Bearer x" },
      oauth: { scopes: ["read"], clientId: "client", callbackPort: 43119 },
    })).not.toThrow();
    expect(() => assertValidMcpServerConfig("srv", {
      type: "sse",
      url: "https://mcp.example/sse",
    })).not.toThrow();
  });

  it("rejects demo-only or unknown fields", () => {
    expectInvalid({ type: "stdio", command: "node", env_vars: ["A"] }, "settings.mcpServers.srv.env_vars");
    expectInvalid({ type: "http", url: "https://mcp.example/mcp", bearer_token_env_var: "TOKEN" }, "settings.mcpServers.srv.bearer_token_env_var");
    expectInvalid({ type: "http", url: "https://mcp.example/mcp", http_headers: {} }, "settings.mcpServers.srv.http_headers");
  });

  it("requires the transport-specific field", () => {
    expectInvalid({ type: "stdio" }, "settings.mcpServers.srv.command");
    expectInvalid({ type: "http" }, "settings.mcpServers.srv.url");
    expectInvalid({ type: "http", url: "ftp://mcp.example/mcp" }, "settings.mcpServers.srv.url");
    expectInvalid({ type: "http", url: "not a url" }, "settings.mcpServers.srv.url");
  });

  it("rejects fields from the other transport", () => {
    expectInvalid({ type: "stdio", command: "node", url: "https://mcp.example/mcp" }, "settings.mcpServers.srv.url");
    expectInvalid({ type: "http", url: "https://mcp.example/mcp", command: "node" }, "settings.mcpServers.srv.command");
  });

  it("validates the oauth and headers shapes", () => {
    expectInvalid({ type: "http", url: "https://mcp.example/mcp", oauth: { scopes: [1] } }, "settings.mcpServers.srv.oauth.scopes");
    expectInvalid({ type: "http", url: "https://mcp.example/mcp", oauth: { accessToken: "secret" } }, "settings.mcpServers.srv.oauth.accessToken");
    expectInvalid({ type: "http", url: "https://mcp.example/mcp", headers: { A: 1 } }, "settings.mcpServers.srv.headers");
    expectInvalid({ type: "stdio", command: "node", enabled: "no" }, "settings.mcpServers.srv.enabled");
  });
});
