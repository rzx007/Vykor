import type { SessionMessagePartRecord } from "./session.js";

export type SessionModelFailureKind =
  | "network"
  | "timeout"
  | "rate_limit"
  | "server"
  | "stream_incomplete"
  | "authentication"
  | "invalid_request"
  | "quota"
  | "protocol"
  | "unknown";

const SESSION_MODEL_FAILURE_KINDS = new Set<string>([
  "network", "timeout", "rate_limit", "server", "stream_incomplete",
  "authentication", "invalid_request", "quota", "protocol", "unknown",
]);

/** Mirrors core `ModelRetryState` without creating a protocol -> core dependency. */
export interface SessionModelRetryState {
  generationId: string;
  attempt: number;
  retryNumber: number;
  maxRetries: number;
  reason: SessionModelFailureKind;
  nextRetryAt: number;
  recoveryDeadlineAt: number;
}

/** Stored on a message part to identify which model attempt produced it. */
export interface SessionModelGenerationMetadata {
  generationId: string;
  attempt: number;
  /** A newer attempt replaced this part; its content is diagnostic only. */
  superseded?: boolean;
  /** The generation completed successfully; only committed parts are valid history. */
  committed?: boolean;
}

export type SessionModelAttemptUsageStatus = "complete" | "partial" | "unknown";

export interface SessionModelAttemptUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  usageIncomplete?: boolean;
}

export interface SessionModelAttemptUsage {
  generationId: string;
  attempt: number;
  status: "completed" | "failed" | "interrupted";
  usageStatus: SessionModelAttemptUsageStatus;
  usage?: SessionModelAttemptUsageSnapshot;
}

export interface SessionModelUsageSummary {
  incomplete: boolean;
  unknownAttempts: number;
  partialAttempts: number;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 安全解析 Run metadata 中的重试状态；非法/未知数据返回 undefined。 */
export function readSessionModelRetryState(
  metadata: Record<string, unknown> | undefined,
): SessionModelRetryState | undefined {
  if (!isRecordValue(metadata)) return undefined;
  const raw = metadata.modelRetry;
  if (!isRecordValue(raw)) return undefined;
  const generationId = readNonEmptyString(raw.generationId);
  const attempt = readPositiveInteger(raw.attempt);
  const retryNumber = readPositiveInteger(raw.retryNumber);
  const maxRetries = readNonNegativeInteger(raw.maxRetries);
  const reason = readNonEmptyString(raw.reason);
  const nextRetryAt = readFiniteNumber(raw.nextRetryAt);
  const recoveryDeadlineAt = readFiniteNumber(raw.recoveryDeadlineAt);
  if (
    !generationId ||
    attempt === undefined ||
    retryNumber === undefined ||
    maxRetries === undefined ||
    !reason ||
    !SESSION_MODEL_FAILURE_KINDS.has(reason) ||
    nextRetryAt === undefined ||
    recoveryDeadlineAt === undefined
  ) {
    return undefined;
  }
  return {
    generationId,
    attempt,
    retryNumber,
    maxRetries,
    reason: reason as SessionModelFailureKind,
    nextRetryAt,
    recoveryDeadlineAt,
  };
}

/** 安全解析 part metadata 中的生成归属；非法数据返回 undefined。 */
export function readModelGenerationMetadata(
  metadata: Record<string, unknown> | undefined,
): SessionModelGenerationMetadata | undefined {
  if (!isRecordValue(metadata)) return undefined;
  const raw = metadata.modelGeneration;
  if (!isRecordValue(raw)) return undefined;
  const generationId = readNonEmptyString(raw.generationId);
  const attempt = readPositiveInteger(raw.attempt);
  if (!generationId || attempt === undefined) return undefined;
  return {
    generationId,
    attempt,
    ...(raw.superseded === true ? { superseded: true } : {}),
    ...(raw.committed === true ? { committed: true } : {}),
  };
}

/** 被新尝试替代的 part：界面和模型历史都不应把它当作有效内容。 */
export function isSupersededModelPart(part: SessionMessagePartRecord): boolean {
  return readModelGenerationMetadata(part.metadata)?.superseded === true;
}

/**
 * 可作为模型历史的已确认 part。旧格式（无 modelGeneration）保持原语义返回
 * true；新格式必须 committed=true 且未被替代。
 */
export function isCommittedModelPart(part: SessionMessagePartRecord): boolean {
  const generation = readModelGenerationMetadata(part.metadata);
  if (!generation) return true;
  return generation.committed === true && generation.superseded !== true;
}

export function readSessionModelUsage(
  metadata: Record<string, unknown> | undefined,
): SessionModelUsageSummary | undefined {
  if (!isRecordValue(metadata)) return undefined;
  const raw = metadata.modelUsage;
  if (!isRecordValue(raw)) return undefined;
  return {
    incomplete: raw.incomplete === true,
    unknownAttempts: readNonNegativeInteger(raw.unknownAttempts) ?? 0,
    partialAttempts: readNonNegativeInteger(raw.partialAttempts) ?? 0,
  };
}

export function readSessionModelAttemptUsage(
  value: unknown,
): SessionModelAttemptUsage | undefined {
  if (!isRecordValue(value)) return undefined;
  const generationId = readNonEmptyString(value.generationId);
  const attempt = readPositiveInteger(value.attempt);
  const status = value.status;
  const usageStatus = value.usageStatus;
  if (
    !generationId ||
    attempt === undefined ||
    (status !== "completed" && status !== "failed" && status !== "interrupted") ||
    (usageStatus !== "complete" && usageStatus !== "partial" && usageStatus !== "unknown")
  ) {
    return undefined;
  }
  let usage: SessionModelAttemptUsageSnapshot | undefined;
  if (isRecordValue(value.usage)) {
    const inputTokens = readNonNegativeInteger(value.usage.inputTokens);
    const outputTokens = readNonNegativeInteger(value.usage.outputTokens);
    if (inputTokens === undefined || outputTokens === undefined) return undefined;
    usage = {
      inputTokens,
      outputTokens,
      ...(readNonNegativeInteger(value.usage.cacheCreationTokens) !== undefined
        ? { cacheCreationTokens: readNonNegativeInteger(value.usage.cacheCreationTokens) } : {}),
      ...(readNonNegativeInteger(value.usage.cacheReadTokens) !== undefined
        ? { cacheReadTokens: readNonNegativeInteger(value.usage.cacheReadTokens) } : {}),
      ...(value.usage.usageIncomplete === true ? { usageIncomplete: true } : {}),
    };
  } else if (usageStatus === "complete") {
    // A complete settlement without a usage snapshot is invalid.
    return undefined;
  }
  return { generationId, attempt, status, usageStatus, ...(usage ? { usage } : {}) };
}
