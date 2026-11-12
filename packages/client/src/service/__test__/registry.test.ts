import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registryFile } from "../registry.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "sdk-root-")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
it("uses the saved root with an explicit env without consulting the global root", () => {
  vi.stubEnv("VYKOR_CONFIG_DIR", join(home, "global"));
  const root = join(home, "saved");
  mkdirSync(root);
  writeFileSync(join(home, ".vykor-root.json"), JSON.stringify({ version: 1, dataRoot: root }));
  expect(registryFile({ HOME: home, USERPROFILE: home })).toBe(join(root, "data", "daemon", "registry.json"));
  expect(registryFile({ HOME: home, USERPROFILE: home, VYKOR_CONFIG_DIR: join(home, "explicit") })).toBe(join(home, "explicit", "data", "daemon", "registry.json"));
});
it("rejects missing saved roots and pending migrations during discovery", () => {
  writeFileSync(join(home, ".vykor-root.json"), JSON.stringify({ version: 1, dataRoot: join(home, "missing") }));
  expect(() => registryFile({ HOME: home, USERPROFILE: home })).toThrow(/recover/);
  writeFileSync(join(home, ".vykor-root.json"), JSON.stringify({ version: 1, dataRoot: home, pendingMigration: { id: "migration", journalPath: join(home, "journal") } }));
  expect(() => registryFile({ HOME: home, USERPROFILE: home })).toThrow(/migration.*recover/);
});
