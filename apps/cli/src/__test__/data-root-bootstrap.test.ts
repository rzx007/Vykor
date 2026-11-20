import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import Database from "better-sqlite3";

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

it.each([{ options: [] }, { options: ["--register", "--host", "0.0.0.0", "--token", "owned-test"] }])("refuses legacy database selection for serve $options", ({ options }) => {
  const root = join(home, "root"), legacy = join(home, "legacy"), oldPath = join(legacy, "sessions.db");
  mkdirSync(legacy);
  const database = new Database(oldPath);
  database.exec("CREATE TABLE retained(id TEXT); INSERT INTO retained VALUES ('old-data')"); database.close();
  const original = readFileSync(oldPath);
  mkdirSync(join(root, "data", "daemon"), { recursive: true });
  writeFileSync(join(root, "data", "daemon", "data-location.json"), JSON.stringify({ version: 1, location: { directory: legacy, storePath: oldPath } }));
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
    fileURLToPath(new URL("../index.ts", import.meta.url)), "--data-root", root, "serve", ...options], {
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), CODEX_HOME: join(home, "codex"),
      VYKOR_CONFIG_DIR: undefined, VYKOR_DATA_DIR: undefined, VYKOR_CHANNELS_DIR: undefined, VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: undefined },
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("data-root migrate");
  expect(existsSync(join(root, "data", "session-runtime", "sessions.db"))).toBe(false);
  expect(readFileSync(oldPath)).toEqual(original);
});
