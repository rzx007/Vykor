import type { Settings, McpServerConfig } from "@vykor/core";
import { findByName } from "@vykor/api";
import { checkApiKey } from "./doctor";

/**
 * dry-run 的 readiness 判定（纯函数，便于单测）。
 *
 * - 无 key → "blocked"（无法调用模型）。
 * - 有 key 但无 model → "warning"（能连但没指定模型）。
 * - 有 key + 有 model → "ready"。
 *
 * notes 给出人类可读的说明，前端可逐条打印。
 */
export type Readiness = {
  verdict: "ready" | "warning" | "blocked";
  notes: string[];
};

export function computeReadiness(input: { hasKey: boolean; hasModel: boolean }): Readiness {
  const notes: string[] = [];
  if (!input.hasKey) {
    notes.push("No API key resolved — model calls will fail. Run 'vk setup' or 'vk provider add'.");
    return { verdict: "blocked", notes };
  }
  if (!input.hasModel) {
    notes.push("No model set — a model is required before running.");
    return { verdict: "warning", notes };
  }
  notes.push("API key and model are configured.");
  return { verdict: "ready", notes };
}

/**
 * 返回当前严格 MCP 配置声明的 transport。
 */
export function inferMcpTransport(cfg: McpServerConfig): string {
  return cfg.type;
}

/**
 * 按黑白名单过滤工具名，返回最终生效的工具数（纯函数）。
 *
 * 语义对齐 agent-runtime composition：白名单非空时只保留白名单内的工具，
 * 然后再剔除黑名单内的工具。settings 与 CLI override 的名单合并由调用方完成。
 */
export function countEffectiveTools(
  allToolNames: string[],
  allowed: string[],
  denied: string[],
): number {
  const allowSet = new Set(allowed);
  const denySet = new Set(denied);
  let names = allToolNames;
  if (allowSet.size > 0) {
    names = names.filter((n) => allowSet.has(n));
  }
  if (denySet.size > 0) {
    names = names.filter((n) => !denySet.has(n));
  }
  return names.length;
}

export interface DryRunOptions {
  model?: string;
  provider?: string;
  permissionMode?: string;
  baseUrl?: string;
  apiFormat?: string;
  allowedTools?: string;
  disallowedTools?: string;
}

export interface McpServerSummary {
  name: string;
  transport: string;
}

export interface DryRunReport {
  model: string;
  provider: string;
  keySource: string;
  baseURL: string;
  apiFormat: string;
  permissionMode: string;
  toolCount: number;
  mcpServers: McpServerSummary[];
  skillCount: number;
  pluginsEnabled: boolean;
  readiness: Readiness;
}

/**
 * 组装 dry-run 报告数据（纯函数，不打印、不创建 client、不调模型）。
 *
 * 把所有"副作用收集"（key 检查结果、工具名列表、skills 数）作为入参传入，
 * 让这层只负责数据映射与 readiness 判定，便于单测。
 */
export function buildDryRunReport(input: {
  settings: Settings;
  options: DryRunOptions;
  keyCheck: { ok: boolean; source: string };
  allToolNames: string[];
  skillCount: number;
}): DryRunReport {
  const { settings, options, keyCheck } = input;

  const model = options.model ?? settings.model;
  const realProvider = options.provider ?? settings.provider;
  const provider = realProvider ?? "(auto-detect)";
  // 显示**有效解析后**的 baseURL：未显式设置时取该 provider 的注册默认
  // （与 resolveApiClient 的 `baseURL ?? spec.defaultBaseURL` 一致），避免只显示占位串。
  const baseURL =
    options.baseUrl ??
    settings.baseUrl ??
    (realProvider ? findByName(realProvider)?.defaultBaseURL : undefined) ??
    "(auto-detect)";
  const apiFormat = options.apiFormat ?? settings.apiFormat;
  const permissionMode = options.permissionMode ?? settings.permission.mode;

  const allowed = [
    ...(settings.permission.allowedTools ?? []),
    ...(options.allowedTools ? options.allowedTools.split(",") : []),
  ];
  const denied = [
    ...(settings.permission.deniedTools ?? []),
    ...(options.disallowedTools ? options.disallowedTools.split(",") : []),
  ];
  const toolCount = countEffectiveTools(input.allToolNames, allowed, denied);

  const mcpServers: McpServerSummary[] = Object.entries(settings.mcpServers ?? {}).map(
    ([name, cfg]) => ({ name, transport: inferMcpTransport(cfg) }),
  );

  const readiness = computeReadiness({ hasKey: keyCheck.ok, hasModel: !!model });

  return {
    model,
    provider,
    keySource: keyCheck.source,
    baseURL,
    apiFormat,
    permissionMode,
    toolCount,
    mcpServers,
    skillCount: input.skillCount,
    pluginsEnabled: settings.plugins?.enabled ?? true,
    readiness,
  };
}

/**
 * `oh --dry-run`：预览解析后的运行时配置 + readiness，**不创建 API client、不调模型**。
 *
 * 在 mainAction 的 tui/print 早分支之前调用。
 */
export async function runDryRun(settings: Settings, options: DryRunOptions): Promise<void> {
  const chalk = (await import("chalk")).default;
  const { createDefaultToolRegistry } = await import("@vykor/tools");
  const { SkillRegistry } = await import("@vykor/skills");
  const { loadSkillsThreeSources } = await import("./commands/main");

  const keyCheck = await checkApiKey(settings);

  const toolRegistry = createDefaultToolRegistry();
  const allToolNames = toolRegistry.getAll().map((t) => t.name);

  const skillRegistry = new SkillRegistry();
  await loadSkillsThreeSources(skillRegistry, process.cwd(), settings);
  const skillCount = skillRegistry.getAll().length;

  const report = buildDryRunReport({
    settings,
    options,
    keyCheck,
    allToolNames,
    skillCount,
  });

  const label = (s: string) => chalk.gray(s.padEnd(16));
  console.log(chalk.cyan.bold("Dry run — resolved runtime configuration"));
  console.log(chalk.gray("(no API client created, no model call made)"));
  console.log();
  console.log(`${label("model")}${chalk.white(report.model)}`);
  console.log(`${label("provider")}${chalk.white(report.provider)}`);
  console.log(`${label("key source")}${chalk.white(report.keySource)}`);
  console.log(`${label("baseURL")}${chalk.white(report.baseURL)}`);
  console.log(`${label("apiFormat")}${chalk.white(report.apiFormat)}`);
  console.log(`${label("permission")}${chalk.white(report.permissionMode)}`);
  console.log(`${label("tools")}${chalk.white(String(report.toolCount))}`);
  console.log(`${label("skills")}${chalk.white(String(report.skillCount))}`);
  console.log(`${label("plugins")}${chalk.white(report.pluginsEnabled ? "enabled" : "disabled")}`);

  if (report.mcpServers.length === 0) {
    console.log(`${label("mcp servers")}${chalk.gray("(none)")}`);
  } else {
    console.log(`${label("mcp servers")}${chalk.white(String(report.mcpServers.length))}`);
    for (const s of report.mcpServers) {
      console.log(`  ${chalk.white(s.name)} ${chalk.gray(`(${s.transport})`)}`);
    }
  }

  console.log();
  const verdictColor =
    report.readiness.verdict === "ready"
      ? chalk.green
      : report.readiness.verdict === "warning"
        ? chalk.yellow
        : chalk.red;
  console.log(`${label("readiness")}${verdictColor.bold(report.readiness.verdict)}`);
  for (const note of report.readiness.notes) {
    console.log(`  ${chalk.gray("-")} ${verdictColor(note)}`);
  }
}
