import { assertValidMcpServerConfig } from "@vykor/host-config";
import { type ToolDefinition, type ToolResult } from "@vykor/core";
import { summarizeMcpEndpoint } from "@vykor/mcp";
import { PermissionChecker } from "@vykor/permissions";
import { askInstallConfirmation } from "./ask-install-confirmation.js";
import {
  McpConfigApplicationError,
  type McpConfigApplicationService,
} from "./mcp-config-application-service.js";

const reply = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/** Ordinary permission-checked daemon tool, not a shell installer or a global config editor. */
export function createMcpConfigureTool(
  service: Pick<McpConfigApplicationService, "list" | "add">,
  ownerSessionId: string,
): ToolDefinition {
  return {
    name: "McpConfigure",
    description:
      "Vykor supports MCP. List global MCP server summaries or add one stdio/http/sse server and attempt active-session connection updates. Use this tool when asked to install/configure MCP in Vykor, not Config or hand-editing settings.json. Existing names are never overwritten. It does not install Node/Python/uv or complete OAuth login. Added tools become available in a subsequent turn, not the current frozen run.",
    execution: {
      domain: "control_plane",
      supportedEnvironments: ["local", "wsl"],
      network: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add"] },
        name: {
          type: "string",
          description: "Unique global service name, for add",
        },
        config: {
          type: "object",
          description:
            "One Vykor MCP server config, NOT an mcpServers wrapper. Use the provider's documented command/args or URL; do not invent package names.",
          properties: {
            type: { type: "string", enum: ["stdio", "http", "sse"] },
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            env: { type: "object", additionalProperties: { type: "string" } },
            cwd: { type: "string" },
            url: { type: "string" },
            headers: {
              type: "object",
              additionalProperties: { type: "string" },
            },
            oauth: {
              type: "object",
              properties: {
                scopes: { type: "array", items: { type: "string" } },
                clientId: { type: "string" },
                callbackPort: { type: "integer" },
              },
              additionalProperties: false,
            },
          },
          required: ["type"],
          additionalProperties: false,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input, context) {
      // Children inherit tool definitions, but not authority to mutate host-global configuration.
      if (
        context.sessionId !== ownerSessionId ||
        context.capabilityView?.pluginId ||
        context.agent?.capabilityView?.pluginId
      ) {
        return reply(
          "全局 MCP 配置仅能由主会话管理，请交由用户所在主会话处理。",
          true,
        );
      }
      if (input.action !== "list" && input.action !== "add")
        return reply("action 只能是 list 或 add。", true);
      try {
        if (input.action === "list")
          return reply(JSON.stringify(await service.list()));
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name) return reply("请填写 MCP 服务名称。", true);
        try {
          assertValidMcpServerConfig(name, input.config);
        } catch {
          return reply(
            "MCP 配置无效：请提供一个服务的 type 与 command/args 或 url，不能传入整个 mcpServers 集合。",
            true,
          );
        }
        const config = input.config;
        if (config.enabled === false)
          return reply("本工具只添加启用的服务，不支持 enabled=false。", true);
        if (config.type === "stdio") {
          // A dedicated setup tool must not turn a forbidden Shell command into an allowed process.
          const policy = new PermissionChecker({
            ...context.settings?.permission,
            mode: "default",
            cwd: context.cwd,
          });
          const decision = await policy.checkTool("Shell", {
            command: [config.command, ...(config.args ?? [])].join(" "),
          });
          if (decision.action === "deny")
            return reply(
              "当前执行策略禁止此本地启动命令，未保存或启动 MCP。不能借 MCP 配置绕过 Shell 禁令。",
              true,
            );
        }
        if (
          (await service.list()).servers.some((server) => server.name === name)
        ) {
          return reply(
            `MCP 服务已存在：${name}。不会覆盖，请在桌面 MCP 管理页面编辑已有配置。`,
            true,
          );
        }
        if (!context.askUserPrompt)
          return reply(
            "当前没有可用的确认入口，未保存或启动服务。请在桌面 MCP 管理页面添加。",
            true,
          );
        const target =
          config.type === "stdio"
            ? `启动命令：${JSON.stringify([config.command, ...(config.args ?? [])])}\n环境变量名：${Object.keys(config.env ?? {}).join("、") || "无"}`
            : `服务地址：${summarizeMcpEndpoint(config.url)}\n请求头名称：${Object.keys(config.headers ?? {}).join("、") || "无"}`;
        const confirmed = await askInstallConfirmation(
          context.askUserPrompt,
          [
            `确认添加全局 MCP 服务 ${JSON.stringify(name)}？这会影响其他会话。`,
            target,
            config.type === "stdio"
              ? "连接时会启动第三方进程，npx/uvx 可能下载并运行软件。"
              : "连接时会向该第三方服务发送请求。",
            "本工具不安装系统依赖，也不代替你完成 OAuth 授权。回复“确认添加”才会继续。",
          ].join("\n"),
          "确认添加",
        );
        if (!confirmed) return reply("已取消添加，未保存或启动 MCP 服务。");
        if (context.abortSignal?.aborted || context.runAbortSignal?.aborted)
          return reply("操作已取消，未保存 MCP 配置。", true);
        const result = await service.add({ name, config });
        const sync = result.runtimeSync;
        const status =
          sync.failures.length || sync.status === "error"
            ? "配置已保存，但活动会话连接更新失败。请在 MCP 管理页面检查本地启动依赖、网络或认证；无需重复添加。"
            : sync.affectedRuntimes > 0 && sync.status === "connected"
              ? "配置已保存，活动会话已完成连接更新；项目或插件配置可能覆盖全局配置。"
              : "配置已保存，连接尚未验证。请在下一轮对话或新会话中检查服务是否可用。";
        return reply(
          `${status}\n新增工具不会加入当前运行中的工具集合，请下一轮再使用。${config.type !== "stdio" && config.oauth ? " 如需 OAuth，请在 MCP 管理页面完成登录授权。" : ""}`,
        );
      } catch (error) {
        // Arbitrary SDK/transport errors may include URLs, headers or credentials.
        return reply(
          error instanceof McpConfigApplicationError
            ? error.message
            : "MCP 配置操作失败。请在 MCP 管理页面检查状态；重试添加前先用 list 确认是否已保存。",
          true,
        );
      }
    },
  };
}
