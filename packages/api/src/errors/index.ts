import {
  ModelRequestFailure,
  type ModelFailureInfo,
  type ModelFailureKind,
} from "@vykor/core";

export class AuthenticationFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationFailure";
  }
}

export class RateLimitFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitFailure";
  }
}

export class RequestFailure extends Error {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = "RequestFailure";
  }
}

export class ProviderCapabilityMismatchFailure extends RequestFailure {
  readonly code = "provider_capability_mismatch";

  constructor(message: string, statusCode = 400) {
    super(message, statusCode);
    this.name = "ProviderCapabilityMismatchFailure";
  }
}

export function requestFailure(message: string, statusCode?: number): RequestFailure {
  if (
    statusCode === 400 &&
    /(?:image|vision|multimodal|media[_ -]?type)/i.test(message) &&
    /(?:unsupported|not support|does not support|invalid|cannot|can't)/i.test(message)
  ) {
    return new ProviderCapabilityMismatchFailure(message, statusCode);
  }
  return new RequestFailure(message, statusCode);
}

// ---------------------------------------------------------------------------
// Unified model failure classification
// ---------------------------------------------------------------------------

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const AUTH_STATUS = new Set([401, 403]);
const AUTH_CODES = new Set(["authentication_error", "permission_error", "invalid_api_key", "invalid_token"]);
const INVALID_REQUEST_CODES = new Set([
  "invalid_request", "invalid_request_error", "context_length_exceeded", "content_filter", "content_policy_violation",
]);
const QUOTA_CODES = new Set([
  "insufficient_quota",
  "quota_exceeded",
  "quota_exhausted",
  "billing_hard_limit_reached",
  "insufficient_balance",
  "account_deactivated",
  "billing_error",
  "usage_limit_reached",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);
const RETRYABLE_PROVIDER_CODES = new Map<string, ModelFailureKind>([
  ["server_error", "server"], ["internal_server_error", "server"], ["internal_error", "server"],
  ["api_error", "server"], ["overloaded_error", "server"], ["server_is_overloaded", "server"],
  ["service_unavailable_error", "server"],
  ["rate_limit_exceeded", "rate_limit"], ["rate_limit_error", "rate_limit"], ["rate_limit", "rate_limit"], ["slow_down", "rate_limit"],
  ["timeout_error", "timeout"], ["request_timeout", "timeout"],
  ["upstream_stream_error", "stream_incomplete"], ["stream_incomplete", "stream_incomplete"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 沿 cause 链收集错误，最多 8 层并防止循环引用。 */
function collectCauseChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 8) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = isRecord(current) ? current.cause : undefined;
  }
  return chain;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  const getter = headers.get;
  if (typeof getter === "function") {
    const value = (getter as (key: string) => unknown).call(headers, name);
    if (typeof value === "string" && value.trim()) return value;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase() && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/**
 * 解析 `Retry-After`：支持秒数和 HTTP 日期，非法值/负数忽略。
 * 入参可以是数字（秒）或字符串。
 */
export function parseRetryAfterMs(value: unknown, now = Date.now()): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.round(value * 1000);
  }
  const raw = readString(value);
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return seconds < 0 ? undefined : Math.round(seconds * 1000);
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, parsed - now);
}

function extractRetryAfterMs(chain: unknown[], now: number): number | undefined {
  for (const item of chain) {
    if (!isRecord(item)) continue;
    const headers = item.headers;
    const raw =
      headerValue(headers, "retry-after") ??
      readString(item.retryAfter) ??
      readString(item["retry-after"]);
    const parsed = parseRetryAfterMs(raw, now);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function extractRequestId(chain: unknown[]): string | undefined {
  for (const item of chain) {
    if (!isRecord(item)) continue;
    const direct =
      readString(item.request_id) ??
      readString(item.requestId) ??
      readString(item.requestID);
    if (direct) return direct;
    const headers = item.headers;
    const header =
      headerValue(headers, "x-request-id") ??
      headerValue(headers, "request-id") ??
      headerValue(headers, "x-amzn-requestid");
    if (header) return header;
  }
  return undefined;
}

function extractStatus(chain: unknown[]): number | undefined {
  for (const item of chain) {
    if (!isRecord(item)) continue;
    const status = readNumber(item.status) ?? readNumber(item.statusCode);
    if (status !== undefined) return status;
  }
  return undefined;
}

function extractCodes(chain: unknown[]): string[] {
  const codes: string[] = [];
  for (const item of chain) {
    if (!isRecord(item)) continue;
    const direct = readString(item.code);
    if (direct) codes.push(direct);
    const nestedError = item.error;
    if (isRecord(nestedError)) {
      for (const value of [nestedError.code, nestedError.type]) {
        const nested = readString(value);
        if (nested) codes.push(nested);
      }
    }
    const type = readString(item.type);
    if (type) codes.push(type);
  }
  return codes;
}

function extractMessage(chain: unknown[]): string {
  for (const item of chain) {
    const message = readString(isRecord(item) ? item.message : undefined);
    if (message) return message;
  }
  const first = chain[0];
  return first === undefined ? "Model request failed" : String(first);
}

function isCertificateError(chain: unknown[]): boolean {
  if (extractCodes(chain).some((code) => /CERT|TLS|SSL/i.test(code))) return true;
  return chain.some((item) => {
    if (!isRecord(item)) return false;
    const code = readString(item.code) ?? readString(item.name) ?? "";
    if (/CERT|TLS|SSL/i.test(code)) return true;
    const message = readString(item.message) ?? "";
    return /certificate|self.signed|unable to verify the first certificate/i.test(message);
  });
}

interface Classification {
  kind: ModelFailureKind;
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
  requestId?: string;
}

function classifyChain(chain: unknown[], now: number, phase: "request" | "stream"): Classification {
  const requestId = extractRequestId(chain);
  const statusCode = extractStatus(chain);
  const codes = extractCodes(chain);
  const upperCodes = codes.map((code) => code.toUpperCase());
  const lowerCodes = codes.map((code) => code.toLowerCase());
  const retryAfterMs = extractRetryAfterMs(chain, now);

  if (isCertificateError(chain)) {
    return {
      kind: "network",
      retryable: false,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }

  if ((statusCode !== undefined && AUTH_STATUS.has(statusCode)) || lowerCodes.some((code) => AUTH_CODES.has(code))) {
    return {
      kind: "authentication",
      retryable: false,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }

  if (codes.some((code) => QUOTA_CODES.has(code.toLowerCase()))) {
    return {
      kind: "quota",
      retryable: false,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }

  if (lowerCodes.some((code) => INVALID_REQUEST_CODES.has(code))) {
    return {
      kind: "invalid_request", retryable: false,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }

  if (statusCode === 429) {
    return {
      kind: "rate_limit",
      retryable: true,
      statusCode,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }

  if (statusCode !== undefined) {
    if (statusCode === 408) {
      return {
        kind: "timeout", retryable: true, statusCode,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(requestId ? { requestId } : {}),
      };
    }
    if (statusCode >= 500) {
      return {
        kind: "server",
        retryable: true,
        statusCode,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(requestId ? { requestId } : {}),
      };
    }
    if (statusCode >= 400) {
      return {
        kind: "invalid_request",
        retryable: false,
        statusCode,
        ...(requestId ? { requestId } : {}),
      };
    }
  }

  if (upperCodes.some((code) => RETRYABLE_NETWORK_CODES.has(code))) {
    return {
      kind: "network",
      retryable: true,
      ...(requestId ? { requestId } : {}),
    };
  }

  const providerKind = lowerCodes.map((code) => RETRYABLE_PROVIDER_CODES.get(code)).find((kind) => kind !== undefined);
  // Exact, phase-limited fallback for gateways that omit structured error codes.
  const upstreamTerminated = phase === "stream" && chain.some((item) => {
    if (!isRecord(item)) return false;
    return [item.message, isRecord(item.error) ? item.error.message : undefined].some((message) =>
      typeof message === "string" && /^Upstream stream terminated unexpectedly before completion[.!]?$/i.test(message.trim()),
    );
  });
  const kind = providerKind ?? (upstreamTerminated ? "stream_incomplete" : undefined);
  if (kind !== undefined && (kind !== "stream_incomplete" || phase === "stream")) {
    return {
      kind, retryable: true,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }

  return {
    kind: "unknown",
    retryable: false,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

/**
 * 把任意提供商/SDK 抛出的错误归类为统一的 {@link ModelRequestFailure}。
 *
 * 保留原始错误于 `cause`。网络类错误码沿 cause 链查找；证书错误和普通编程
 * 错误不会被误判为可重试。调用方需自行在外部取消时优先抛出取消原因。
 */
export function toModelRequestFailure(
  error: unknown,
  phase: "request" | "stream",
  now = Date.now(),
): ModelRequestFailure {
  if (error instanceof ModelRequestFailure) return error;
  const chain = collectCauseChain(error);
  const classification = classifyChain(chain, now, phase);
  const message = extractMessage(chain);
  const hasDns = extractCodes(chain).some((code) => /EAI_AGAIN|ENOTFOUND/i.test(code));
  const info: ModelFailureInfo = {
    kind: classification.kind,
    phase,
    retryable: classification.retryable,
    ...(classification.statusCode !== undefined ? { statusCode: classification.statusCode } : {}),
    ...(classification.retryAfterMs !== undefined ? { retryAfterMs: classification.retryAfterMs } : {}),
    ...(classification.requestId ? { requestId: classification.requestId } : {}),
  };
  const display = hasDns
    ? `无法解析模型服务地址，请检查网络或 DNS：${message}`
    : message;
  return new ModelRequestFailure(display, info, error);
}

/** 生成一个明确的、不可重试的响应协议错误；工具参数错误通过工具反馈恢复。 */
export function protocolFailure(message: string): ModelRequestFailure {
  return new ModelRequestFailure(message, {
    kind: "protocol",
    phase: "stream",
    retryable: false,
  });
}

/** 生成一个「流未收到完成标记就结束」的可重试中断。 */
export function streamIncompleteFailure(message: string, cause?: unknown): ModelRequestFailure {
  return new ModelRequestFailure(
    message,
    { kind: "stream_incomplete", phase: "stream", retryable: true },
    cause,
  );
}
