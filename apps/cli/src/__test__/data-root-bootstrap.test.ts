import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "cli-root-bootstrap-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

it.each(["{", JSON.stringify({ version: 1, dataRoot: "missing-relative-root" })])("stops before loading product stores for an invalid locator", selector => {
  writeFileSync(join(home, ".vykor-root.json"), selector);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, fileURLToPath(new URL("../index.ts", import.meta.url)), "serve", "--register"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, VYKOR_CONFIG_DIR: undefined, VYKOR_DATA_DIR: undefined },
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/vykor-root.json.*recover/);
  expect(readdirSync(home)).toEqual([".vykor-root.json"]);
});

it("reports all root-external overrides before loading product stores", () => {
  const root = join(home, "selected");
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, fileURLToPath(new URL("../index.ts", import.meta.url)), "--data-root", root, "serve", "--register"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, VYKOR_CONFIG_DIR: undefined, VYKOR_DATA_DIR: join(home, "old-data"), VYKOR_CHANNELS_DIR: join(home, "old-channels"), VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: join(home, "old-images") },
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("VYKOR_DATA_DIR");
  expect(result.stderr).toContain("VYKOR_CHANNELS_DIR");
  expect(result.stderr).toContain("VYKOR_IMAGE_ATTACHMENT_CACHE_DIR");
  expect(result.stderr).toContain(root);
  expect(readdirSync(home)).toEqual([]);
});
