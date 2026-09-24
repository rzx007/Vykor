import type {
  McpAuthConfigureInput,
  McpAuthHost,
  McpServerConfig,
  Settings,
  IToolRegistry,
} from "@vykor/core";
import { updateSettings } from "@vykor/core";
import { McpClientManager, resolveTransportKind } from "@vykor/mcp";

export interface CreateMcpAuthHostOptions {
  settings: Settings;
  mcpManager: McpClientManager;
  toolRegistry: IToolRegistry;
  persistSettings?: (settings: Settings) => Promise<void>;
}

export function createMcpAuthHost(options: CreateMcpAuthHostOptions): McpAuthHost {
  const persistSettings = options.persistSettings;
  return {
    async configure(input) {
      const existing = options.settings.mcpServers?.[input.serverName]
        ?? options.mcpManager.getConnection(input.serverName)?.config;
      if (!existing) {
        throw new Error(`MCP server is not configured: ${input.serverName}`);
      }

      const nextConfig = applyMcpAuthConfig(input.serverName, existing, input);
      const nextSettings: Settings = {
        ...options.settings,
        mcpServers: {
          ...(options.settings.mcpServers ?? {}),
          [input.serverName]: nextConfig,
        },
      };

      if (persistSettings) {
        await persistSettings(nextSettings);
        Object.assign(options.settings, nextSettings);
      } else {
        const persisted = await updateSettings((latest) => ({
          ...latest,
          mcpServers: {
            ...(latest.mcpServers ?? {}),
            [input.serverName]: nextConfig,
          },
        }));
        Object.assign(options.settings, persisted);
      }

      let prepared;
      try {
        prepared = await options.mcpManager.prepareConnection(input.serverName, nextConfig);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Saved MCP auth for ${input.serverName}, but reconnect failed: ${detail}`);
      }

      const activation = options.mcpManager.activatePreparedConnection(prepared, (tools) => {
        options.toolRegistry.replaceBySource(
          { kind: "mcp", id: input.serverName },
          tools,
        );
      });

      if (!activation.committed) {
        await activation.discardPrepared().catch(() => undefined);
        throw activation.error;
      }

      let cleanupWarning = "";
      try {
        await activation.closePrevious();
      } catch {
        cleanupWarning = " The previous connection could not be closed.";
      }

      return {
        message: `Saved MCP auth for ${input.serverName} and reconnected it (mode=${input.mode}).${cleanupWarning}`,
      };
    },
  };
}

export function applyMcpAuthConfig(
  serverName: string,
  config: McpServerConfig,
  input: McpAuthConfigureInput,
): McpServerConfig {
  const kind = resolveTransportKind(config);
  if (typeof kind !== "string") {
    throw new Error(`Cannot configure MCP auth for ${serverName}: ${kind.error}`);
  }

  switch (input.mode) {
    case "bearer":
      if (config.type !== "http" && config.type !== "sse") {
        throw new Error(`MCP auth mode bearer only works for HTTP/SSE servers. Use env for stdio server ${serverName}.`);
      }
      return {
        ...config,
        headers: {
          ...(config.headers ?? {}),
          Authorization: `Bearer ${input.value}`,
        },
      };
    case "header":
      if (config.type !== "http" && config.type !== "sse") {
        throw new Error(`MCP auth mode header only works for HTTP/SSE servers. Use env for stdio server ${serverName}.`);
      }
      if (!input.key?.trim()) {
        throw new Error("MCP auth mode header requires a header key.");
      }
      return {
        ...config,
        headers: {
          ...(config.headers ?? {}),
          [input.key]: input.value,
        },
      };
    case "env": {
      if (config.type !== "stdio") {
        throw new Error(`MCP auth mode env only works for stdio servers. Use bearer or header for ${kind} server ${serverName}.`);
      }
      const envKey = input.key?.trim() || defaultMcpEnvKey(serverName);
      return {
        ...config,
        env: {
          ...(config.env ?? {}),
          [envKey]: input.value,
        },
      };
    }
  }
}

export function defaultMcpEnvKey(serverName: string): string {
  return `${serverName.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`;
}
