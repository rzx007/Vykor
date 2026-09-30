export const AUTO_REVIEW_MODES = ["off", "risk_based"] as const;
export const AUTO_REVIEW_RISK_LEVELS = ["none", "low", "medium", "high", "unknown"] as const;
export const AUTO_REVIEW_STATUSES = [
  "disabled",
  "captured",
  "skipped",
  "pending",
  "passed",
  "findings",
  "partial",
  "failed",
  "timed_out",
  "unavailable",
] as const;
export const AUTO_REVIEW_VERDICTS = ["pass", "fail", "partial"] as const;
export const AUTO_REVIEW_SEVERITIES = ["critical", "important", "minor"] as const;
export const AUTO_REVIEW_REASONS = [
  "mode_off",
  "no_changes",
  "low_risk_change",
  "source_change",
  "large_change",
  "many_files",
  "sensitive_path",
  "sensitive_content_path",
  "production_delete_or_rename",
  "patch_truncated",
  "not_git_repository",
  "preexisting_dirty_overlap",
  "non_linear_head_change",
  "post_commit_worktree_changed",
  "git_inspection_failed",
  "review_output_invalid",
  "review_child_failed",
  "review_child_timed_out",
  "review_preempted_by_user",
  "parent_run_not_completed",
  "daemon_restarted",
] as const;

export type AutoReviewMode = (typeof AUTO_REVIEW_MODES)[number];
export type AutoReviewRiskLevel = (typeof AUTO_REVIEW_RISK_LEVELS)[number];
export type AutoReviewStatus = (typeof AUTO_REVIEW_STATUSES)[number];
export type AutoReviewVerdict = (typeof AUTO_REVIEW_VERDICTS)[number];
export type AutoReviewSeverity = (typeof AUTO_REVIEW_SEVERITIES)[number];
export type AutoReviewReason = (typeof AUTO_REVIEW_REASONS)[number];

export interface AutoReviewRunMetadata {
  version: 1;
  policyVersion: "risk-v1";
  mode: AutoReviewMode;
  riskLevel: AutoReviewRiskLevel;
  status: AutoReviewStatus;
  reasons: string[];
  reviewTaskId?: string;
  verdict?: AutoReviewVerdict;
  findingCount?: number;
  highestSeverity?: AutoReviewSeverity;
  patchTruncated?: boolean;
  startedAt?: number;
  finishedAt?: number;
}

const AUTO_REVIEW_MODE_SET = new Set<string>(AUTO_REVIEW_MODES);
const AUTO_REVIEW_RISK_LEVEL_SET = new Set<string>(AUTO_REVIEW_RISK_LEVELS);
const AUTO_REVIEW_STATUS_SET = new Set<string>(AUTO_REVIEW_STATUSES);
const AUTO_REVIEW_VERDICT_SET = new Set<string>(AUTO_REVIEW_VERDICTS);
const AUTO_REVIEW_SEVERITY_SET = new Set<string>(AUTO_REVIEW_SEVERITIES);
const AUTO_REVIEW_REASON_SET = new Set<string>(AUTO_REVIEW_REASONS);

const MAX_REASONS = 16;
const MAX_REASON_LENGTH = 128;
const MAX_IDENTIFIER_LENGTH = 256;

/**
 * 只读校验一次持久化的自动评审状态。
 *
 * 任何非法或版本不匹配的输入都返回 undefined，不抛错，避免坏数据阻断读取方。
 */
export function readAutoReviewRunMetadata(value: unknown): AutoReviewRunMetadata | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1) return undefined;
  if (value.policyVersion !== "risk-v1") return undefined;

  const mode = readEnum(value.mode, AUTO_REVIEW_MODE_SET) as AutoReviewMode | undefined;
  const riskLevel = readEnum(value.riskLevel, AUTO_REVIEW_RISK_LEVEL_SET) as
    | AutoReviewRiskLevel
    | undefined;
  const status = readEnum(value.status, AUTO_REVIEW_STATUS_SET) as AutoReviewStatus | undefined;
  if (!mode || !riskLevel || !status) return undefined;

  const reasons = readReasons(value.reasons);
  if (!reasons) return undefined;

  const metadata: AutoReviewRunMetadata = {
    version: 1,
    policyVersion: "risk-v1",
    mode,
    riskLevel,
    status,
    reasons,
  };

  if (value.reviewTaskId !== undefined) {
    if (
      typeof value.reviewTaskId !== "string" ||
      value.reviewTaskId.length < 1 ||
      value.reviewTaskId.length > MAX_IDENTIFIER_LENGTH
    ) {
      return undefined;
    }
    metadata.reviewTaskId = value.reviewTaskId;
  }

  if (value.verdict !== undefined) {
    const verdict = readEnum(value.verdict, AUTO_REVIEW_VERDICT_SET) as AutoReviewVerdict | undefined;
    if (!verdict) return undefined;
    metadata.verdict = verdict;
  }

  if (value.findingCount !== undefined) {
    if (!isNonNegativeSafeInteger(value.findingCount)) return undefined;
    metadata.findingCount = value.findingCount;
  }

  if (value.highestSeverity !== undefined) {
    const severity = readEnum(value.highestSeverity, AUTO_REVIEW_SEVERITY_SET) as
      | AutoReviewSeverity
      | undefined;
    if (!severity) return undefined;
    metadata.highestSeverity = severity;
  }

  if (value.patchTruncated !== undefined) {
    if (typeof value.patchTruncated !== "boolean") return undefined;
    metadata.patchTruncated = value.patchTruncated;
  }

  if (value.startedAt !== undefined) {
    if (!isNonNegativeSafeInteger(value.startedAt)) return undefined;
    metadata.startedAt = value.startedAt;
  }

  if (value.finishedAt !== undefined) {
    if (!isNonNegativeSafeInteger(value.finishedAt)) return undefined;
    metadata.finishedAt = value.finishedAt;
  }

  return metadata;
}

function readReasons(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_REASONS) return undefined;
  const reasons: string[] = [];
  for (const reason of value) {
    if (typeof reason !== "string") return undefined;
    if (reason.length < 1 || reason.length > MAX_REASON_LENGTH) return undefined;
    if (!AUTO_REVIEW_REASON_SET.has(reason)) return undefined;
    reasons.push(reason);
  }
  return reasons;
}

function readEnum(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
