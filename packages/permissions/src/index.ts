import type {
  PermissionMode,
  PermissionRule,
  PermissionDecision,
  IPermissionChecker,
  PermissionSettings,
  PathRuleConfig,
} from "@vykor/core";
import { canonicalToolName, canonicalToolNames } from "@vykor/core";
import { posix, win32 } from "node:path";

export type {
  PermissionMode,
  PermissionRule,
  PermissionDecision,
  PermissionSettings,
  PathRuleConfig,
};
export { parsePermissionSettings } from "@vykor/core";

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

const TOOL_PATH_NAMES = ["path", "filePath", "file_path"] as const;

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
      ? this.pathStyle === "posix" ? posix.resolve(cwd) : win32.resolve(cwd)
      : undefined;
  }

  async checkTool(
    toolName: string,
    input: Record<string, unknown>,
    inputSchema?: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    toolName = canonicalToolName(toolName);
    const pathNames = TOOL_PATH_NAMES.filter(name => Object.hasOwn(input, name));
    const composedSchema = ["anyOf", "oneOf", "allOf", "$ref"].some(key => key in (inputSchema ?? {}));
    const properties = inputSchema?.properties;
    // Only explicit root declarations are authoritative; do not infer schema branches.
    const declaredNames = properties && typeof properties === "object" && !Array.isArray(properties)
      ? pathNames.filter(name => Object.hasOwn(properties, name)) : [];
    const aliases = declaredNames.length > 0 ? pathNames.filter(name => !declaredNames.includes(name)) : pathNames;
    const candidates = declaredNames.length > 0 ? declaredNames : pathNames.slice(0, 1);
    if (!composedSchema && aliases.some(alias => !candidates.some(name => Object.is(input[alias], input[name])))) {
      return { action: "deny", reason: "Conflicting single-target path aliases" };
    }

    if (this.deniedTools.size > 0 && this.deniedTools.has(toolName)) {
      return { action: "deny", reason: `Tool '${toolName}' is in denied list` };
    }

    // Plan is a read-only ceiling, including against ordinary explicit allow rules.
    const modeControl = toolName === "EnterPlanMode" || toolName === "ExitPlanMode";
    if (this.mode === "plan" && (
      (!READ_ONLY_TOOLS.has(toolName) && !modeControl) ||
      this.untrustedToolNames.has(toolName) ||
      (this.trustedLocalReadOnlyToolNames && !this.trustedLocalReadOnlyToolNames.has(toolName))
    )) {
      return { action: "deny", reason: "Plan mode permits only trusted read-only tools and runtime mode control" };
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

    // Each path keeps its first matching rule. Any deny wins; a path-based allow
    // must cover every candidate before the existing tool whitelist is checked.
    let pathAllowReason: string | null = null;
    const pathInputs = readToolPathInputs(input);
    if (this.pathRules.length > 0) {
      const matches = pathInputs.map(path => this.pathRules.find(rule => matchPathPattern(rule.pattern, path, this.cwd, this.pathStyle)));
      const denied = matches.find(rule => rule && !rule.allow);
      if (denied) {
        return { action: "deny", reason: `Path matched deny rule: ${denied.pattern}` };
      }
      if (matches[0] && matches.every(rule => rule?.allow)) {
        pathAllowReason = `Path matched allow rule: ${matches[0].pattern}`;
      }
    }

    let matchedRule: PermissionDecision | undefined;
    for (const rule of this.rules) {
      if (rule.tool && rule.tool !== toolName) continue;
      const pathPattern = rule.pathPattern;
      if (pathPattern) {
        if (composedSchema || declaredNames.length > 1) {
          const matches = pathInputs.map(path => matchPathPattern(pathPattern, path, this.cwd, this.pathStyle));
          if (rule.action === "allow" ? !matches.every(Boolean) : !matches.some(Boolean)) continue;
        } else if (typeof input.path === "string" && !matchPathPattern(pathPattern, input.path, this.cwd, this.pathStyle)) {
          continue;
        }
      }
      if (
        rule.commandPattern &&
        typeof input.command === "string" &&
        !matchPattern(rule.commandPattern, input.command)
      ) {
        continue;
      }
      const decision: PermissionDecision = {
        action: rule.action,
        reason: `Matched rule for tool: ${rule.tool ?? "*"}`,
      };
      if (decision.action === "deny") return decision;
      matchedRule ??= decision;
    }

    if (this.mode !== "full_auto" && this.autoApproveTools.size > 0 && this.autoApproveTools.has(toolName)) {
      return { action: "allow", reason: `Tool '${toolName}' is auto-approved` };
    }
    if (this.allowedTools.size > 0 && !this.allowedTools.has(toolName)) {
      return { action: "deny", reason: `Tool '${toolName}' is not in allowed list` };
    }
    if (this.mode === "full_auto") return { action: "allow", reason: "Full auto mode" };
    if (pathAllowReason !== null) return { action: "allow", reason: pathAllowReason };
    if (matchedRule) return matchedRule;

    if (
      !this.untrustedToolNames.has(toolName) &&
      (!this.trustedLocalReadOnlyToolNames ||
        this.trustedLocalReadOnlyToolNames.has(toolName)) &&
      isLocalReadOnlyToolAllowed(toolName, pathInputs, this.cwd, this.pathStyle)
    ) {
      return {
        action: "allow",
        reason: `Local read-only tool '${toolName}' is within cwd`,
      };
    }

    if (this.mode === "plan") {
      if (modeControl) return { action: "allow", reason: "Runtime-scoped mode control" };
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

function readToolPathInputs(input: Record<string, unknown>): string[] {
  return TOOL_PATH_NAMES.flatMap(name => {
    const value = Object.hasOwn(input, name) ? input[name] : undefined;
    return typeof value === "string" && value ? [value] : [];
  });
}

function isLocalReadOnlyToolAllowed(
  toolName: string,
  paths: readonly string[],
  cwd: string | undefined,
  pathStyle: "windows" | "posix",
): boolean {
  if (!cwd || !LOCAL_READ_ONLY_TOOLS.has(toolName)) return false;
  if (paths.length === 0)
    return toolName === "Glob" || toolName === "Grep" || toolName === "Lsp";
  return paths.every(path => pathStyle === "posix"
    ? isWithinPosixCwd(posix.resolve(cwd, path), cwd)
    : isWithinCwd(win32.resolve(cwd, path), cwd));
}

function isWithinPosixCwd(target: string, cwd: string): boolean {
  const rel = posix.relative(cwd, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !posix.isAbsolute(rel));
}

function isWithinCwd(target: string, cwd: string): boolean {
  const rel = win32.relative(cwd, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !win32.isAbsolute(rel));
}

function normalizeWindowsPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase().replace(/^\/\/\?\/(?=[a-z]:\/)/, "");
}

function normalizePermissionPath(path: string, cwd: string | undefined, pathStyle: "windows" | "posix", pattern = false): string {
  // A URI is not a local filesystem target. Keep its spelling and namespace.
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:/i.test(path)) return path;
  const value = pathStyle === "windows" ? normalizeWindowsPath(path) : path;
  // Leading wildcards retain the existing full-path glob meaning, e.g. *.env.
  if (pattern && /^[*?]/.test(value)) return value;
  const resolved = (pathStyle === "windows" ? win32 : posix).resolve(cwd ?? process.cwd(), value);
  return pathStyle === "windows" ? normalizeWindowsPath(resolved) : resolved;
}

function matchPathPattern(pattern: string, value: string, cwd: string | undefined, pathStyle: "windows" | "posix"): boolean {
  const expression = normalizePermissionPath(pattern, cwd, pathStyle, true)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${expression}$`).test(normalizePermissionPath(value, cwd, pathStyle));
}

function matchPattern(pattern: string, value: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  return regex.test(value);
}
