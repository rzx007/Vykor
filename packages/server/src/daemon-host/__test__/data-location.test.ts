import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readRegisteredDataLocation } from "../data-location.js";
it("uses canonical product paths while keeping old location records import-only", async () => {
  const home = mkdtempSync(join(tmpdir(), "product-location-")), root = join(home, "root"), legacy = join(home, "runtime-data-location.json");
  vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home); vi.stubEnv("VYKOR_CONFIG_DIR", root); vi.stubEnv("VYKOR_DATA_DIR", undefined);
  mkdirSync(root); writeFileSync(legacy, JSON.stringify({ version: 1, location: { directory: join(home, "old"), storePath: join(home, "old/custom.db") } }));
  try {
    expect(await readRegisteredDataLocation(undefined, legacy)).toEqual({ directory: join(root, "data"), storePath: join(root, "data/session-runtime/sessions.db") });
    expect(existsSync(join(root, "data/session-runtime/sessions.db"))).toBe(false);
  } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); }
});
