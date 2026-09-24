import type {
  PermissionMode,
  PermissionRule,
  PermissionDecision,
  IPermissionChecker,
  PermissionSettings,
  PathRuleConfig,
} from "@vykor/core";
import { canonicalToolName, canonicalToolNames } from "@vykor/core";
import { isAbsolute, posix, relative, resolve } from "node:path";

export type {
  PermissionMode,
  PermissionRule,
  PermissionDecision,
  PermissionSettings,
  PathRuleConfig,
};

/**
 * 只读工具集：swarm worker（teammate）对这些工具自动放行，无需父进程开 full_auto。
 * 包含文件、Web、已安排任务和统一 Jobs 观察工具。JobSend/JobCancel 会改变后台工作，
 * 不属于只读集合。
 * 不含 Write/Edit/Shell 等写/执行类工具。
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "JobList",
  "JobRead",
  "JobWait",
  "ScheduleList",
  "Lsp",
]);

export const LOCAL_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "Lsp",
]);

export interface PermissionCheckOptions {
  mode: PermissionMode;
  rules?: PermissionRule[];
  allowedTools?: string[];
  deniedTools?: string[];
  pathRules?: PathRuleConfig[];
  deniedCommands?: string[];
  autoApproveTools?: string[];
  /** Tool names whose current implementation must not inherit name-based trust. */
  untrustedToolNames?: string[];
  /** When provided, only these local read-only names retain implicit trust. */
  trustedLocalReadOnlyToolNames?: string[];
  cwd?: string;
  pathStyle?: "windows" | "posix";
}

export class PermissionChecker implements IPermissionChecker {
  private mode: PermissionMode;
  private rules: PermissionRule[];
  private allowedTools: Set<string>;
  private deniedTools: Set<string>;
  private pathRules: PathRuleConfig[];
  private deniedCommands: string[];
  private autoApproveTools: Set<string>;
  private untrustedToolNames: Set<string>;
  private trustedLocalReadOnlyToolNames: Set<string> | undefined;
  private cwd: string | undefined;
  private pathStyle: "windows" | "posix";

  constructor(options: PermissionCheckOptions) {
    this.mode = options.mode;
    this.rules = (options.rules ?? []).map((rule) => ({
      ...rule,
      ...(rule.tool ? { tool: canonicalToolName(rule.tool) } : {}),
    }));
    this.allowedTools = new Set(canonicalToolNames(options.allowedTools ?? []));
    this.deniedTools = new Set(canonicalToolNames(options.deniedTools ?? []));
    this.pathStyle = options.pathStyle ?? (process.platform === "win32" ? "windows" : "posix");
    this.pathRules = options.pathRules ?? [];
    if (
      this.pathStyle === "posix" &&
      this.pathRules.some((rule) => /^[a-zA-Z]:[\\/]/.test(rule.pattern))
    ) {
      throw new Error("invalid_execution_path_rule: Windows absolute paths are not valid in a POSIX environment");
    }
    this.deniedCommands = options.deniedCommands ?? [];
    this.autoApproveTools = new Set(canonicalToolNames(options.autoApproveTools ?? []));
    this.untrustedToolNames = new Set(options.untrustedToolNames ?? []);
    this.trustedLocalReadOnlyToolNames = options.trustedLocalReadOnlyToolNames
      ? new Set(options.trustedLocalReadOnlyToolNames)
      : undefined;
    const cwd = options.cwd;
    this.cwd = typeof cwd === "string" && cwd
      ? this.pathStyle === "posix" ? posix.resolve(cwd) : resolve(cwd)
      : undefined;
  }

  async checkTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    toolName = canonicalToolName(toolName);
    if (this.mode === "full_auto") {
      return { action: "allow", reason: "Full auto mode" };
    }

    if (this.deniedTools.size > 0 && this.deniedTools.has(toolName)) {
      return { action: "deny", reason: `Tool '${toolName}' is in denied list` };
    }

    // 全部否决类检查先行（deniedTools/deniedCommands/pathRules 的 deny），
    // 任何放行机制（autoApprove/allowedTools/pathRules allow）都不得短路它们
    // ——否则 autoApprove("Shell") 会让 rm -rf 黑名单失效、autoApprove("Read")
    // 会绕过 .env 类路径保护。
    if (this.deniedCommands.length > 0 && typeof input.command === "string") {
      for (const pattern of this.deniedCommands) {
        if (matchPattern(pattern, input.command)) {
          return {
            action: "deny",
            reason: `Command matches denied pattern: ${pattern}`,
          };
        }
      }
    }

    // pathRules 首条命中即定结果；deny 立即否决，allow 暂存（仍需先过
    // allowedTools 白名单收窄，语义与原实现一致）。
    let pathAllowReason: string | null = null;
    const pathInput = readToolPathInput(input);
    if (this.pathRules.length > 0) {
      const path = pathInput ?? "";
      if (path) {
        for (const rule of this.pathRules) {
          if (matchPattern(rule.pattern, path)) {
            if (!rule.allow) {
              return {
                action: "deny",
                reason: `Path matched deny rule: ${rule.pattern}`,
              };
            }
            pathAllowReason = `Path matched allow rule: ${rule.pattern}`;
            break;
          }
        }
      }
    }

    if (this.autoApproveTools.size > 0 && this.autoApproveTools.has(toolName)) {
      return { action: "allow", reason: `Tool '${toolName}' is auto-approved` };
    }

    if (this.allowedTools.size > 0 && !this.allowedTools.has(toolName)) {
      return {
        action: "deny",
        reason: `Tool '${toolName}' is not in allowed list`,
      };
    }

    if (pathAllowReason !== null) {
      return { action: "allow", reason: pathAllowReason };
    }

    for (const rule of this.rules) {
      if (rule.tool && rule.tool !== toolName) continue;
      if (
        rule.pathPattern &&
        typeof input.path === "string" &&
        !matchPattern(rule.pathPattern, input.path)
      ) {
        continue;
      }
      if (
        rule.commandPattern &&
        typeof input.command === "string" &&
        !matchPattern(rule.commandPattern, input.command)
      ) {
        continue;
      }
      return {
        action: rule.action,
        reason: `Matched rule for tool: ${rule.tool ?? "*"}`,
      };
    }

    if (
      !this.untrustedToolNames.has(toolName) &&
      (!this.trustedLocalReadOnlyToolNames ||
        this.trustedLocalReadOnlyToolNames.has(toolName)) &&
      isLocalReadOnlyToolAllowed(toolName, input, this.cwd, this.pathStyle)
    ) {
      return {
        action: "allow",
        reason: `Local read-only tool '${toolName}' is within cwd`,
      };
    }

    if (this.mode === "plan") {
      return { action: "ask", reason: "Plan mode requires confirmation" };
    }

    return { action: "ask", reason: "No matching rule found" };
  }

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  removeRule(index: number): void {
    this.rules.splice(index, 1);
  }

  getRules(): readonly PermissionRule[] {
    return this.rules;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }
}

function readToolPathInput(input: Record<string, unknown>): string | undefined {
  if (typeof input.path === "string") return input.path;
  if (typeof input.filePath === "string") return input.filePath;
  if (typeof input.file_path === "string") return input.file_path;
  return undefined;
}

function isLocalReadOnlyToolAllowed(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
  pathStyle: "windows" | "posix",
): boolean {
  if (!cwd || !LOCAL_READ_ONLY_TOOLS.has(toolName)) return false;
  const path = readToolPathInput(input);
  if (!path)
    return toolName === "Glob" || toolName === "Grep" || toolName === "Lsp";
  return pathStyle === "posix"
    ? isWithinPosixCwd(posix.resolve(cwd, path), cwd)
    : isWithinCwd(resolve(cwd, path), cwd);
}

function isWithinPosixCwd(target: string, cwd: string): boolean {
  const rel = posix.relative(cwd, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !posix.isAbsolute(rel));
}

function isWithinCwd(target: string, cwd: string): boolean {
  const rel = relative(cwd, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function matchPattern(pattern: string, value: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  return regex.test(value);
}
