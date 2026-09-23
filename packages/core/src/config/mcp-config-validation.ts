import type { McpServerConfig } from "../index";

/** Raised when an MCP server config is structurally invalid before saving. */
export class McpServerConfigError extends Error {
  readonly code = "invalid_mcp_server_config";

  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "McpServerConfigError";
  }
}

const MCP_SERVER_FIELDS = new Set([
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "oauth",
  "enabled",
]);

const OAUTH_FIELDS = new Set(["scopes", "clientId", "callbackPort"]);

/**
 * Validate one real `McpServerConfig` entry (the shape stored in
 * `settings.mcpServers`) before it is written. This is stricter than the
 * load-time field check: it enforces the transport-specific required fields and
 * the `oauth` / `headers` shapes, so a demo-only editor cannot persist a config
 * the Runtime would reject.
 */
export function assertValidMcpServerConfig(name: string, config: unknown): asserts config is McpServerConfig {
  const field = (suffix: string): string =>
    suffix ? `settings.mcpServers.${name}.${suffix}` : `settings.mcpServers.${name}`;

  if (!isRecord(config)) {
    throw new McpServerConfigError(field(""), `MCP 服务 ${name} 的配置必须是对象。`);
  }
  for (const key of Object.keys(config)) {
    if (!MCP_SERVER_FIELDS.has(key)) {
      throw new McpServerConfigError(field(key), `MCP 服务 ${name} 包含不支持的字段：${key}。`);
    }
  }
  if (config.type !== "stdio" && config.type !== "http" && config.type !== "sse") {
    throw new McpServerConfigError(
      field("type"),
      `MCP 服务 ${name} 的传输类型必须是 stdio、http 或 sse。`,
    );
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new McpServerConfigError(field("enabled"), `MCP 服务 ${name} 的启用状态必须是布尔值。`);
  }

  if (config.type === "stdio") {
    if (typeof config.command !== "string" || !config.command.trim()) {
      throw new McpServerConfigError(field("command"), `MCP 服务 ${name} 是 stdio 类型，command 不能为空。`);
    }
    assertAbsent(config.url, field("url"), name, "url");
    assertAbsent(config.headers, field("headers"), name, "headers");
    assertAbsent(config.oauth, field("oauth"), name, "oauth");
    assertStringArray(config.args, field("args"), name, "args");
    assertStringRecord(config.env, field("env"), name, "env");
    if (config.cwd !== undefined && typeof config.cwd !== "string") {
      throw new McpServerConfigError(field("cwd"), `MCP 服务 ${name} 的 cwd 必须是字符串。`);
    }
    return;
  }

  if (typeof config.url !== "string" || !isHttpUrl(config.url)) {
    throw new McpServerConfigError(field("url"), `MCP 服务 ${name} 的 url 必须是有效的 HTTP 或 HTTPS 地址。`);
  }
  assertAbsent(config.command, field("command"), name, "command");
  assertAbsent(config.args, field("args"), name, "args");
  assertAbsent(config.env, field("env"), name, "env");
  assertAbsent(config.cwd, field("cwd"), name, "cwd");
  assertStringRecord(config.headers, field("headers"), name, "headers");
  assertOAuthSettings(config.oauth, field("oauth"), name);
}

function assertAbsent(value: unknown, field: string, name: string, key: string): void {
  if (value !== undefined) {
    throw new McpServerConfigError(field, `MCP 服务 ${name} 的 ${key} 字段不适用于当前传输类型。`);
  }
}

function assertStringArray(value: unknown, field: string, name: string, key: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new McpServerConfigError(field, `MCP 服务 ${name} 的 ${key} 必须是字符串数组。`);
  }
}

function assertStringRecord(value: unknown, field: string, name: string, key: string): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new McpServerConfigError(field, `MCP 服务 ${name} 的 ${key} 必须是字符串键值对。`);
  }
}

function assertOAuthSettings(value: unknown, field: string, name: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new McpServerConfigError(field, `MCP 服务 ${name} 的 oauth 必须是对象。`);
  }
  for (const key of Object.keys(value)) {
    if (!OAUTH_FIELDS.has(key)) {
      throw new McpServerConfigError(`${field}.${key}`, `MCP 服务 ${name} 的 oauth 包含不支持的字段：${key}。`);
    }
  }
  assertStringArray(value.scopes, `${field}.scopes`, name, "oauth.scopes");
  if (value.clientId !== undefined && typeof value.clientId !== "string") {
    throw new McpServerConfigError(`${field}.clientId`, `MCP 服务 ${name} 的 oauth.clientId 必须是字符串。`);
  }
  if (value.callbackPort !== undefined && typeof value.callbackPort !== "number") {
    throw new McpServerConfigError(`${field}.callbackPort`, `MCP 服务 ${name} 的 oauth.callbackPort 必须是数字。`);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
