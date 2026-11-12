import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildUserContentWithAttachments } from "../main.js";

it("writes image bytes beneath the selected root instead of independent legacy directories", async () => {
  const base = await mkdtemp(join(tmpdir(), "vykor-image-root-"));
  try {
    vi.stubEnv("VYKOR_CONFIG_DIR", join(base, "root"));
    vi.stubEnv("VYKOR_DATA_DIR", join(base, "old-data"));
    vi.stubEnv("VYKOR_IMAGE_ATTACHMENT_CACHE_DIR", join(base, "old-images"));
    const blocks = await buildUserContentWithAttachments("look", [{ type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), media_type: "image/png" }]);
    expect(Array.isArray(blocks)).toBe(true);
    const image = (blocks as { source?: { path?: string } }[])[1]!;
    expect(image.source?.path?.startsWith(join(base, "root", "data", "attachments", "images"))).toBe(true);
    expect(await readFile(image.source!.path!)).toEqual(Buffer.from([1, 2, 3]));
    expect(await readdir(base)).toEqual(["root"]);
  } finally { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); }
});
