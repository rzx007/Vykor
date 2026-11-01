import type { SessionInputAttachmentRecord } from "@vykor/domain-contracts/attachments";
import { createHash } from "node:crypto";
import { isCommittedModelPart, type SessionMessagePartRecord, type SessionRecord } from "@vykor/domain-contracts/sessions";
import { officeFormat, OFFICE_MEDIA_TYPES } from "@vykor/domain-contracts/attachments";
import {
  classifyAttachmentCandidate,
  type LocalOcrResult,
} from "@vykor/services";

import type { AttachmentService } from "../attachment-service.js";

export interface AttachmentSessionResolverQueries {
  getSession(sessionId: string): SessionRecord | undefined;
}

export interface AttachmentSessionReferenceQueries {
  listSessionInputAttachments(
    sessionId: string,
  ): SessionInputAttachmentRecord[];
  listMessageParts?(sessionId: string): SessionMessagePartRecord[];
}

type AttachmentReference = Pick<SessionInputAttachmentRecord, "assetId" | "displayName" | "mediaType" | "sizeBytes">;

export interface AttachmentAuthorizationSessionResolver {
  resolve(executionSessionId: string): string | undefined;
}

export interface AttachmentTextSlice {
  displayName: string;
  mediaType: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  content: string;
  startLine: number;
  endLine: number;
  hasMore: boolean;
}

export interface AttachmentTextReader {
  readText(input: {
    authorizationSessionId: string;
    assetId: string;
    offset: number;
    limit: number;
    signal?: AbortSignal;
  }): Promise<AttachmentTextSlice>;
}

/** Host-only original bytes and source; paths must never be included in model text. */
export interface AttachmentImageContent {
  assetId: string;
  displayName: string;
  mediaType: string;
  bytes: Uint8Array;
  path: string;
}

export interface AttachmentImageReader {
  /** An authorized non-image returns undefined so Read can continue as text. */
  readImage(input: {
    authorizationSessionId: string;
    assetId: string;
    signal?: AbortSignal;
  }): Promise<AttachmentImageContent | undefined>;
}

// Stable display lines let offset/limit reach long paragraphs without dropping
// their tails. Unicode-aware matching keeps surrogate pairs together.
export function officeTextLines(text: string): string[] {
  return text.split("\n").flatMap((line) => line.match(/[\s\S]{1,2000}/gu) ?? [""]);
}

export interface AttachmentOcrService {
  recognize(input: {
    authorizationSessionId: string;
    assetId: string;
    signal?: AbortSignal;
  }): Promise<LocalOcrResult>;
}

export function createAttachmentAuthorizationSessionResolver(options: {
  store: AttachmentSessionResolverQueries;
  liveChildren: { resolveRootSessionId(sessionId: string): string | undefined };
}): AttachmentAuthorizationSessionResolver {
  return {
    resolve(executionSessionId) {
      const session = options.store.getSession(executionSessionId);
      if (!session) return undefined;
      return session.parentId
        ? options.liveChildren.resolveRootSessionId(executionSessionId)
        : session.id;
    },
  };
}

export function createAttachmentTextReader(options: {
  store: AttachmentSessionReferenceQueries;
  attachments: AttachmentService;
}): AttachmentTextReader {
  return {
    async readText(input) {
      input.signal?.throwIfAborted();
      const reference = validateReference(
        options.store,
        input.authorizationSessionId,
        input.assetId,
      );
      validateRange(input.offset, input.limit);
      const format = officeFormat(reference.displayName);
      if (
        classifyAttachmentCandidate(reference) !== "text" &&
        !(format && reference.mediaType === OFFICE_MEDIA_TYPES[format])
      )
        throw resourceDenied();
      const asset = options.attachments.get(input.assetId);
      if (asset.status !== "ready")
        throw new Error("attachment_resource_unavailable");
      const decoded = await options.attachments.readReadyText(input.assetId, {
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const lines = format ? officeTextLines(decoded.text) : decoded.text.split("\n");
      if (input.offset > lines.length)
        throw new Error("attachment_resource_range_invalid");
      const startIndex = input.offset - 1;
      const selected: string[] = [];
      let chars = 0;
      for (const line of lines.slice(startIndex, startIndex + input.limit)) {
        if (format && chars + Buffer.byteLength(line, "utf8") > 48000) break;
        selected.push(line);
        chars += Buffer.byteLength(line, "utf8") + 20;
      }
      return {
        displayName: decoded.displayName,
        mediaType: decoded.mediaType,
        encoding: decoded.encoding,
        content: selected.join("\n"),
        startLine: input.offset,
        endLine: input.offset + selected.length - 1,
        hasMore: startIndex + selected.length < lines.length,
      };
    },
  };
}

export function createAttachmentImageReader(options: {
  store: AttachmentSessionReferenceQueries;
  attachments: Pick<AttachmentService, "get" | "openContent" | "resolveReadyContentPath">;
}): AttachmentImageReader {
  return {
    async readImage(input) {
      input.signal?.throwIfAborted();
      const reference = validateReference(options.store, input.authorizationSessionId, input.assetId);
      if (!reference.mediaType.startsWith("image/")) return undefined;
      const asset = options.attachments.get(input.assetId);
      if (asset.status !== "ready" || !asset.sha256 || asset.id !== reference.assetId ||
          asset.mediaType !== reference.mediaType || asset.sizeBytes !== reference.sizeBytes) {
        throw new Error("attachment_resource_unavailable");
      }
      // Resolve through Blob storage first, including its regular-file and size checks.
      const source = await options.attachments.resolveReadyContentPath(input.assetId);
      if (source.assetId !== asset.id || source.mediaType !== asset.mediaType || source.sizeBytes !== asset.sizeBytes) {
        throw new Error("attachment_resource_unavailable");
      }
      const opened = await options.attachments.openContent(input.assetId);
      const reader = opened.content.getReader();
      const chunks: Uint8Array[] = [];
      const digest = createHash("sha256");
      let size = 0;
      try {
        if (opened.asset.id !== asset.id || opened.sha256 !== asset.sha256 ||
            opened.mediaType !== asset.mediaType || opened.sizeBytes !== asset.sizeBytes) {
          throw new Error("attachment_resource_unavailable");
        }
        while (true) {
          input.signal?.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > source.sizeBytes) throw new Error("attachment_resource_unavailable");
          chunks.push(chunk.value);
          digest.update(chunk.value);
        }
        input.signal?.throwIfAborted();
        if (size !== source.sizeBytes || digest.digest("hex") !== asset.sha256) {
          throw new Error("attachment_resource_unavailable");
        }
        // An edit/delete can revoke the durable reference while bytes are being read.
        validateReference(options.store, input.authorizationSessionId, input.assetId);
        const current = options.attachments.get(input.assetId);
        if (current.status !== "ready" || current.sha256 !== asset.sha256 ||
            current.mediaType !== asset.mediaType || current.sizeBytes !== asset.sizeBytes) {
          throw new Error("attachment_resource_unavailable");
        }
        return {
          assetId: asset.id,
          displayName: reference.displayName,
          mediaType: source.mediaType,
          bytes: Buffer.concat(chunks, size),
          path: source.path,
        };
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    },
  };
}

export function createAttachmentOcrService(options: {
  store: AttachmentSessionReferenceQueries;
  recognize(input: {
    assetId: string;
    signal?: AbortSignal;
  }): Promise<LocalOcrResult>;
}): AttachmentOcrService {
  return {
    async recognize(input) {
      input.signal?.throwIfAborted();
      validateReference(
        options.store,
        input.authorizationSessionId,
        input.assetId,
      );
      return await options.recognize({
        assetId: input.assetId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
  };
}

function validateReference(
  store: AttachmentSessionReferenceQueries,
  sessionId: string,
  assetId: string,
): AttachmentReference {
  try {
    const reference = store
        .listSessionInputAttachments(sessionId)
        .find((item) => item.assetId === assetId);
    if (reference) return reference;
    const parts = store.listMessageParts?.(sessionId) ?? [];
    for (const part of parts) {
      if (part.sessionId !== sessionId || part.type !== "attachment" || part.assetId !== assetId ||
          part.status !== "completed" || part.metadata.source !== "image_generation" || !isCommittedModelPart(part) ||
          typeof part.displayName !== "string" || !part.displayName ||
          typeof part.mediaType !== "string" || !part.mediaType ||
          typeof part.sizeBytes !== "number" || !Number.isSafeInteger(part.sizeBytes) || part.sizeBytes < 0) continue;
      // Free plugin result metadata may claim generatedImages; only the matching host tool call grants access.
      if (typeof part.metadata.toolUseId !== "string" || !parts.some(tool =>
        tool.sessionId === sessionId && tool.messageId === part.messageId && tool.type === "tool" &&
        tool.toolName === "ImageGeneration" && tool.toolUseId === part.metadata.toolUseId &&
        tool.status === "completed" && !tool.isError && isCommittedModelPart(tool),
      )) continue;
      return { assetId, displayName: part.displayName, mediaType: part.mediaType, sizeBytes: part.sizeBytes };
    }
  } catch {
    // Deliberately collapse missing sessions and storage details into one access error.
  }
  throw resourceDenied();
}

function validateRange(offset: number, limit: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 2_000
  ) {
    throw new Error("attachment_resource_range_invalid");
  }
}

function resourceDenied(): Error {
  return new Error("attachment_resource_access_denied");
}
