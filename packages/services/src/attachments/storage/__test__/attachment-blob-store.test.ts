import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttachmentBlobStore } from "../attachment-blob-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function createStore(now = () => Date.now()): {
  root: string;
  store: AttachmentBlobStore;
} {
  const root = mkdtempSync(join(tmpdir(), "ohs-attachment-blobs-"));
  roots.push(root);
  return { root, store: new AttachmentBlobStore({ root, now }) };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    size += result.value.byteLength;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

describe("AttachmentBlobStore", () => {
  it("streams content into a hash-addressed blob", async () => {
    const { root, store } = createStore();
    const result = await store.import({
      uploadId: "att-1",
      content: streamOf([bytes("hello"), bytes(" world")]),
      declaredMediaType: "text/plain; charset=utf-8",
      maxBytes: 32,
    });
    const sha256 = createHash("sha256").update("hello world").digest("hex");

    expect(result).toEqual({
      sha256,
      sizeBytes: 11,
      mediaType: "text/plain",
      deduplicated: false,
    });
    expect(existsSync(join(root, "blobs", sha256.slice(0, 2), sha256))).toBe(
      true,
    );
    expect(readdirSync(join(root, "staging"))).toEqual([]);
  });

  it("keeps text detection when UTF-8 crosses the inspection boundary", async () => {
    const { store } = createStore();
    const content = bytes(`${"a".repeat(4_099)}世`);

    const result = await store.import({
      uploadId: "att-utf8-boundary",
      content: streamOf([content]),
      declaredMediaType: "text/plain",
      maxBytes: content.byteLength,
    });

    expect(result.mediaType).toBe("text/plain");
  });

  it("deduplicates identical bytes without creating a second blob", async () => {
    const { root, store } = createStore();
    const first = await store.import({
      uploadId: "att-1",
      content: streamOf([bytes("same")]),
      declaredMediaType: "text/plain",
      maxBytes: 32,
    });
    const second = await store.import({
      uploadId: "att-2",
      content: streamOf([bytes("same")]),
      declaredMediaType: "text/plain",
      maxBytes: 32,
    });

    expect(first.deduplicated).toBe(false);
    expect(second).toMatchObject({ sha256: first.sha256, deduplicated: true });
    expect(
      readdirSync(join(root, "blobs", first.sha256.slice(0, 2))),
    ).toEqual([first.sha256]);
    expect(readdirSync(join(root, "staging"))).toEqual([]);
  });

  it("cancels the source and removes staging when the byte limit is exceeded", async () => {
    const { root, store } = createStore();
    let cancelled = false;
    const content = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("too large"));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      store.import({ uploadId: "att-big", content, maxBytes: 4 }),
    ).rejects.toMatchObject({ code: "attachment_too_large" });
    expect(cancelled).toBe(true);
    expect(readdirSync(join(root, "staging"))).toEqual([]);
  });

  it("honors an aborted signal and removes staging", async () => {
    const { root, store } = createStore();
    const controller = new AbortController();
    controller.abort();

    await expect(
      store.import({
        uploadId: "att-abort",
        content: streamOf([bytes("ignored")]),
        maxBytes: 32,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "attachment_aborted" });
    expect(readdirSync(join(root, "staging"))).toEqual([]);
  });

  it("opens an inclusive byte range and rejects unsafe hashes", async () => {
    const { store } = createStore();
    const imported = await store.import({
      uploadId: "att-range",
      content: streamOf([bytes("0123456789")]),
      declaredMediaType: "text/plain",
      maxBytes: 32,
    });

    const content = await readAll(
      await store.open(imported.sha256, imported.sizeBytes, { start: 2, end: 5 }),
    );
    expect(new TextDecoder().decode(content)).toBe("2345");
    await expect(store.open("../store.db", imported.sizeBytes)).rejects.toThrow(
      "attachment_invalid_request",
    );
    await expect(
      store.open(imported.sha256, imported.sizeBytes, { start: 5, end: 2 }),
    ).rejects.toThrow("attachment_invalid_request");
  });

  it("rejects missing or truncated blobs before exposing a stream", async () => {
    const { root, store } = createStore();
    const imported = await store.import({
      uploadId: "att-corrupt",
      content: streamOf([bytes("private content")]),
      maxBytes: 32,
    });
    const blobPath = join(
      root,
      "blobs",
      imported.sha256.slice(0, 2),
      imported.sha256,
    );

    truncateSync(blobPath, 3);
    const truncated = await store
      .open(imported.sha256, imported.sizeBytes)
      .catch((error: unknown) => error);
    expect(truncated).toMatchObject({ code: "attachment_storage_failed" });
    expect(String(truncated)).toContain("attachment bytes are unavailable");
    expect(String(truncated)).not.toContain(root);

    unlinkSync(blobPath);
    const missing = await store.open(imported.sha256, imported.sizeBytes).catch(
      (error: unknown) => error,
    );
    expect(missing).toMatchObject({ code: "attachment_storage_failed" });
    expect(String(missing)).not.toContain(root);
  });

  it("resolves only an intact content-addressed regular file", async () => {
    const { root, store } = createStore();
    const imported = await store.import({
      uploadId: "att-path",
      content: streamOf([bytes("safe bytes")]),
      maxBytes: 32,
    });
    const expected = join(
      root,
      "blobs",
      imported.sha256.slice(0, 2),
      imported.sha256,
    );

    await expect(
      store.resolveReadOnlyPath(imported.sha256, imported.sizeBytes),
    ).resolves.toBe(expected);
    await expect(
      store.resolveReadOnlyPath(imported.sha256, imported.sizeBytes + 1),
    ).rejects.toMatchObject({ code: "attachment_storage_failed" });
    await expect(store.resolveReadOnlyPath("../unsafe", 1)).rejects.toMatchObject({
      code: "attachment_invalid_request",
    });
  });

  it("lists, inspects, and idempotently deletes only hash-addressed blobs", async () => {
    const { store } = createStore();
    const first = await store.import({
      uploadId: "att-list-a",
      content: streamOf([bytes("alpha")]),
      maxBytes: 32,
    });
    const second = await store.import({
      uploadId: "att-list-b",
      content: streamOf([bytes("beta")]),
      maxBytes: 32,
    });

    expect((await store.listBlobs()).map(({ sha256, sizeBytes }) => ({
      sha256,
      sizeBytes,
    }))).toEqual([
      { sha256: first.sha256, sizeBytes: 5 },
      { sha256: second.sha256, sizeBytes: 4 },
    ].sort((left, right) => left.sha256.localeCompare(right.sha256)));
    await expect(store.inspectBlob(first.sha256)).resolves.toEqual(
      expect.objectContaining({ sha256: first.sha256, sizeBytes: 5 }),
    );
    await expect(store.inspectBlob("../unsafe")).rejects.toMatchObject({
      code: "attachment_invalid_request",
    });

    await expect(store.deleteBlob(first.sha256)).resolves.toEqual({
      deleted: true,
      sizeBytes: 5,
    });
    await expect(store.deleteBlob(first.sha256)).resolves.toEqual({
      deleted: false,
      sizeBytes: 0,
    });
    await expect(store.inspectBlob(first.sha256)).resolves.toBeUndefined();
  });

  it("removes only expired unowned staging files", async () => {
    const now = 10_000;
    const { root, store } = createStore(() => now);
    const staging = join(root, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "expired.part"), "old");
    writeFileSync(join(staging, "active.part"), "active");
    writeFileSync(join(staging, "fresh.part"), "fresh");
    writeFileSync(join(staging, "diagnostic.txt"), "keep");
    utimesSync(join(staging, "expired.part"), 1, 1);
    utimesSync(join(staging, "active.part"), 1, 1);
    utimesSync(join(staging, "fresh.part"), 9, 9);

    const result = await store.recoverStaging({
      activeNames: new Set(["active.part"]),
      olderThan: 5_000,
    });

    expect(result.removed).toEqual(["expired.part"]);
    expect(result.retained.sort()).toEqual(
      ["active.part", "diagnostic.txt", "fresh.part"].sort(),
    );
    expect(result.recoverable.sort()).toEqual(
      ["active.part", "fresh.part"].sort(),
    );
    expect(readdirSync(staging).sort()).toEqual(
      ["active.part", "diagnostic.txt", "fresh.part"].sort(),
    );
  });
});
