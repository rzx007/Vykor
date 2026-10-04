export type AttachmentAssetStatus =
  | "importing"
  | "ready"
  | "failed"
  | "deleted";

export type AttachmentIntent =
  | "auto"
  | "vision"
  | "ocr"
  | "document"
  | "tool_resource"
  | "workspace_reference";

export type AttachmentRepresentationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type AttachmentRepresentationKind =
  | "thumbnail"
  | "ocr_text"
  | "plain_text"
  | "pdf_text"
  | "pdf_page_image"
  | "archive_manifest"
  | "directory_manifest";

/** 持久资源来自哪个聊天；临时聊天消失后仍保留这些来源信息。 */
export interface ChatResourceSource {
  storage: "memory" | "sqlite";
  sessionId: string;
  sourceSessionId?: string;
  inputId?: string;
  runId?: string;
}

export interface AttachmentAssetRecord {
  id: string;
  displayName: string;
  declaredMediaType?: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256?: string;
  status: AttachmentAssetStatus;
  failureCode?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  chatSources?: ChatResourceSource[];
}

export interface SessionInputAttachmentRecord {
  id: string;
  sessionId: string;
  inputId: string;
  assetId: string;
  seq: number;
  intent: AttachmentIntent;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface AttachmentRepresentationRecord {
  id: string;
  assetId: string;
  kind: AttachmentRepresentationKind;
  status: AttachmentRepresentationStatus;
  processor: string;
  processorVersion: string;
  cacheKey: string;
  mediaType: string;
  text?: string;
  error?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface AttachmentLimits {
  maxFilesPerPrompt: number;
  maxBytesPerFile: number;
  maxBytesPerPrompt: number;
  maxSessionReferencedBytes: number;
  resumableThresholdBytes: number;
  uploadSessionTtlMs: number;
  stagingTtlMs: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: Readonly<AttachmentLimits> = {
  maxFilesPerPrompt: 20,
  maxBytesPerFile: 100 * 1024 * 1024,
  maxBytesPerPrompt: 250 * 1024 * 1024,
  maxSessionReferencedBytes: 2 * 1024 * 1024 * 1024,
  resumableThresholdBytes: 25 * 1024 * 1024,
  uploadSessionTtlMs: 24 * 60 * 60 * 1_000,
  stagingTtlMs: 24 * 60 * 60 * 1_000,
};

export function parseAttachmentLimits(value: unknown): AttachmentLimits {
  const record = recordValue(value, "attachment limits");
  const limits: AttachmentLimits = {
    maxFilesPerPrompt: positiveInteger(
      record.maxFilesPerPrompt,
      "maxFilesPerPrompt",
    ),
    maxBytesPerFile: positiveInteger(record.maxBytesPerFile, "maxBytesPerFile"),
    maxBytesPerPrompt: positiveInteger(
      record.maxBytesPerPrompt,
      "maxBytesPerPrompt",
    ),
    maxSessionReferencedBytes: positiveInteger(
      record.maxSessionReferencedBytes,
      "maxSessionReferencedBytes",
    ),
    resumableThresholdBytes: positiveInteger(
      record.resumableThresholdBytes,
      "resumableThresholdBytes",
    ),
    uploadSessionTtlMs: positiveInteger(
      record.uploadSessionTtlMs,
      "uploadSessionTtlMs",
    ),
    stagingTtlMs: positiveInteger(record.stagingTtlMs, "stagingTtlMs"),
  };
  if (limits.resumableThresholdBytes > limits.maxBytesPerFile) {
    throw new Error("resumableThresholdBytes must not exceed maxBytesPerFile");
  }
  if (limits.maxBytesPerFile > limits.maxBytesPerPrompt) {
    throw new Error("maxBytesPerFile must not exceed maxBytesPerPrompt");
  }
  if (limits.maxBytesPerPrompt > limits.maxSessionReferencedBytes) {
    throw new Error(
      "maxBytesPerPrompt must not exceed maxSessionReferencedBytes",
    );
  }
  return limits;
}

export function parseAttachmentAssetRecord(
  value: unknown,
): AttachmentAssetRecord {
  const record = recordValue(value, "attachment asset");
  const status = enumValue(
    record.status,
    ["importing", "ready", "failed", "deleted"] as const,
    "status",
  );
  const asset: AttachmentAssetRecord = {
    id: nonEmptyString(record.id, "id"),
    displayName: nonEmptyString(record.displayName, "displayName"),
    status,
    createdAt: nonNegativeInteger(record.createdAt, "createdAt"),
    updatedAt: nonNegativeInteger(record.updatedAt, "updatedAt"),
  };

  const declaredMediaType = optionalNonEmptyString(
    record.declaredMediaType,
    "declaredMediaType",
  );
  const mediaType = optionalNonEmptyString(record.mediaType, "mediaType");
  const sizeBytes = optionalNonNegativeInteger(record.sizeBytes, "sizeBytes");
  const sha256 = optionalSha256(record.sha256);
  const failureCode = optionalNonEmptyString(record.failureCode, "failureCode");
  const deletedAt = optionalNonNegativeInteger(record.deletedAt, "deletedAt");

  if (declaredMediaType !== undefined) asset.declaredMediaType = declaredMediaType;
  if (mediaType !== undefined) asset.mediaType = mediaType;
  if (sizeBytes !== undefined) asset.sizeBytes = sizeBytes;
  if (sha256 !== undefined) asset.sha256 = sha256;
  if (failureCode !== undefined) asset.failureCode = failureCode;
  if (deletedAt !== undefined) asset.deletedAt = deletedAt;
  if (record.chatSources !== undefined) {
    if (!Array.isArray(record.chatSources)) throw new Error("chatSources must be an array");
    asset.chatSources = record.chatSources.map(parseChatResourceSource);
  }

  if (status === "ready" || status === "deleted") {
    if (asset.mediaType === undefined) throw new Error("mediaType is required");
    if (asset.sizeBytes === undefined) throw new Error("sizeBytes is required");
    if (asset.sha256 === undefined) throw new Error("sha256 is required");
  }
  if (status === "failed" && asset.failureCode === undefined) {
    throw new Error("failureCode is required");
  }
  if (status === "deleted" && asset.deletedAt === undefined) {
    throw new Error("deletedAt is required");
  }
  return asset;
}

export function parseChatResourceSource(value: unknown): ChatResourceSource {
  const record = recordValue(value, "chat resource source");
  const source: ChatResourceSource = {
    storage: enumValue(record.storage, ["memory", "sqlite"] as const, "storage"),
    sessionId: nonEmptyString(record.sessionId, "sessionId"),
  };
  for (const field of ["sourceSessionId", "inputId", "runId"] as const) {
    const id = optionalNonEmptyString(record[field], field);
    if (id !== undefined) source[field] = id;
  }
  return source;
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function optionalNonNegativeInteger(
  value: unknown,
  field: string,
): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, field);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, field);
}

function optionalSha256(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("sha256 must be 64 lowercase hexadecimal characters");
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}
