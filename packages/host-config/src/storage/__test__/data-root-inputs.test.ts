import { existsSync, mkdtempSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeDataRoot, readDataRootSelector, selectDataRoot } from "../data-root-selection.js";

const homes: string[] = [];
const temporaryHome = () => { const home = mkdtempSync(join(tmpdir(), "root-inputs-")); homes.push(home); return home; };
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it.runIf(process.platform === "win32").each(["C:\\", "E:\\"].filter(path => process.platform !== "win32" || existsSync(path)))("rejects volume-relative inputs before any lock on %s", async cwd => {
  const home = temporaryHome();
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    for (const root of ["\\volume-relative", "/volume-relative", "C:relative"]) {
      expect(() => selectDataRoot({ explicitRoot: root, env: {}, homeDir: home })).toThrow(/absolute|complete/i);
      expect(() => selectDataRoot({ env: { VYKOR_CONFIG_DIR: root }, homeDir: home })).toThrow(/VYKOR_CONFIG_DIR/);
      await expect(initializeDataRoot({ explicitRoot: root, env: {}, homeDir: home })).rejects.toThrow(/absolute|complete/i);
      writeFileSync(join(home, ".vykor-root.json"), JSON.stringify({ version: 1, dataRoot: root }));
      expect(() => readDataRootSelector(home)).toThrow(/selector/i);
      rmSync(join(home, ".vykor-root.json"));
    }
    expect(readdirSync(home)).toEqual([]);
  } finally { process.chdir(previous); }
});

it("rejects a relative home even when the explicit root is complete", async () => {
  const root = temporaryHome();
  for (const input of [{ homeDir: "relative-home", env: {} }, { env: { HOME: "relative-home" } }, { env: { USERPROFILE: "relative-home" } }]) {
    await expect(initializeDataRoot({ ...input, explicitRoot: root })).rejects.toThrow(/home.*absolute|absolute.*home/i);
  }
});

it("retains only pre-initialization root inputs, including a shadowed external pin", async () => {
  vi.resetModules();
  const module = await import("../data-root-selection.js");
  const home = temporaryHome();
  const env = { VYKOR_CONFIG_DIR: join(home, "external-old"), VYKOR_DATA_DIR: join(home, "split"), SECRET: "never-capture" };
  await module.initializeDataRoot({ homeDir: home, explicitRoot: join(home, "selected"), env });
  expect(module.getInitializedDataRootInputs()).toEqual({ homeDir: home, explicitRoot: join(home, "selected"), environment: {
    VYKOR_CONFIG_DIR: join(home, "external-old"), VYKOR_DATA_DIR: join(home, "split"),
  } });
  expect(env.VYKOR_CONFIG_DIR).toBe(join(home, "selected"));
});

it.runIf(process.platform === "win32")("accepts a complete UNC share with a dotted server name", () => {
  const path = "\\\\server.example\\share\\root";
  expect(selectDataRoot({ explicitRoot: path, env: {}, homeDir: temporaryHome() }).dataRoot).toBe(path);
});

it.runIf(process.platform === "win32")("rejects a volume-relative selector before creating the home lock", async () => {
  const home = temporaryHome();
  writeFileSync(join(home, ".vykor-root.json"), JSON.stringify({ version: 1, dataRoot: "\\relative" }));
  const names: string[] = [];
  const watcher = watch(home, (_event, name) => { if (name) names.push(name.toString()); });
  try {
    await expect(initializeDataRoot({ homeDir: home, env: {} })).rejects.toThrow(/selector/);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(names).not.toContain(".vykor-root.json.lock");
  } finally { watcher.close(); }
});
