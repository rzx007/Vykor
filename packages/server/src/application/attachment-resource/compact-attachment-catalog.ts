import type { CompactContextSection } from "@openharness/core";
import type {
  SessionInputAttachmentRecord,
} from "@openharness/protocol";
import type { SessionStore } from "@openharness/services";

export interface CompactAttachmentSectionStore {
  listSessionInputAttachments(sessionId: string): SessionInputAttachmentRecord[];
  attachments: Pick<SessionStore["attachments"], "getAttachment" | "listAttachmentRepresentations">;
}

export interface CompactAttachmentSectionOptions {
  maxEntries?: number;
  maxPreviewChars?: number;
  maxContentChars?: number;
}

export function buildCompactAttachmentSection(
  store: CompactAttachmentSectionStore,
  sessionId: string,
  options: CompactAttachmentSectionOptions = {},
): CompactContextSection | undefined {
  const maxEntries = positiveLimit(options.maxEntries, 20);
  const maxPreviewChars = positiveLimit(options.maxPreviewChars, 1_000);
  const maxContentChars = positiveLimit(options.maxContentChars, 12_000);
  const references = store.listSessionInputAttachments(sessionId);
  if (references.length === 0) return undefined;

  const selected = references.slice(-maxEntries);
  const blocks: string[] = [];
  let included = 0;
  let contentLength = 0;
  for (const reference of selected) {
    const block = formatReference(store, reference, maxPreviewChars);
    const separatorLength = blocks.length === 0 ? 0 : 1;
    if (contentLength + separatorLength + block.length > maxContentChars) break;
    blocks.push(block);
    contentLength += separatorLength + block.length;
    included++;
  }

  const omitted = references.length - included;
  if (omitted > 0) {
    const omittedLine = `- ${omitted} additional attachment references omitted by compaction limits.`;
    const separator = blocks.length > 0 ? "\n" : "";
    const availableChars = maxContentChars - contentLength - separator.length;
    if (availableChars > 0) blocks.push(omittedLine.slice(0, availableChars));
  }

  const content = blocks.join("\n").slice(0, maxContentChars);
  return content
    ? { heading: "Conversation Attachments", content }
    : undefined;
}

function formatReference(
  store: CompactAttachmentSectionStore,
  reference: SessionInputAttachmentRecord,
  maxPreviewChars: number,
): string {
  const asset = store.attachments.getAttachment(reference.assetId, { includeDeleted: true });
  const available = asset?.status === "ready";
  const resourceUri = attachmentResourceUri(reference.assetId, reference.displayName);
  const access = !available
    ? "The original attachment is unavailable; do not claim to have read it."
    : reference.mediaType.startsWith("image/")
      ? "Use ImageToText to inspect this image; no image contents are known yet."
      : isReadableText(reference)
        ? `Use Read with ${resourceUri} to inspect the text.`
        : "No supported inspection tool is available; do not claim to have read it.";

  const representation = available
    ? store.attachments.listAttachmentRepresentations(reference.assetId)
      .filter((candidate) =>
        candidate.status === "completed" && typeof candidate.text === "string"
      )
      .sort((left, right) =>
        right.updatedAt - left.updatedAt || right.createdAt - left.createdAt
      )[0]
    : undefined;
  const preview = representation?.text === undefined
    ? ""
    : `\n  representation: kind=${safeValue(representation.kind)} processor=${safeValue(representation.processor)}@${safeValue(representation.processorVersion)} truncated=${representation.text.length > maxPreviewChars}\n  <attachment-preview untrusted=\"true\">\n${representation.text.slice(0, maxPreviewChars)}\n  </attachment-preview>`;

  return `- assetId=${safeValue(reference.assetId)} inputId=${safeValue(reference.inputId)} name=${JSON.stringify(reference.displayName)} mediaType=${safeValue(reference.mediaType)} sizeBytes=${reference.sizeBytes} intent=${safeValue(reference.intent)} status=${available ? "available" : "unavailable"}\n  resource: ${resourceUri}\n  access: ${access}${preview}`;
}

function isReadableText(reference: SessionInputAttachmentRecord): boolean {
  return reference.mediaType.startsWith("text/") ||
    reference.intent === "tool_resource" ||
    ["application/json", "application/xml", "application/yaml", "application/toml"]
      .includes(reference.mediaType);
}

function attachmentResourceUri(assetId: string, displayName: string): string {
  return `attachment://${assetId}/${encodeURIComponent(displayName)}`;
}

function safeValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:/@+-]/g, "_").slice(0, 256);
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}
