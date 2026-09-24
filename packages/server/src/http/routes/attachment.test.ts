import type { AttachmentAssetRecord } from "@vykor/protocol";
import { DEFAULT_ATTACHMENT_LIMITS } from "@vykor/protocol";
import { AttachmentError } from "@vykor/services";
import { describe, expect, it, vi } from "vitest";

import {
  contentDisposition,
  createAttachmentRoutes,
  type AttachmentRouteService,
} from "./attachment.js";

const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
const asset: AttachmentAssetRecord = {
  id: "att_test",
  displayName: "截图.png",
  declaredMediaType: "image/png",
  mediaType: "image/png",
  sizeBytes: bytes.byteLength,
  sha256: "a".repeat(64),
  status: "ready",
  createdAt: 1,
  updatedAt: 2,
};

function streamOf(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function createService(
  overrides: Partial<AttachmentRouteService> = {},
): AttachmentRouteService {
  return {
    limits: { ...DEFAULT_ATTACHMENT_LIMITS, maxBytesPerFile: 8 },
    import: vi.fn(async () => asset),
    get: vi.fn(() => asset),
    openContent: vi.fn(async (_id, range = {}) => ({
      asset,
      sha256: asset.sha256!,
      sizeBytes: asset.sizeBytes!,
      mediaType: asset.mediaType!,
      content: streamOf(
        bytes.subarray(range.start ?? 0, (range.end ?? bytes.length - 1) + 1),
      ),
    })),
    delete: vi.fn(() => ({ ...asset, status: "deleted", deletedAt: 3 })),
    ...overrides,
  };
}

describe("attachment routes", () => {
  it("validates upload headers before consuming the body", async () => {
    const service = createService();
    const app = createAttachmentRoutes(service);

    const missingName = await app.request("/", {
      method: "POST",
      body: new Blob([bytes]),
    });
    expect(missingName.status).toBe(400);
    expect(service.import).not.toHaveBeenCalled();

    const tooLarge = await app.request("/", {
      method: "POST",
      headers: {
        "content-length": "9",
        "x-vykor-filename": "a.bin",
      },
      body: new Blob([Uint8Array.of(1)]),
    });
    expect(tooLarge.status).toBe(413);
    expect(service.import).not.toHaveBeenCalled();

    const invalidLength = await app.request("/", {
      method: "POST",
      headers: {
        "content-length": "-1",
        "x-vykor-filename": "a.bin",
      },
    });
    expect(invalidLength.status).toBe(400);
  });

  it("streams raw uploads, including a zero-byte body", async () => {
    const imported: Array<{
      displayName: string;
      declaredMediaType?: string;
      body: Uint8Array;
    }> = [];
    const service = createService({
      import: vi.fn(async (input) => {
        imported.push({
          displayName: input.displayName,
          ...(input.declaredMediaType
            ? { declaredMediaType: input.declaredMediaType }
            : {}),
          body: await readAll(input.content),
        });
        return { ...asset, sizeBytes: imported.at(-1)!.body.byteLength };
      }),
    });
    const app = createAttachmentRoutes(service);

    const upload = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "IMAGE/PNG; charset=binary",
        "x-vykor-filename": encodeURIComponent("截图.png"),
      },
      body: new Blob([Uint8Array.of(1, 2, 3)]),
    });
    expect(upload.status).toBe(201);
    expect(imported[0]).toEqual({
      displayName: "截图.png",
      declaredMediaType: "image/png",
      body: Uint8Array.of(1, 2, 3),
    });

    const empty = await app.request("/", {
      method: "POST",
      headers: { "x-vykor-filename": "empty.txt" },
    });
    expect(empty.status).toBe(201);
    expect(imported[1]).toEqual({
      displayName: "empty.txt",
      body: new Uint8Array(),
    });
  });

  it("returns public metadata and logically deletes an attachment", async () => {
    const service = createService();
    const app = createAttachmentRoutes(service);

    const metadata = await app.request("/att_test");
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toEqual(asset);

    const deleted = await app.request("/att_test", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      id: "att_test",
      status: "deleted",
    });
    expect(service.delete).toHaveBeenCalledWith("att_test");
  });

  it("serves full, conditional and ranged content with safe headers", async () => {
    const service = createService();
    const app = createAttachmentRoutes(service);

    const full = await app.request("/att_test/content");
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("cache-control")).toBe("private, immutable");
    expect(full.headers.get("content-length")).toBe("8");
    expect(full.headers.get("content-type")).toBe("image/png");
    expect(full.headers.get("etag")).toBe(`"sha256-${asset.sha256}"`);
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(full.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E6%88%AA%E5%9B%BE.png",
    );
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);

    const notModified = await app.request("/att_test/content", {
      headers: { "if-none-match": `"sha256-${asset.sha256}"` },
    });
    expect(notModified.status).toBe(304);
    expect(service.openContent).toHaveBeenCalledTimes(1);

    const closed = await app.request("/att_test/content", {
      headers: { range: "bytes=2-5" },
    });
    expect(closed.status).toBe(206);
    expect(closed.headers.get("content-range")).toBe("bytes 2-5/8");
    expect(new Uint8Array(await closed.arrayBuffer())).toEqual(
      Uint8Array.of(2, 3, 4, 5),
    );

    const suffix = await app.request("/att_test/content", {
      headers: { range: "bytes=-2" },
    });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 6-7/8");
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(
      Uint8Array.of(6, 7),
    );
  });

  it.each(["bytes=9-10", "bytes=5-2", "bytes=0-1,3-4", "items=0-1"])(
    "rejects unsupported range %s",
    async (range) => {
      const app = createAttachmentRoutes(createService());
      const response = await app.request("/att_test/content", {
        headers: { range },
      });

      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */8");
    },
  );

  it("maps attachment errors without exposing storage details", async () => {
    const app = createAttachmentRoutes(
      createService({
        get: vi.fn(() => {
          throw new AttachmentError(
            "attachment_storage_failed",
            "attachment metadata is unavailable",
          );
        }),
      }),
    );

    const response = await app.request("/att_test");
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error:
        "attachment_storage_failed: attachment metadata is unavailable",
    });
  });

  it("returns a stable 409 when deleting an attachment still in use", async () => {
    const localPath = "C:\\private\\store.db";
    const app = createAttachmentRoutes(
      createService({
        delete: vi.fn(() => {
          throw new AttachmentError(
            "attachment_in_use",
            "attachment is referenced by a conversation",
          );
        }),
      }),
    );

    const response = await app.request("/att_test", { method: "DELETE" });
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain(
      "attachment_in_use: attachment is referenced by a conversation",
    );
    expect(body).not.toContain(localPath);
    expect(body).not.toContain("session_input_attachment");
    expect(body).not.toContain("SQLITE_CONSTRAINT");
  });

  it("hides unexpected database failures during attachment deletion", async () => {
    const app = createAttachmentRoutes(
      createService({
        delete: vi.fn(() => {
          throw new Error(
            "SQLITE_CONSTRAINT at C:\\private\\store.db session_input_attachment",
          );
        }),
      }),
    );

    const response = await app.request("/att_test", { method: "DELETE" });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Attachment request failed",
    });
  });

  it("maps content preflight failures before sending download headers", async () => {
    const localPath = "C:\\private\\attachments\\blobs\\aa\\secret";
    const app = createAttachmentRoutes(
      createService({
        openContent: vi.fn(async () => {
          throw new AttachmentError(
            "attachment_storage_failed",
            "attachment bytes are unavailable",
            true,
          );
        }),
      }),
    );

    const response = await app.request("/att_test/content");
    expect(response.status).toBe(500);
    expect(response.headers.get("content-disposition")).toBeNull();
    const body = await response.text();
    expect(body).not.toContain(localPath);
    expect(body).toContain("attachment bytes are unavailable");
  });

  it("generates a CRLF-safe RFC 5987 content disposition", () => {
    const value = contentDisposition('bad\r\n"name"-截图.png');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toContain("attachment; filename=");
    expect(value).toContain("filename*=UTF-8''");
  });
});
