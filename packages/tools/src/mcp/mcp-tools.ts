import type { ToolDefinition } from "@vykor/core";
import type { McpClientManager } from "@vykor/mcp";

function mcpManagerFrom(context: { mcpManager?: unknown }): McpClientManager | undefined {
  return context.mcpManager as McpClientManager | undefined;
}

export const mcpToolCallTool: ToolDefinition = {
  name: "McpToolCall",
  description: "Call a tool on a connected MCP server.",
  inputSchema: {
    type: "object",
    properties: {
      serverName: { type: "string", description: "MCP server name" },
      toolName: { type: "string", description: "Tool name on the server" },
      args: { type: "object", description: "Tool arguments", default: {} },
    },
    required: ["serverName", "toolName"],
  },
  async execute(input, context) {
    const mgr = mcpManagerFrom(context);
    if (!mgr) {
      return { content: [{ type: "text", text: "MCP manager not available in context" }], isError: true };
    }
    try {
      const result = await mgr.callTool(
        input.serverName as string,
        input.toolName as string,
        (input.args as Record<string, unknown>) ?? {},
        context.abortSignal,
      );
      return { content: [{ type: "text", text: result.content }], isError: result.isError };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};

export const listMcpResourcesTool: ToolDefinition = {
  name: "ListMcpResources",
  description: "List resources from connected MCP servers.",
  inputSchema: {
    type: "object",
    properties: { serverName: { type: "string", description: "Optional server filter" } },
    required: [],
  },
  async execute(input, context) {
    const mgr = mcpManagerFrom(context);
    if (!mgr) return { content: [{ type: "text", text: "MCP manager not available" }], isError: true };
    const resources = mgr.getConnectedResources();
    const filtered = input.serverName ? resources.filter((resource) => resource.serverName === input.serverName) : resources;
    if (!filtered.length) return { content: [{ type: "text", text: "(no resources)" }] };
    const text = filtered.map((resource) => `${resource.serverName}: ${resource.name} (${resource.uri})`).join("\n");
    return { content: [{ type: "text", text }] };
  },
};

export const readMcpResourceTool: ToolDefinition = {
  name: "ReadMcpResource",
  description: "Read a resource from a connected MCP server.",
  inputSchema: {
    type: "object",
    properties: {
      serverName: { type: "string", description: "MCP server name" },
      uri: { type: "string", description: "Resource URI" },
    },
    required: ["serverName", "uri"],
  },
  async execute(input, context) {
    const mgr = mcpManagerFrom(context);
    if (!mgr) return { content: [{ type: "text", text: "MCP manager not available" }], isError: true };
    try {
      const content = await mgr.readResource(
        input.serverName as string,
        input.uri as string,
        context.abortSignal,
      );
      return { content: [{ type: "text", text: content }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};

export const mcpAuthTool: ToolDefinition = {
  name: "McpAuth",
  description:
    "Configure auth for an MCP server and reconnect active sessions when possible.",
  inputSchema: {
    type: "object",
    properties: {
      serverName: { type: "string", description: "Configured MCP server name" },
      mode: {
        type: "string",
        description: "Auth mode: bearer, header, or env",
      },
      value: { type: "string", description: "Secret value to persist" },
      key: {
        type: "string",
        description: "Header or env key override",
      },
    },
    required: ["serverName", "mode", "value"],
  },
  async execute(input, context) {
    const serverName = input.serverName as string;
    const mode = input.mode as string;
    const value = input.value as string;
    const key = input.key as string | undefined;

    if (!["bearer", "header", "env"].includes(mode)) {
      return {
        content: [
          { type: "text", text: `Invalid auth mode: ${mode}. Use bearer, header, or env.` },
        ],
        isError: true,
      };
    }

    if (!serverName.trim()) {
      return {
        content: [{ type: "text", text: "MCP server name is required." }],
        isError: true,
      };
    }

    if (!value.trim()) {
      return {
        content: [{ type: "text", text: "MCP auth value is required." }],
        isError: true,
      };
    }

    const mcpAuth = context.mcpAuth;
    if (!mcpAuth) {
      return {
        content: [
          {
            type: "text",
            text: "MCP auth is not available in this host. No auth was saved and no MCP server was reconnected.",
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await mcpAuth.configure({
        serverName,
        mode: mode as "bearer" | "header" | "env",
        value,
        ...(key ? { key } : {}),
      });
      return { content: [{ type: "text", text: result.message }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
};
