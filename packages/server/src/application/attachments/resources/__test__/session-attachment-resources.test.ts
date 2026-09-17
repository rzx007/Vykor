import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AttachmentBlobStore,
  SessionStore,
} from "@openharness/services";
import { afterEach, describe, expect, it } from "vitest";

import { AttachmentService } from "../../attachment-service.js";
import { SessionAttachmentResources } from "../session-attachment-resources.js";

const roots: string[] = [];
const stores: SessionStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function byteStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "oh-session-resources-"));
  roots.push(root);
  const store = new SessionStore({ path: join(root, "store.db") });
  stores.push(store);
  const attachments = new AttachmentService({
    store: store.attachments,
    blobs: new AttachmentBlobStore({ root: join(root, "blobs") }),
    id: () => "att_text",
  });
  const asset = await attachments.import({
    displayName: "large.log",
    declaredMediaType: "text/plain",
    content: byteStream("one\ntwo"),
  });
  const resources = new SessionAttachmentResources({
    root: join(root, "resources"),
    attachments,
  });
  return { asset, resources };
}

describe("SessionAttachmentResources", () => {
  it("isolates sessions, materializes only asset ids, and cleans each run", async () => {
    const { asset, resources } = await harness();
    const firstRoot = await resources.prepareSession("session-1");
    const secondRoot = await resources.prepareSession("session-2");
    expect(firstRoot).not.toBe(secondRoot);

    const cleanup = await resources.materializeRun({
      sessionId: "session-1",
      runId: "run-1",
      decisions: [{
        assetId: asset.id,
        intent: "auto",
        mediaType: "text/plain",
        route: "text_resource",
      }],
    });
    const runEntries = await readdir(join(firstRoot, "run-1"));
    expect(runEntries).toEqual([asset.id]);
    expect(await readFile(join(firstRoot, "run-1", asset.id), "utf8")).toBe("one\ntwo");

    await cleanup();
    await expect(access(join(firstRoot, "run-1"), constants.F_OK)).rejects.toThrow();
    await expect(readdir(secondRoot)).resolves.toEqual([]);
  });

  it("does not materialize inline text or blocked attachments", async () => {
    const { asset, resources } = await harness();
    const root = await resources.prepareSession("session-1");
    const cleanup = await resources.materializeRun({
      sessionId: "session-1",
      runId: "run-2",
      decisions: [
        { assetId: asset.id, intent: "auto", mediaType: "text/plain", route: "text_inline" },
        { assetId: "att_blocked", intent: "auto", mediaType: "application/pdf", route: "blocked", reason: "attachment_document_unsupported" },
      ],
    });
    await expect(readdir(join(root, "run-2"))).resolves.toEqual([]);
    await cleanup();
  });
});
