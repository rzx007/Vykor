import { dirname, join } from "node:path";

import type { AttachmentLimits } from "@vykor/protocol";
import {
  AttachmentBlobStore,
  LightOcrEngine,
  LocalOcrService,
  type SessionStore,
} from "@vykor/services";

import { AttachmentService } from "./attachment-service.js";
import { SessionAttachmentResources } from "./resources/session-attachment-resources.js";

export function createDaemonAttachmentServices(input: {
  store: SessionStore;
  attachmentRoot?: string;
  attachmentLimits?: Partial<AttachmentLimits>;
  attachments?: AttachmentService;
}): {
  blobs: AttachmentBlobStore;
  attachments: AttachmentService;
  resources: SessionAttachmentResources;
  localOcr: LocalOcrService;
} {
  const { store } = input;
  const attachmentBlobs = new AttachmentBlobStore({
    root: input.attachmentRoot ?? join(dirname(store.path), "attachments"),
  });
  const attachments = input.attachments ?? new AttachmentService({
    store: store.attachments,
    blobs: attachmentBlobs,
    limits: input.attachmentLimits,
  });
  const resources = new SessionAttachmentResources({
    root: join(dirname(store.path), "attachment-session-resources"),
    attachments,
  });
  const localOcr = new LocalOcrService({
    engine: new LightOcrEngine(),
    resolveAsset: async (assetId, signal) => {
      signal?.throwIfAborted();
      const opened = await attachments.openContent(assetId);
      return {
        assetId,
        sha256: opened.sha256,
        mediaType: opened.mediaType,
        sizeBytes: opened.sizeBytes,
        bytes: await readAttachmentBytes(opened.content, opened.sizeBytes, signal),
      };
    },
    repository: {
      findCompleted: (assetId, cacheKey) =>
        store.attachments.findCompletedAttachmentRepresentation(assetId, "ocr_text", cacheKey),
      begin: (record) => store.attachments.createAttachmentRepresentation(record),
      complete: (id, output) => store.attachments.completeAttachmentRepresentation(id, output),
      fail: (id, error) => {
        store.attachments.failAttachmentRepresentation(id, error);
      },
    },
  });
  return { blobs: attachmentBlobs, attachments, resources, localOcr };
}

async function readAttachmentBytes(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > expectedBytes) throw new Error("attachment content exceeded recorded size");
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (size !== expectedBytes) throw new Error("attachment content size did not match its record");
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
