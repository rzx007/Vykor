import type { SessionInputAttachmentRecord, SessionRecord } from "@openharness/protocol";
import {
  classifyAttachmentCandidate,
  type LocalOcrResult,
} from "@openharness/services";

import type { AttachmentService } from "../attachment-service.js";

export interface AttachmentSessionResolverQueries {
  getSession(sessionId: string): SessionRecord | undefined;
}

export interface AttachmentSessionReferenceQueries {
  listSessionInputAttachments(sessionId: string): SessionInputAttachmentRecord[];
}

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
      validateReference(options.store, input.authorizationSessionId, input.assetId);
      validateRange(input.offset, input.limit);
      const reference = options.store.listSessionInputAttachments(input.authorizationSessionId)
        .find((candidate) => candidate.assetId === input.assetId)!;
      if (classifyAttachmentCandidate(reference) !== "text") throw resourceDenied();
      const asset = options.attachments.get(input.assetId);
      if (asset.status !== "ready") throw new Error("attachment_resource_unavailable");
      const decoded = await options.attachments.readReadyText(input.assetId, {
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const lines = decoded.text.split("\n");
      if (input.offset > lines.length) throw new Error("attachment_resource_range_invalid");
      const startIndex = input.offset - 1;
      const selected = lines.slice(startIndex, startIndex + input.limit);
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

export function createAttachmentOcrService(options: {
  store: AttachmentSessionReferenceQueries;
  recognize(input: { assetId: string; signal?: AbortSignal }): Promise<LocalOcrResult>;
}): AttachmentOcrService {
  return {
    async recognize(input) {
      input.signal?.throwIfAborted();
      validateReference(options.store, input.authorizationSessionId, input.assetId);
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
): void {
  try {
    if (store.listSessionInputAttachments(sessionId).some((item) => item.assetId === assetId)) return;
  } catch {
    // Deliberately collapse missing sessions and storage details into one access error.
  }
  throw resourceDenied();
}

function validateRange(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 1 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) {
    throw new Error("attachment_resource_range_invalid");
  }
}

function resourceDenied(): Error {
  return new Error("attachment_resource_access_denied");
}
