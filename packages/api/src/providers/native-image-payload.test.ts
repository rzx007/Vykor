import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { replaceMissingToolResultImages } from "./native-image-payload.js";

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
});
