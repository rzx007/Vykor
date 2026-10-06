import type {
  McpAuthConfigureInput,
  McpAuthHost,
  McpServerConfig,
  Settings,
  IToolRegistry,
} from "@vykor/core";
import { loadMcpServerConfigSnapshot, saveMcpServerConfig, ToolRegistry } from "@vykor/core";
import { McpClientManager, resolveTransportKind, type McpConnectionActivation } from "@vykor/mcp";

export interface CreateMcpAuthHostOptions {
  settings: Settings;
  mcpManager: McpClientManager;
  toolRegistry: IToolRegistry;
  cwd?: string;
  persistSettings?: (settings: Settings) => Promise<void>;
}

export function createMcpAuthHost(options: CreateMcpAuthHostOptions): McpAuthHost {
  const persistSettings = options.persistSettings;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    async configure(input) {
      const run = queue.then(async () => {
        const sourceSnapshot = persistSettings ? undefined : await loadMcpServerConfigSnapshot(input.serverName, { projectRoot: options.cwd });
        const existing = sourceSnapshot?.config ?? options.settings.mcpServers?.[input.serverName]
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

        let prepared;
        try {
          prepared = await options.mcpManager.prepareConnection(input.serverName, nextConfig);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`MCP auth reconnect failed: ${detail}. Auth was not saved for ${input.serverName}.`);
        }

        let activation: McpConnectionActivation | undefined;
        const commit = () => {
          activation = options.mcpManager.activatePreparedConnection(prepared, (tools) => {
            options.toolRegistry.replaceBySource({ kind: "mcp", id: input.serverName }, tools);
          });
          if (!activation.committed) throw activation.error;
        };

        try {
          // Check replacement conflicts before persisting or publishing any live state.
          const validation = new ToolRegistry();
          for (const tool of options.toolRegistry.getAll()) {
            validation.register(tool, options.toolRegistry.inspect(tool.name)?.source);
          }
          validation.replaceBySource({ kind: "mcp", id: input.serverName }, prepared.tools);
          if (persistSettings) {
            await persistSettings(nextSettings);
            try { commit(); }
            catch (error) {
              try { await persistSettings(options.settings); }
              catch (rollbackError) { throw new AggregateError([error, rollbackError], "MCP activation failed and its saved config could not be restored."); }
              throw error;
            }
          } else {
            await saveMcpServerConfig(input.serverName, nextConfig, { projectRoot: options.cwd, expected: sourceSnapshot, commit });
          }
        } catch (error) {
          if (activation && !activation.committed) await activation.discardPrepared().catch(() => undefined);
          else await prepared.client.close().catch(() => undefined);
          throw error;
        }
        options.settings.mcpServers = { ...options.settings.mcpServers, [input.serverName]: nextConfig };

        let cleanupWarning = "";
        try {
          if (activation?.committed) await activation.closePrevious();
        } catch {
          cleanupWarning = " The previous connection could not be closed.";
        }

        return {
          message: `Saved MCP auth for ${input.serverName} and reconnected it (mode=${input.mode}).${cleanupWarning}`,
        };
      });
      queue = run.catch(() => undefined);
      return run;
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
