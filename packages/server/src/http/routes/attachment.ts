import type { AttachmentAssetRecord } from "@openharness/protocol";
import { AttachmentError, decodeAttachmentFilename } from "@openharness/services";
import { Hono } from "hono";

import type { AttachmentService } from "../../application/attachments/attachment-service.js";

import {
  attachmentErrorResponse,
  errorResponse,
  jsonResponse,
} from "../support.js";

export type AttachmentRouteService = Pick<
  AttachmentService,
  "limits" | "import" | "get" | "openContent" | "delete"
>;

interface ByteRange {
  start: number;
  end: number;
}

export function createAttachmentRoutes(
  attachments: AttachmentRouteService,
): Hono {
  return new Hono()
    .post("/", async (c) => {
      try {
        const encodedName = c.req.header("x-openharness-filename");
        if (!encodedName) {
          return errorResponse(400, "x-openharness-filename is required");
        }
        const displayName = decodeAttachmentFilename(encodedName);
        const contentLength = parseContentLength(c.req.header("content-length"));
        if (
          contentLength !== undefined &&
          contentLength > attachments.limits.maxBytesPerFile
        ) {
          throw new AttachmentError(
            "attachment_too_large",
            `attachment exceeds the ${attachments.limits.maxBytesPerFile} byte limit`,
          );
        }
        const declaredMediaType = parseDeclaredMediaType(
          c.req.header("content-type"),
        );
        const asset = await attachments.import({
          displayName,
          ...(declaredMediaType ? { declaredMediaType } : {}),
          content: c.req.raw.body ?? emptyByteStream(),
          signal: c.req.raw.signal,
        });
        return jsonResponse(asset, 201);
      } catch (error) {
        return attachmentErrorResponse(error);
      }
    })
    .get("/:id/content", async (c) => {
      try {
        const asset = attachments.get(c.req.param("id"));
        assertReadyAsset(asset);
        const etag = `"sha256-${asset.sha256}"`;
        if (c.req.header("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }

        const requestedRange = c.req.header("range");
        const range = requestedRange
          ? parseByteRange(requestedRange, asset.sizeBytes)
          : undefined;
        if (requestedRange && !range) {
          return rangeNotSatisfiable(asset.sizeBytes);
        }

        const opened = await attachments.openContent(asset.id, range ?? {});
        const start = range?.start ?? 0;
        const end = range?.end ?? Math.max(0, asset.sizeBytes - 1);
        const length = range ? end - start + 1 : asset.sizeBytes;
        const headers: Record<string, string> = {
          "accept-ranges": "bytes",
          "cache-control": "private, immutable",
          "content-disposition": contentDisposition(asset.displayName),
          "content-length": String(length),
          "content-type": asset.mediaType,
          etag,
          "x-content-type-options": "nosniff",
        };
        if (range) {
          headers["content-range"] = `bytes ${start}-${end}/${asset.sizeBytes}`;
        }
        return new Response(opened.content, {
          status: range ? 206 : 200,
          headers,
        });
      } catch (error) {
        return attachmentErrorResponse(error);
      }
    })
    .get("/:id", (c) => {
      try {
        return jsonResponse(attachments.get(c.req.param("id")));
      } catch (error) {
        return attachmentErrorResponse(error);
      }
    })
    .delete("/:id", (c) => {
      try {
        return jsonResponse(attachments.delete(c.req.param("id")));
      } catch (error) {
        return attachmentErrorResponse(error);
      }
    });
}

export function contentDisposition(displayName: string): string {
  const safeName = displayName.replace(/[\r\n]/g, "");
  const fallback = Array.from(safeName, (character) => {
    const code = character.codePointAt(0)!;
    return code >= 0x20 && code <= 0x7e ? character : "_";
  })
    .join("")
    .replace(/["\\]/g, "_") || "attachment";
  const encoded = encodeURIComponent(safeName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new AttachmentError(
      "attachment_invalid_request",
      "content-length must be a non-negative safe integer",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AttachmentError(
      "attachment_invalid_request",
      "content-length must be a non-negative safe integer",
    );
  }
  return parsed;
}

function parseDeclaredMediaType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
    throw new AttachmentError(
      "attachment_invalid_request",
      "content-type must contain a valid media type",
    );
  }
  return mediaType;
}

function parseByteRange(value: string, size: number): ByteRange | undefined {
  if (size === 0 || !value.startsWith("bytes=") || value.includes(",")) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return undefined;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return undefined;

  if (!rawStart) {
    const suffixLength = parseRangeInteger(rawEnd!);
    if (suffixLength === undefined || suffixLength === 0) return undefined;
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = parseRangeInteger(rawStart);
  if (start === undefined || start >= size) return undefined;
  if (!rawEnd) return { start, end: size - 1 };
  const requestedEnd = parseRangeInteger(rawEnd);
  if (requestedEnd === undefined || requestedEnd < start) return undefined;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function parseRangeInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function assertReadyAsset(
  asset: AttachmentAssetRecord,
): asserts asset is AttachmentAssetRecord & {
  status: "ready";
  mediaType: string;
  sizeBytes: number;
  sha256: string;
} {
  if (
    asset.status !== "ready" ||
    !asset.mediaType ||
    asset.sizeBytes === undefined ||
    !asset.sha256
  ) {
    throw new AttachmentError(
      "attachment_not_ready",
      "attachment content is not ready",
    );
  }
}

function rangeNotSatisfiable(size: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      "accept-ranges": "bytes",
      "content-range": `bytes */${size}`,
    },
  });
}

function emptyByteStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}
