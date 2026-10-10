import type {
  AutoReviewReason,
  AutoReviewRiskLevel,
} from "@vykor/protocol";

export interface AutoReviewChangeFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
  lines: number;
  additions?: number;
  deletions?: number;
}

export interface AutoReviewChangeSet {
  files: AutoReviewChangeFile[];
  attribution: "complete" | "incomplete";
  attributionReason?: AutoReviewReason;
  patchTruncated: boolean;
}

export interface AutoReviewRiskDecision {
  level: AutoReviewRiskLevel;
  shouldReview: boolean;
  reasons: AutoReviewReason[];
  requestedMaxTurns?: number;
  requestedTimeoutSeconds?: number;
}

const MEDIUM_BUDGET = { requestedMaxTurns: 10, requestedTimeoutSeconds: 120 } as const;
const HIGH_BUDGET = { requestedMaxTurns: 20, requestedTimeoutSeconds: 240 } as const;

const MAX_LOW_RISK_FILES = 5;
const MAX_LOW_RISK_LINES = 300;
const HIGH_RISK_FILE_COUNT = 8;
const HIGH_RISK_LINE_COUNT = 600;

const SENSITIVE_PATH_PATTERNS = [
  "**/auth/**",
  "**/permissions/**",
  "**/sandbox/**",
  "**/security/**",
  "**/migrations/**",
  "**/database/**",
  "**/agent-runtime/**",
  "**/core/src/engine/**",
  ".github/workflows/**",
  "Dockerfile*",
  "docker-compose*.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
] as const;

const LOW_RISK_PATH_PATTERNS = [
  "docs/**",
  "**/*.md",
  "**/*.test.*",
  "**/__test__/**",
  "**/fixtures/**",
] as const;

/**
 * 把一次 Run 可归因的 change set 映射成固定风险等级与评审预算。
 *
 * 全部判断基于确定性的路径/行数事实，不调用模型；命中高风险后不再降级。
 */
export function classifyAutoReviewRisk(changeSet: AutoReviewChangeSet): AutoReviewRiskDecision {
  if (changeSet.attribution === "incomplete") {
    return {
      level: "unknown",
      shouldReview: false,
      reasons: [changeSet.attributionReason ?? "git_inspection_failed"],
    };
  }

  const { files } = changeSet;
  const totalLines = files.reduce(
    (sum, file) => sum + (Number.isFinite(file.lines) && file.lines > 0 ? file.lines : 0),
    0,
  );

  const highReasons: AutoReviewReason[] = [];
  if (files.some((file) => pathsOf(file).some(isSensitivePath))) {
    highReasons.push("sensitive_path");
  }
  if (files.some((file) => isProductionDeleteOrRename(file))) {
    highReasons.push("production_delete_or_rename");
  }
  if (files.length >= HIGH_RISK_FILE_COUNT) highReasons.push("many_files");
  if (totalLines >= HIGH_RISK_LINE_COUNT) highReasons.push("large_change");
  if (changeSet.patchTruncated) highReasons.push("patch_truncated");

  if (highReasons.length > 0) {
    return { level: "high", shouldReview: true, reasons: highReasons, ...HIGH_BUDGET };
  }

  if (files.length === 0) {
    return { level: "none", shouldReview: false, reasons: ["no_changes"] };
  }

  const hasDestructiveChange = files.some(
    (file) => file.status === "deleted" || file.status === "renamed",
  );
  const isBounded = files.length <= MAX_LOW_RISK_FILES && totalLines <= MAX_LOW_RISK_LINES;
  if (!hasDestructiveChange && isBounded && files.every((file) => isLowRiskPath(file.path))) {
    return { level: "low", shouldReview: false, reasons: ["low_risk_change"] };
  }

  return { level: "medium", shouldReview: true, reasons: ["source_change"], ...MEDIUM_BUDGET };
}

function pathsOf(file: AutoReviewChangeFile): string[] {
  return file.oldPath === undefined ? [file.path] : [file.path, file.oldPath];
}

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => matchesGlob(path, pattern));
}

function isLowRiskPath(path: string): boolean {
  return LOW_RISK_PATH_PATTERNS.some((pattern) => matchesGlob(path, pattern));
}

function isProductionDeleteOrRename(file: AutoReviewChangeFile): boolean {
  if (file.status !== "deleted" && file.status !== "renamed") return false;
  return pathsOf(file).some((path) => !isLowRiskPath(path));
}

function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = pattern.replace(/\\/g, "/");
  if (!normalizedPattern.includes("/")) {
    const base = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
    return globToRegExp(normalizedPattern).test(base);
  }
  return globToRegExp(normalizedPattern).test(normalizedPath);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

const REGEXP_SPECIAL = new Set([...".^$+()|{}[]"]);

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (REGEXP_SPECIAL.has(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}
