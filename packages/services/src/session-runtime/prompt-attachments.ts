import { createHash } from "node:crypto";

import type {
  AdmitPromptAttachmentInput,
  AttachmentIntent,
} from "@vykor/protocol";

import { AttachmentError } from "../attachments/attachment-errors.js";

export interface NormalizedPromptAttachment {
  assetId: string;
  intent: AttachmentIntent;
  displayName?: string;
}

export interface ReferencedAttachmentSize {
  assetId: string;
  sizeBytes: number;
}

export function normalizePromptAttachments(
  attachments: readonly AdmitPromptAttachmentInput[] = [],
): NormalizedPromptAttachment[] {
  const seen = new Set<string>();
  return attachments.map((attachment) => {
    if (seen.has(attachment.assetId)) {
      throw new AttachmentError(
        "attachment_duplicate_reference",
        `Asset ${attachment.assetId} is referenced more than once`,
      );
    }
    seen.add(attachment.assetId);
    return {
      assetId: attachment.assetId,
      intent: attachment.intent ?? "auto",
      ...(attachment.displayName !== undefined
        ? { displayName: attachment.displayName }
        : {}),
    };
  });
}

export function promptAttachmentFingerprint(
  attachments: readonly NormalizedPromptAttachment[],
): string {
  const serialized = JSON.stringify(
    attachments.map(({ assetId, intent, displayName }) => [
      assetId,
      intent,
      displayName ?? null,
    ]),
  );
  return createHash("sha256").update(serialized).digest("hex");
}

export function uniqueReferencedBytes(
  existing: readonly ReferencedAttachmentSize[],
  proposed: readonly ReferencedAttachmentSize[],
): number {
  const sizes = new Map<string, number>();
  for (const reference of [...existing, ...proposed]) {
    if (!sizes.has(reference.assetId)) {
      sizes.set(reference.assetId, reference.sizeBytes);
    }
  }
  return [...sizes.values()].reduce((total, size) => total + size, 0);
}
