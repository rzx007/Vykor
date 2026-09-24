import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpClientManager, resolveTransportKind } from "./index.js";
import type { McpConnection, McpToolInfo, McpResourceInfo } from "./index.js";
import { SandboxStdioClientTransport } from "./sandbox-stdio-transport.js";
import { createProcess } from "@vykor/sandbox";
import type { SandboxPolicy } from "@vykor/sandbox";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  const tools = [
    { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
    { name: "write_file", description: "Write a file", inputSchema: { type: "object" } },
  ];
  const resources = [
    { name: "config", uri: "file:///config.json", description: "Config file" },
  ];

  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools }),
      listResources: vi.fn().mockResolvedValue({ resources }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "result data" }],
        isError: false,
      }),
      readResource: vi.fn().mockResolvedValue({
        contents: [{ text: "resource content" }],
      }),
    })),
  };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({ kind: "stdio" })),
  getDefaultEnvironment: vi.fn(() => ({ PATH: "/usr/bin" })),
}));

vi.mock("@vykor/sandbox", () => ({
  createProcess: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi
    .fn()
    .mockImplementation(() => ({ kind: "http" })),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn().mockImplementation(() => ({ kind: "sse" })),
}));

describe("McpClientManager", () => {
  let manager: McpClientManager;

  beforeEach(() => {
    manager = new McpClientManager();
  });

  it("connects to a server and discovers tools", async () => {
    const conn = await manager.connect("test-server", {
      type: "stdio",
      command: "node",
      args: ["server.js"],
    });

    expect(conn.status).toBe("connected");
    expect(conn.tools).toHaveLength(2);
    expect(conn.tools[0]!.name).toBe("read_file");
    expect(conn.tools[1]!.name).toBe("write_file");
    expect(conn.resources).toHaveLength(1);
    expect(conn.resources[0]!.name).toBe("config");
  });

  it("disconnects from a server", async () => {
    await manager.connect("test", { type: "stdio", command: "node" });
    await manager.disconnect("test");

    const conn = manager.getConnection("test");
    expect(conn).toBeUndefined();
  });

  it("disconnectAll removes all connections", async () => {
    await manager.connect("s1", { type: "stdio", command: "node" });
    await manager.connect("s2", { type: "stdio", command: "node" });
    await manager.disconnectAll();

    expect(manager.getConnections()).toHaveLength(0);
  });

  it("getConnections returns all connections", async () => {
    await manager.connect("a", { type: "stdio", command: "node" });
    await manager.connect("b", { type: "stdio", command: "node" });

    const conns = manager.getConnections();
    expect(conns).toHaveLength(2);
  });

  it("getConnectedTools returns tools from connected servers only", async () => {
    await manager.connect("active", { type: "stdio", command: "node" });
    manager["connections"].set("dead", {
      name: "dead",
      config: { type: "stdio", command: "node" },
      status: "error",
      transport: "stdio",
      authConfigured: false,
      tools: [{ serverName: "dead", name: "x", description: "", inputSchema: {} }],
      resources: [],
      error: new Error("fail"),
    });

    const tools = manager.getConnectedTools();
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => t.serverName === "active")).toBe(true);
  });

  it("getAsToolDefinitions wraps MCP tools with mcp__ prefix", async () => {
    await manager.connect("fs", { type: "stdio", command: "node" });

    const defs = manager.getAsToolDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs[0]!.name).toBe("mcp__fs__read_file");
    expect(defs[0]!.description).toContain("[fs]");
    expect(typeof defs[0]!.execute).toBe("function");
  });

  it("callTool throws for unknown server", async () => {
    await expect(
      manager.callTool("nope", "tool", {})
    ).rejects.toThrow("MCP server not found");
  });

  it("callTool delegates to client and returns result", async () => {
    await manager.connect("test", { type: "stdio", command: "node" });

    const result = await manager.callTool("test", "read_file", { path: "/tmp" });
    expect(result.content).toBe("result data");
    expect(result.isError).toBe(false);
  });

  it("forwards a tool abort signal to MCP requests", async () => {
    await manager.connect("test", { type: "stdio", command: "node" });
    const controller = new AbortController();
    const client = manager["clients"].get("test") as { callTool: ReturnType<typeof vi.fn> };

    await manager.callTool("test", "read_file", { path: "/tmp" }, controller.signal);

    expect(client.callTool).toHaveBeenLastCalledWith(
      { name: "read_file", arguments: { path: "/tmp" } },
      undefined,
      { signal: controller.signal },
    );
  });

  it("readResource throws for unknown server", async () => {
    await expect(
      manager.readResource("nope", "file:///x")
    ).rejects.toThrow("MCP server not found");
  });

  it("readResource returns resource content", async () => {
    await manager.connect("test", { type: "stdio", command: "node" });

    const content = await manager.readResource("test", "file:///config.json");
    expect(content).toBe("resource content");
  });

  it("forwards a tool abort signal when reading MCP resources", async () => {
    await manager.connect("test", { type: "stdio", command: "node" });
    const controller = new AbortController();
    const client = manager["clients"].get("test") as { readResource: ReturnType<typeof vi.fn> };

    await manager.readResource("test", "file:///config.json", controller.signal);

    expect(client.readResource).toHaveBeenLastCalledWith(
      { uri: "file:///config.json" },
      { signal: controller.signal },
    );
  });

  it("handles connection failure gracefully", async () => {
    vi.mocked(
      (await import("@modelcontextprotocol/sdk/client/index.js")).Client
    ).mockImplementationOnce(() => ({
      connect: vi.fn().mockRejectedValue(new Error("spawn failed")),
      close: vi.fn(),
      listTools: vi.fn(),
      listResources: vi.fn(),
      callTool: vi.fn(),
      readResource: vi.fn(),
    }));

    const conn = await manager.connect("bad", { type: "stdio", command: "nonexistent" });
    expect(conn.status).toBe("error");
    expect(conn.error).toBeDefined();
  });

  it("getConnectedResources returns resources from connected servers", async () => {
    await manager.connect("test", { type: "stdio", command: "node" });

    const resources = manager.getConnectedResources();
    expect(resources).toHaveLength(1);
    expect(resources[0]!.uri).toBe("file:///config.json");
  });

  it("uses StreamableHTTPClientTransport with headers for http servers", async () => {
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    vi.mocked(StreamableHTTPClientTransport).mockClear();

    const headers = { Authorization: "Bearer token-123" };
    const conn = await manager.connect("http-srv", {
      type: "http",
      url: "https://example.com/mcp",
      headers,
    });

    expect(conn.status).toBe("connected");
    expect(conn.transport).toBe("http");
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(StreamableHTTPClientTransport).mock
      .calls[0]!;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).href).toBe("https://example.com/mcp");
    expect(opts!.requestInit!.headers).toEqual(headers);
  });

  it("uses SSEClientTransport with headers for sse servers", async () => {
    const { SSEClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/sse.js"
    );
    vi.mocked(SSEClientTransport).mockClear();

    const headers = { "X-Api-Key": "secret" };
    const conn = await manager.connect("sse-srv", {
      type: "sse",
      url: "https://example.com/sse",
      headers,
    });

    expect(conn.status).toBe("connected");
    expect(conn.transport).toBe("sse");
    expect(SSEClientTransport).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(SSEClientTransport).mock.calls[0]!;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).href).toBe("https://example.com/sse");
    expect(opts!.requestInit!.headers).toEqual(headers);
  });

  it("stdio servers use the sandbox-aware stdio transport", async () => {
    const conn = await manager.connect("stdio-srv", {
      type: "stdio",
      command: "node",
      args: ["server.js"],
    });

    expect(conn.status).toBe("connected");
    expect(conn.transport).toBe("stdio");
    expect(manager["transports"].get("stdio-srv")).toBeInstanceOf(SandboxStdioClientTransport);
  });

  it("sandbox stdio transport starts MCP servers through createProcess", async () => {
    const child = makeChildProcess();
    const policy = { test: "policy" } as unknown as SandboxPolicy;
    vi.mocked(createProcess).mockResolvedValueOnce(child as any);
    const transport = new SandboxStdioClientTransport({
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "abc" },
      cwd: "/repo",
      settings: {
        model: "m",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        sandbox: { enabled: true, failIfUnavailable: true },
      },
      sessionId: "s1",
      policy,
    });

    const started = transport.start();
    await Promise.resolve();
    child.emit("spawn");
    await started;

    expect(createProcess).toHaveBeenCalledWith(["node", "server.js"], expect.objectContaining({
      cwd: "/repo",
      sessionId: "s1",
      env: { PATH: "/usr/bin", TOKEN: "abc" },
      stdio: ["pipe", "pipe", "inherit"],
      detached: false,
      policy,
    }));
  });

  it("authConfigured reflects headers (http) and env (stdio)", async () => {
    const http = await manager.connect("http-auth", {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
    expect(http.authConfigured).toBe(true);

    const stdioAuth = await manager.connect("stdio-auth", {
      type: "stdio",
      command: "node",
      env: { TOKEN: "abc" },
    });
    expect(stdioAuth.authConfigured).toBe(true);

    const stdioNoAuth = await manager.connect("stdio-noauth", {
      type: "stdio",
      command: "node",
    });
    expect(stdioNoAuth.authConfigured).toBe(false);

    const httpNoAuth = await manager.connect("http-noauth", {
      type: "http",
      url: "https://example.com/mcp",
    });
    expect(httpNoAuth.authConfigured).toBe(false);
  });

  it("invalid config sets status=error without throwing, in isolation", async () => {
    await manager.connectAll({
      bad: {} as any,
      good: { type: "stdio", command: "node" },
    });

    const bad = manager.getConnection("bad");
    const good = manager.getConnection("good");
    expect(bad!.status).toBe("error");
    expect(bad!.error).toBeDefined();
    expect(good!.status).toBe("connected");
  });

  it("resources Method-not-found returns [] and does not fail connect", async () => {
    vi.mocked(
      (await import("@modelcontextprotocol/sdk/client/index.js")).Client
    ).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue({ tools: [] }),
          listResources: vi
            .fn()
            .mockRejectedValue(new Error("MCP error -32601: Method not found")),
        }) as any
    );

    const conn = await manager.connect("no-resources", { type: "stdio", command: "node" });
    expect(conn.status).toBe("connected");
    expect(conn.resources).toEqual([]);
    expect(conn.resourceError).toBeUndefined();
  });

  it("other resource errors are recorded but connect still succeeds", async () => {
    vi.mocked(
      (await import("@modelcontextprotocol/sdk/client/index.js")).Client
    ).mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue({ tools: [] }),
          listResources: vi
            .fn()
            .mockRejectedValue(new Error("connection reset")),
        }) as any
    );

    const conn = await manager.connect("flaky-resources", { type: "stdio", command: "node" });
    expect(conn.status).toBe("connected");
    expect(conn.resources).toEqual([]);
    expect(conn.resourceError).toBeDefined();
    expect(conn.resourceError!.message).toContain("connection reset");
  });

  describe("staged connections", () => {
    it("prepareConnection discovers tools without publishing the connection", async () => {
      const prepared = await manager.prepareConnection("linear", { type: "stdio", command: "node" });

      expect(prepared.connection.status).toBe("connected");
      expect(prepared.tools.map((tool) => tool.name)).toEqual([
        "mcp__linear__read_file",
        "mcp__linear__write_file",
      ]);
      expect(manager.getConnection("linear")).toBeUndefined();
      expect(manager.getConnections()).toHaveLength(0);
    });

    it("closes staged resources and throws when preparation fails", async () => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      vi.mocked(Client).mockImplementationOnce(() => ({
        connect: vi.fn().mockRejectedValue(new Error("spawn failed")),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn(),
        listResources: vi.fn(),
        callTool: vi.fn(),
        readResource: vi.fn(),
      } as any));

      await expect(
        manager.prepareConnection("bad", { type: "stdio", command: "node" }),
      ).rejects.toThrow("spawn failed");
      expect(manager.getConnection("bad")).toBeUndefined();
      expect(manager.getConnections()).toHaveLength(0);
    });

    it("activates a prepared connection and closes the previous one", async () => {
      const previous = await manager.connect("linear", { type: "stdio", command: "node" });
      const previousClient = manager["clients"].get("linear") as { close: ReturnType<typeof vi.fn> };
      const prepared = await manager.prepareConnection("linear", { type: "stdio", command: "node" });

      const activation = manager.activatePreparedConnection(prepared, () => undefined);

      expect(activation.committed).toBe(true);
      expect(manager.getConnection("linear")).toBe(prepared.connection);
      expect(manager.getConnection("linear")).not.toBe(previous);
      if (!activation.committed) throw new Error("expected commit");
      await activation.closePrevious();
      expect(previousClient.close).toHaveBeenCalledTimes(1);
      expect(manager.getConnection("linear")).toBe(prepared.connection);
    });

    it("restores the previous connection when the tool commit throws", async () => {
      const previous = await manager.connect("linear", { type: "stdio", command: "node" });
      const prepared = await manager.prepareConnection("linear", { type: "stdio", command: "node" });
      const stagedClient = prepared.client as unknown as { close: ReturnType<typeof vi.fn> };

      const activation = manager.activatePreparedConnection(prepared, () => {
        throw new Error("registry rejected");
      });

      expect(activation.committed).toBe(false);
      if (activation.committed) throw new Error("expected failure");
      expect(activation.error).toBeInstanceOf(Error);
      expect(manager.getConnection("linear")).toBe(previous);
      expect(manager["clients"].get("linear")).not.toBe(prepared.client);
      await activation.discardPrepared();
      expect(stagedClient.close).toHaveBeenCalledTimes(1);
    });

    it("keeps the new connection when closing the previous one fails", async () => {
      await manager.connect("linear", { type: "stdio", command: "node" });
      const previousClient = manager["clients"].get("linear") as { close: ReturnType<typeof vi.fn> };
      previousClient.close.mockRejectedValueOnce(new Error("close failed"));
      const prepared = await manager.prepareConnection("linear", { type: "stdio", command: "node" });

      const activation = manager.activatePreparedConnection(prepared, () => undefined);
      if (!activation.committed) throw new Error("expected commit");

      await expect(activation.closePrevious()).rejects.toThrow("close failed");
      expect(manager.getConnection("linear")).toBe(prepared.connection);
      expect(manager["clients"].get("linear")).toBe(prepared.client);
    });

    it("clears local maps even when disconnect close fails", async () => {
      await manager.connect("linear", { type: "stdio", command: "node" });
      const client = manager["clients"].get("linear") as { close: ReturnType<typeof vi.fn> };
      client.close.mockRejectedValueOnce(new Error("close failed"));

      await expect(manager.disconnect("linear")).rejects.toThrow("close failed");
      expect(manager.getConnection("linear")).toBeUndefined();
      expect(manager["clients"].has("linear")).toBe(false);
      expect(manager["transports"].has("linear")).toBe(false);
    });

    it("keeps captured tool definitions on their original client after activation", async () => {
      await manager.connect("linear", { type: "stdio", command: "node" });
      const captured = manager.getAsToolDefinitions()[0]!;
      const prepared = await manager.prepareConnection("linear", { type: "stdio", command: "node" });
      const activation = manager.activatePreparedConnection(prepared, () => undefined);
      if (!activation.committed) throw new Error("expected commit");

      const result = await captured.execute({}, { cwd: process.cwd() });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("connection changed or closed");
      await activation.closePrevious();
    });

    it("keeps a replaced client callable until its owning Run releases it", async () => {
      await manager.connect("linear", { type: "stdio", command: "node" });
      const oldClient = manager["clients"].get("linear") as { close: ReturnType<typeof vi.fn> };
      const captured = manager.getAsToolDefinitions()[0]!;
      const releaseRun = manager.retainCurrentConnections();
      const prepared = await manager.prepareConnection("linear", { type: "stdio", command: "node" });
      const activation = manager.activatePreparedConnection(prepared, () => undefined);
      if (!activation.committed) throw new Error("expected commit");

      await activation.closePrevious();
      expect(oldClient.close).not.toHaveBeenCalled();
      expect((await captured.execute({}, { cwd: process.cwd() })).isError).toBeFalsy();

      releaseRun();
      await vi.waitFor(() => expect(oldClient.close).toHaveBeenCalledOnce());
      expect((await captured.execute({}, { cwd: process.cwd() })).isError).toBe(true);
    });

    it("force-closes a leased old client on logout", async () => {
      await manager.connect("linear", { type: "stdio", command: "node" });
      const oldClient = manager["clients"].get("linear") as { close: ReturnType<typeof vi.fn> };
      const captured = manager.getAsToolDefinitions()[0]!;
      const releaseRun = manager.retainCurrentConnections();
      const prepared = await manager.prepareConnection("linear", { type: "stdio", command: "node" });
      const activation = manager.activatePreparedConnection(prepared, () => undefined);
      if (!activation.committed) throw new Error("expected commit");
      await activation.closePrevious();

      await manager.disconnect("linear");

      expect(oldClient.close).toHaveBeenCalledOnce();
      expect((await captured.execute({}, { cwd: process.cwd() })).isError).toBe(true);
      releaseRun();
      expect(oldClient.close).toHaveBeenCalledOnce();
    });

    it("closes retired clients even if the current client close throws synchronously", async () => {
      await manager.connect("linear", { type: "stdio", command: "node" });
      const oldClient = manager["clients"].get("linear") as { close: ReturnType<typeof vi.fn> };
      const releaseRun = manager.retainCurrentConnections();
      const prepared = await manager.prepareConnection("linear", { type: "stdio", command: "node" });
      const activation = manager.activatePreparedConnection(prepared, () => undefined);
      if (!activation.committed) throw new Error("expected commit");
      await activation.closePrevious();
      const currentClient = manager["clients"].get("linear") as { close: ReturnType<typeof vi.fn> };
      currentClient.close.mockImplementationOnce(() => { throw new Error("synchronous close failed"); });

      await expect(manager.disconnect("linear")).rejects.toThrow("synchronous close failed");

      expect(oldClient.close).toHaveBeenCalledOnce();
      expect(manager.getConnection("linear")).toBeUndefined();
      releaseRun();
    });
  });
});

function makeChildProcess(): EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

describe("resolveTransportKind", () => {
  it("uses the required http type", () => {
    expect(resolveTransportKind({ type: "http", url: "https://x/mcp" })).toBe("http");
  });

  it("uses the required stdio type", () => {
    expect(resolveTransportKind({ type: "stdio", command: "node" })).toBe("stdio");
  });

  it("rejects a missing type instead of inferring it", () => {
    const result = resolveTransportKind({ url: "https://x" } as any);
    expect((result as { error: string }).error).toMatch(/type/);
  });

  it("type=sse with url resolves to sse", () => {
    expect(resolveTransportKind({ type: "sse", url: "https://x/sse" })).toBe(
      "sse"
    );
  });

  it("missing both command and url returns error", () => {
    const r = resolveTransportKind({} as any);
    expect(typeof r).toBe("object");
    expect((r as { error: string }).error).toMatch(/type/);
  });

  it("http/sse without url returns error", () => {
    expect((resolveTransportKind({ type: "http" } as any) as any).error).toMatch(
      /url/
    );
    expect((resolveTransportKind({ type: "sse" } as any) as any).error).toMatch(/url/);
  });

  it("stdio without command returns error", () => {
    expect(
      (resolveTransportKind({ type: "stdio" } as any) as any).error
    ).toMatch(/command/);
  });

  it("rejects empty and mixed transport fields", () => {
    expect((resolveTransportKind({ type: "stdio", command: " " } as any) as any).error)
      .toMatch(/command/);
    expect((resolveTransportKind({ type: "stdio", command: "node", url: "https://x" } as any) as any).error)
      .toMatch(/remote transport fields/);
    expect((resolveTransportKind({ type: "http", url: "https://x", command: "node" } as any) as any).error)
      .toMatch(/stdio transport fields/);
  });
});
