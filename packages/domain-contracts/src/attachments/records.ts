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
