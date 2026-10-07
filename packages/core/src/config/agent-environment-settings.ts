import type { AgentEnvironmentSettings } from "../types/settings.js";

export function parseAgentEnvironmentSettings(value: unknown): AgentEnvironmentSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("运行环境必须是对象。");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => !["kind", "distribution", "shell", "env", "secretEnv"].includes(key))) throw new Error("运行环境包含未知字段。");
  if (config.kind !== "native" && config.kind !== "wsl") throw new Error("请选择本机或 WSL。");
  if (config.distribution !== undefined && (typeof config.distribution !== "string" || !config.distribution.trim() || /[\x00\r\n]/.test(config.distribution))) throw new Error("WSL 发行版名称无效。");
  if (config.shell !== undefined) {
    const shell = config.shell as AgentEnvironmentSettings["shell"];
    if (!shell || typeof shell !== "object" || Array.isArray(shell) || typeof shell.executable !== "string" || !shell.executable.trim() || !Array.isArray(shell.args) || shell.args.some(arg => typeof arg !== "string" || arg.includes("\0")) || Object.keys(shell).some(key => key !== "executable" && key !== "args")) throw new Error("命令 Shell 必须包含可执行文件和分开的参数列表。");
  }
  if (config.env !== undefined && (!config.env || typeof config.env !== "object" || Array.isArray(config.env) || Object.entries(config.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")))) throw new Error("环境变量名称或值无效。");
  if (config.secretEnv !== undefined && (!Array.isArray(config.secretEnv) || config.secretEnv.some(key => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))) throw new Error("机密环境变量名称无效。");
  return structuredClone(config) as unknown as AgentEnvironmentSettings;
}
