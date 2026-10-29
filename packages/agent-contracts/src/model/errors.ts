/**
 * 模型调用失败类别。用于决定是否重试以及向后端/界面报告的诊断信息。
 * 这里是纯数据描述，不依赖 API 包，避免 core 反向依赖具体提供商实现。
 */
export type ModelFailureKind =
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

/**
 * 一次失败的结构化信息：哪一段连接失败（请求建立还是流读取）、是否能重试、
 * HTTP 状态码、服务端要求的等待时间，以及可获得的请求标识。
 */
export interface ModelFailureInfo {
  kind: ModelFailureKind;
  phase: "request" | "stream";
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
  requestId?: string;
  /** 上下文超长分类；false 表示具体错误码已确认是其他错误。未分类时缺省。不是零用量证明。 */
  contextLengthExceeded?: boolean;
}

/** 无具体错误码时，只识别实际错误说明开头的上下文溢出，不读取被引用的工具名或字段。 */
export function isContextLengthExceededMessage(message: string): boolean {
  const text = message.trim().replace(/^\d{3}(?:\s+|:\s*)/, "");
  return [
    /^(?:context_length_exceeded|exceed_context)(?:\s*:.*)?\s*$/i,
    /^(?:Upstream request failed:\s*)?\[(?:context_length_exceeded|exceed_context)\](?:\s|:|$)/i,
    /^(?:the\s+)?(?:prompt|input)\s+(?:is\s+)?too\s+long\b/i,
    /^(?:(?:the\s+)?(?:input|prompt|request|messages?)\s+)?exceed(?:s|ed)?\s+(?:the\s+)?(?:(?:available|maximum|model(?:'s)?)\s+)?context(?:\s+(?:length|window|size))?\b/i,
    /^(?:(?:the|maximum)\s+)?context (?:length|window|size)\s+(?:limit\s+)?(?:(?:has been|is|was)\s+)?(?:exceeded|overflow(?:ed)?)\b/i,
    /^(?:This model's\s+)?maximum context length\s+(?:is|of)\s+[\d,]+\s+tokens?\b.{0,120}\b(?:requested|resulted in)\s+[\d,]+/i,
  ].some(pattern => pattern.test(text));
}

/**
 * 适配器抛出的统一模型失败类型。原始异常通过 `cause` 保留，只有该结构会进入
 * 重试策略；序列化到客户端时必须换成安全摘要，不能带完整 cause 对象。
 */
const MODEL_REQUEST_FAILURE = Symbol.for("@vykor/core/ModelRequestFailure");

export class ModelRequestFailure extends Error {
  private readonly [MODEL_REQUEST_FAILURE] = true;

  // Separate bundles have different constructors but share the global symbol.
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null
      && MODEL_REQUEST_FAILURE in value && (value as unknown as ModelRequestFailure)[MODEL_REQUEST_FAILURE] === true;
  }

  constructor(
    message: string,
    readonly info: ModelFailureInfo,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ModelRequestFailure";
  }
}
