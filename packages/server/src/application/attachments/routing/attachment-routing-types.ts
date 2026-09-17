import type { ProviderInputCapabilities } from "@openharness/api";
import type { ContentBlock, ModelInputCapabilities } from "@openharness/core";
import type { SessionInputAttachmentRecord } from "@openharness/protocol";

export type AttachmentRoutingErrorCode =
  | "attachment_model_capability_unknown"
  | "attachment_model_unsupported"
  | "attachment_provider_capability_unknown"
  | "attachment_provider_unsupported"
  | "attachment_intent_unavailable"
  | "attachment_kind_unsupported"
  | "attachment_document_unsupported"
  | "attachment_archive_unsupported"
  | "attachment_binary_unsupported"
  | "attachment_text_encoding_unsupported"
  | "attachment_text_invalid"
  | "attachment_media_type_unsupported"
  | "attachment_ocr_tool_unavailable"
  | "attachment_ocr_unavailable"
  | "attachment_materialization_failed"
  | "attachment_routing_aborted";

export interface AttachmentRoutingDecision {
  assetId: string;
  intent: SessionInputAttachmentRecord["intent"];
  mediaType: string;
  route: "native_image" | "image_to_text_tool" | "text_inline" | "text_resource" | "blocked";
  reason?: AttachmentRoutingErrorCode;
  complete?: boolean;
  resourceUri?: string;
}

export interface RouteAttachmentBatchInput {
  text: string;
  attachments: readonly SessionInputAttachmentRecord[];
  modelCapabilities: ModelInputCapabilities;
  providerCapabilities: ProviderInputCapabilities;
  /** Actual tools left after the Agent's allow/deny filters. */
  availableTools?: readonly string[];
  /** Whether the daemon installed the local OCR service for this Agent. */
  attachmentOcrAvailable?: boolean;
  signal?: AbortSignal;
}

export interface NativeAttachmentRouteResult {
  content: ContentBlock[];
  decisions: AttachmentRoutingDecision[];
}

export class AttachmentRoutingError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: AttachmentRoutingErrorCode,
    message: string,
    readonly assetIds: string[],
    readonly decisions: AttachmentRoutingDecision[],
  ) {
    super(message);
    this.name = "AttachmentRoutingError";
  }
}
