import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "cli-root-command-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
    fileURLToPath(new URL("../../index.ts", import.meta.url)), "data-root", ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, VYKOR_CONFIG_DIR: undefined, VYKOR_DATA_DIR: join(home, "legacy"), VYKOR_CHANNELS_DIR: undefined, VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: undefined },
    encoding: "utf8", windowsHide: true, timeout: 45_000,
  });
}
it("inspects before normal selector/legacy guards without creating files", () => {
  writeFileSync(join(home, ".vykor-root.json"), "{");
  const result = run(["inspect", "--from", join(home, "source"), "--to", join(home, "target")]);
  expect(result.status).toBe(0);
  const preview = JSON.parse(result.stdout);
  expect(preview).toMatchObject({ source: { path: join(home, "source"), origin: "--from" }, target: { path: join(home, "target"), origin: "--to" }, preview: { files: 0, bytes: 0 } });
  expect(preview.preview.impacts.length).toBeGreaterThan(0);
  expect(readdirSync(home)).toEqual([".vykor-root.json"]);
});
it("recovers a verifiably dead startup lock without a journal, repeatedly", () => {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", windowsHide: true });
  const active = join(home, ".vykor-root.json.lock/active");
  mkdirSync(active, { recursive: true });
  writeFileSync(join(active, "owner.json"), JSON.stringify({ pid: Number(child.stdout), ownerToken: randomUUID() }));
  for (let i = 0; i < 2; i++) {
    const result = run(["recover", "--startup-lock"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ recovered: "startup-lock" });
  }
  expect(readdirSync(join(home, ".vykor-root.json.lock"))).not.toContain("active");
});
it("refuses journal-free recovery when a migration is pending", () => {
  const selector = JSON.stringify({ version: 1, dataRoot: join(home, "source"), pendingMigration: { id: "pending", journalPath: join(home, "migration.json") } });
  writeFileSync(join(home, ".vykor-root.json"), selector);
  const result = run(["recover", "--startup-lock"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("recover --journal");
  expect(readFileSync(join(home, ".vykor-root.json"), "utf8")).toBe(selector);
});
it.each(["live", "malformed"])("preserves an unverifiable %s startup lock", state => {
  const active = join(home, ".vykor-root.json.lock/active"), value = state === "live" ? JSON.stringify({ pid: process.pid, ownerToken: randomUUID() }) : "{";
  mkdirSync(active, { recursive: true }); writeFileSync(join(active, "owner.json"), value);
  const result = run(["recover", "--startup-lock"]);
  expect(result.status).toBe(1);
  expect(readFileSync(join(active, "owner.json"), "utf8")).toBe(value);
});
