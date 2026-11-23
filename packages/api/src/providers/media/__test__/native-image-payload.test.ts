import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { prepareNativeImagePayload, replaceMissingToolResultImages } from "../native-image-payload.js";

describe("replaceMissingToolResultImages", () => {
  it("replaces a deleted historical image with text", async () => {
    const missing = join(tmpdir(), "vykor-deleted-history-image.png");

    await expect(replaceMissingToolResultImages([
      { type: "text", text: "page inspected" },
      { type: "image", source: { type: "file", mediaType: "image/png", path: missing } },
    ])).resolves.toEqual([
      { type: "text", text: "page inspected" },
      { type: "text", text: "[Historical image unavailable: vykor-deleted-history-image.png]" },
    ]);
  });

  it("encodes a transient tool image without looking for a file", async () => {
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHuoAAAAASUVORK5CYII=";
    const image = { type: "image", source: { type: "memory", mediaType: "image/png", width: 1, height: 1, data } } as const;
    await expect(replaceMissingToolResultImages([image])).resolves.toEqual([image]);
    await expect(prepareNativeImagePayload(image)).resolves.toMatchObject({
      base64: data, mediaType: "image/png", width: 1, height: 1, base64Bytes: data.length,
    });
  });
});
