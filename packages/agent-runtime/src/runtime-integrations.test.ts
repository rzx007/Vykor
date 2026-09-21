import { describe, expect, it, vi } from "vitest";
import type {
  ActiveMcpRuntimeHandle,
  McpOAuthCredentialRecord,
  McpRuntimeRegistry,
  McpServerIdentity,
} from "@openharness/core";
import type { McpClientManager } from "@openharness/mcp";

import { createMcpRuntimeHandle, selectMcpServersForEnvironment } from "./runtime-integrations.js";

const SERVERS = {
  local: { type: "stdio" as const, command: "node" },
  remote: { type: "http" as const, url: "https://mcp.example.test" },
};

describe("MCP execution domains", () => {
  it("keeps all configured transports for local execution", () => {
    expect(selectMcpServersForEnvironment(SERVERS)).toEqual(SERVERS);
  });

  it("keeps stdio and remote MCP in a networked WSL environment", () => {
    expect(selectMcpServersForEnvironment(SERVERS, {
      kind: "wsl",
      networkMode: "host",
    })).toEqual(SERVERS);
  });

  it("keeps stdio MCP but removes remote MCP in a network-isolated WSL environment", () => {
    expect(selectMcpServersForEnvironment(SERVERS, {
      kind: "wsl",
      networkMode: "none",
    })).toEqual({ local: SERVERS.local });
  });
});

const linearIdentity: McpServerIdentity = {
  name: "linear",
  transport: "http",
  endpoint: "https://mcp.linear.app/mcp",
  endpointFingerprint: "fingerprint-linear",
};

const usableCredential: McpOAuthCredentialRecord = {
  serverUrl: "https://mcp.linear.app/mcp",
  revision: 1,
  binding: {
    issuer: "https://auth.linear.app",
    redirectUri: "http://127.0.0.1/cb",
    authorizationEndpoint: "https://auth.linear.app/a",
    tokenEndpoint: "https://auth.linear.app/t",
  },
  registration: { client_id: "client" },
  tokens: { accessToken: "token", tokenType: "Bearer", scope: ["read"] },
};

function createHandle(options: {
  config?: Record<string, unknown>;
  credential?: McpOAuthCredentialRecord;
  connection?: { status: string } | undefined;
  generation?: number;
} = {}) {
  const stageAndActivate = vi.fn(async () => undefined);
  const disconnectServer = vi.fn(async () => undefined);
  const registry = {
    register: vi.fn(() => () => undefined),
    currentGeneration: vi.fn(() => options.generation ?? 3),
  } as unknown as McpRuntimeRegistry;
  const mcpManager = {
    getConnection: vi.fn(() => options.connection),
  } as unknown as McpClientManager;
  const handle: ActiveMcpRuntimeHandle = createMcpRuntimeHandle({
    sessionId: "session-1",
    identityFor: (name) => (name === "linear" ? linearIdentity : undefined),
    mcpServers: {
      linear: (options.config ?? {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        oauth: { scopes: ["read"] },
      }) as never,
    },
    mcpManager,
    credentialStore: {
      get: vi.fn(async () => options.credential),
    } as never,
    registry,
    stageAndActivate,
    disconnectServer,
  });
  return { handle, stageAndActivate, disconnectServer, registry };
}

describe("createMcpRuntimeHandle", () => {
  it("exposes the identity only for configured HTTP servers", () => {
    const { handle } = createHandle();
    expect(handle.identity("linear")).toEqual(linearIdentity);
    expect(handle.identity("missing")).toBeUndefined();
  });

  it("maps internal connection states onto runtime statuses", () => {
    expect(createHandle({ connection: { status: "connected" } }).handle.getStatus(linearIdentity)).toBe("connected");
    expect(createHandle({ connection: { status: "error" } }).handle.getStatus(linearIdentity)).toBe("error");
    expect(createHandle({ connection: { status: "connecting" } }).handle.getStatus(linearIdentity)).toBe("disconnected");
    expect(createHandle({ connection: undefined }).handle.getStatus(linearIdentity)).toBe("disconnected");
  });

  it("reconnects with the granted generation when a usable OAuth credential exists", async () => {
    const { handle, stageAndActivate, disconnectServer } = createHandle({ credential: usableCredential });

    await handle.synchronize(linearIdentity, 3);

    expect(stageAndActivate).toHaveBeenCalledWith("linear", expect.anything(), linearIdentity, 3);
    expect(disconnectServer).not.toHaveBeenCalled();
  });

  it("disconnects when the credential store has no usable credential", async () => {
    const { handle, stageAndActivate, disconnectServer } = createHandle({ credential: undefined });

    await handle.synchronize(linearIdentity, 3);

    expect(stageAndActivate).not.toHaveBeenCalled();
    expect(disconnectServer).toHaveBeenCalledWith("linear");
  });

  it("ignores a superseded generation", async () => {
    const { handle, stageAndActivate, disconnectServer } = createHandle({ credential: usableCredential, generation: 4 });

    await handle.synchronize(linearIdentity, 3);

    expect(stageAndActivate).not.toHaveBeenCalled();
    expect(disconnectServer).not.toHaveBeenCalled();
  });

  it("ignores a synchronize for a mismatched endpoint", async () => {
    const { handle, stageAndActivate, disconnectServer } = createHandle({ credential: usableCredential });

    await handle.synchronize({ ...linearIdentity, endpointFingerprint: "other" }, 3);

    expect(stageAndActivate).not.toHaveBeenCalled();
    expect(disconnectServer).not.toHaveBeenCalled();
  });

  it("does not touch static bearer servers", async () => {
    const { handle, stageAndActivate, disconnectServer } = createHandle({
      config: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer static" },
      },
      credential: usableCredential,
    });

    await handle.synchronize(linearIdentity, 3);

    expect(stageAndActivate).not.toHaveBeenCalled();
    expect(disconnectServer).not.toHaveBeenCalled();
  });
});
