import { CURRENT_PROTOCOL_VERSION, HttpTransport } from "@rzx/client";
import { expect, it } from "vitest";
import { AttachmentStorageResource } from "../attachment-storage-resource";

it("scans storage and sends explicit safe maintenance actions", async () => {
  const calls: Array<[string, string, unknown]> = [];
  const report = { summary: { assets: { importing: 0, ready: 0, failed: 0, deleted: 0 } }, issues: [] };
  const repair = { expiredLeases: 0, deletedOrphanBlobs: 0, releasedBytes: 0 };
  const gc = { scannedAssets: 0, expiredLeases: 0, deletedAssets: 0, deletedBlobs: 0, releasedBytes: 0, skipped: {}, errors: [] };
  const storage = new AttachmentStorageResource(new HttpTransport({ baseUrl: "http://daemon.test", fetch: async (url, init) => {
    const request = new Request(url, init);
    const path = new URL(request.url).pathname;
    if (path === "/capabilities") return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
    const body = request.body ? await request.json() : undefined;
    calls.push([request.method, path, body]);
    if (body?.action === "gc") return Response.json(gc);
    if (body?.action === "repair-safe") return Response.json(repair);
    return Response.json(report);
  } }));

  await expect(storage.scanStorage()).resolves.toEqual(report);
  await expect(storage.repairStorage()).resolves.toEqual(repair);
  await expect(storage.gcStorage()).resolves.toEqual(gc);
  expect(calls).toEqual([
    ["GET", "/attachments/storage", undefined],
    ["POST", "/attachments/storage/actions", { action: "repair-safe" }],
    ["POST", "/attachments/storage/actions", { action: "gc" }],
  ]);
});
