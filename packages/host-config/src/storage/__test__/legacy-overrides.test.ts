import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import * as paths from "../paths.js";

describe("legacy directory override preflight", () => {
  it("reports every conflicting source and accepts equivalent canonical paths", () => {
    const root = resolve("temporary-selected-root");
    const env = { VYKOR_DATA_DIR: resolve("old-data"), VYKOR_CHANNELS_DIR: resolve(root, "channels"), VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: resolve("old-images") };
    expect(paths.inspectLegacyDirectoryOverrides(root, env)).toEqual([
      { source: "VYKOR_DATA_DIR", value: env.VYKOR_DATA_DIR, expected: resolve(root, "data") },
      { source: "VYKOR_IMAGE_ATTACHMENT_CACHE_DIR", value: env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR, expected: resolve(root, "data/attachments/images") },
    ]);
    expect(() => paths.assertNoLegacyDirectoryOverrides(root, env)).toThrow(/VYKOR_DATA_DIR.*old-data[\s\S]*VYKOR_IMAGE_ATTACHMENT_CACHE_DIR.*old-images/);
    expect(paths.inspectLegacyDirectoryOverrides(root, { VYKOR_DATA_DIR: resolve(root, "data/../data") })).toEqual([]);
    expect(paths.inspectLegacyDirectoryOverrides(root, { VYKOR_DATA_DIR: "temporary-selected-root/data" })).toHaveLength(1);
  });
});
