import { describe, expect, it, vi } from "vitest";
import { join, parse, resolve, sep } from "node:path";
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

describe("equivalent absolute override directories", () => {
  it.each([
    ["VYKOR_DATA_DIR", ["data"]],
    ["VYKOR_CHANNELS_DIR", ["channels"]],
    ["VYKOR_IMAGE_ATTACHMENT_CACHE_DIR", ["data", "attachments", "images"]],
  ] as const)("accepts trailing separators for %s without consulting cwd", (source, segments) => {
    const roots = [resolve("temporary-selected-root"), parse(resolve(".")).root];
    if (process.platform === "win32") roots.push("\\\\example.invalid\\share\\", "\\\\example.invalid\\share");
    for (const root of roots) {
      const expected = join(root, ...segments);
      const env = { [source]: `${expected}${sep}${sep}` };
      const cwd = vi.spyOn(process, "cwd").mockImplementation(() => { throw new Error("Override comparison must not read cwd"); });
      let conflicts: paths.LegacyDirectoryOverride[];
      try { conflicts = paths.inspectLegacyDirectoryOverrides(root, env); }
      finally { cwd.mockRestore(); }
      expect(conflicts).toEqual([]);
      expect(() => paths.assertNoLegacyDirectoryOverrides(root, env)).not.toThrow();
      expect(paths.inspectLegacyDirectoryOverrides(root, { [source]: root })).toEqual([{ source, value: root, expected }]);
    }
  });
});
