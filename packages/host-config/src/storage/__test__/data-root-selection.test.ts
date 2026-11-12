import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { currentDataRoot, initializeDataRoot, parseDataRootArgument, readDataRootLockState, readDataRootSelector, resolveDataRootSelection, selectDataRoot, withDataRootLock, writeDataRootSelector } from "../data-root-selection.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "root-selection-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const input = () => ({ env: {}, homeDir: home });

it("selects explicit, environment, saved and default roots in order without writing", () => {
  const explicit = join(home, "explicit"), environment = join(home, "env"), saved = join(home, "saved");
  const selector = { version: 1 as const, dataRoot: saved };
  expect(selectDataRoot({ ...input(), explicitRoot: explicit, env: { VYKOR_CONFIG_DIR: environment }, selector })).toEqual({ dataRoot: explicit, source: "explicit" });
  expect(selectDataRoot({ ...input(), env: { VYKOR_CONFIG_DIR: environment }, selector })).toEqual({ dataRoot: environment, source: "environment" });
  expect(selectDataRoot({ ...input(), selector })).toEqual({ dataRoot: saved, source: "selector" });
  expect(resolveDataRootSelection(input())).toEqual({ dataRoot: join(home, ".vykor"), source: "default" });
  expect(readdirSync(home)).toEqual([]);
});

it.each(["", "  ", "relative/path"])("rejects invalid roots with their parameter source: %s", root => {
  expect(() => selectDataRoot({ ...input(), explicitRoot: root })).toThrow(/--data-root/);
  expect(() => selectDataRoot({ ...input(), env: { VYKOR_CONFIG_DIR: root } })).toThrow(/VYKOR_CONFIG_DIR/);
});

it("rejects corrupt selectors even when an environment override is present", () => {
  writeFileSync(join(home, ".vykor-root.json"), "{");
  expect(() => resolveDataRootSelection({ ...input(), env: { VYKOR_CONFIG_DIR: join(home, "other") } })).toThrow(/vykor-root.json.*recover/i);
  expect(existsSync(join(home, "other"))).toBe(false);
});

it("blocks interrupted migration before creating any data", async () => {
  await writeDataRootSelector(home, { version: 1, dataRoot: join(home, "old"), pendingMigration: { id: "move-1", journalPath: join(home, "journal.json") } });
  expect(() => resolveDataRootSelection(input())).toThrow(/move-1.*recover/i);
  expect(existsSync(join(home, "old"))).toBe(false);
});

it("does not create an empty root when the saved root is missing", async () => {
  const dataRoot = join(home, "missing-old-drive");
  await writeDataRootSelector(home, { version: 1, dataRoot });
  expect(() => resolveDataRootSelection(input())).toThrow(/missing.*recover/i);
  expect(() => resolveDataRootSelection({ ...input(), env: { VYKOR_CONFIG_DIR: dataRoot } })).toThrow(/missing.*recover/i);
  expect(existsSync(dataRoot)).toBe(false);
});

it.each(["empty mount point", "removed database"])("refuses a saved root with %s even though its directory exists", async scenario => {
  const dataRoot = join(home, "old-root");
  const database = join(dataRoot, "data", "session-runtime", "sessions.db");
  if (scenario === "removed database") {
    mkdirSync(join(dataRoot, "data", "session-runtime"), { recursive: true });
    writeFileSync(database, "previous database");
  } else mkdirSync(dataRoot);
  await writeDataRootSelector(home, { version: 1, dataRoot });
  rmSync(database, { force: true });
  expect(() => resolveDataRootSelection(input())).toThrow(/database.*recover/i);
  expect(() => resolveDataRootSelection({ ...input(), env: { VYKOR_CONFIG_DIR: dataRoot } })).toThrow(/database.*recover/i);
  expect(existsSync(database)).toBe(false);
  if (scenario === "empty mount point") expect(readdirSync(dataRoot)).toEqual([]);
});

it("refuses a source already marked as moved", () => {
  const root = join(home, "source");
  mkdirSync(join(root, "data", "migrations"), { recursive: true });
  writeFileSync(join(root, "data", "migrations", "moved-root.json"), "{}");
  expect(() => resolveDataRootSelection({ ...input(), explicitRoot: root })).toThrow(/moved.*recover/i);
});

it("serializes two starters and never steals an old lock from a live operation", async () => {
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withDataRootLock(home, async () => { acquired(); await gate; });
  await ready;
  const old = new Date(Date.now() - 120_000);
  utimesSync(join(home, ".vykor-root.json.lock"), old, old);
  try {
    await expect(withDataRootLock(home, async () => { throw new Error("stolen"); }, { timeoutMs: 30, pollIntervalMs: 5 })).rejects.toThrow(/lock.*recover/i);
  } finally { release(); await first; }
  await withDataRootLock(home, async () => undefined);
  expect(readdirSync(home)).toEqual([]);
});

it("writes atomically under the stable lock and reads only validated fields", async () => {
  const selector = { version: 1 as const, dataRoot: join(home, "selected") };
  await writeDataRootSelector(home, selector);
  expect(readDataRootSelector(home)).toEqual(selector);
  expect(JSON.parse(readFileSync(join(home, ".vykor-root.json"), "utf8"))).toEqual(selector);
  expect(readdirSync(home)).toEqual([".vykor-root.json"]);
});

it("initializes a process without creating a default root or selector", async () => {
  const env: Record<string, string | undefined> = {};
  const selected = await initializeDataRoot({ homeDir: home, env });
  expect(selected).toEqual({ dataRoot: join(home, ".vykor"), source: "default" });
  expect(env.VYKOR_CONFIG_DIR).toBe(selected.dataRoot);
  expect(readdirSync(home)).toEqual([]);
  const target = join(home, "new-root");
  mkdirSync(join(target, "data", "session-runtime"), { recursive: true });
  writeFileSync(join(target, "data", "session-runtime", "sessions.db"), "existing database");
  await writeDataRootSelector(home, { version: 1, dataRoot: target });
  expect(resolveDataRootSelection(input()).dataRoot).toBe(target);
  expect(currentDataRoot()).toBe(selected.dataRoot);
  await expect(initializeDataRoot({ ...input(), explicitRoot: target })).rejects.toThrow(/restart/);
});

it("reports a verifiable owner for crash recovery and blocks unlocked discovery while it is held", async () => {
  await withDataRootLock(home, async () => {
    expect(readDataRootLockState(home)).toMatchObject({ pid: process.pid, alive: true });
    expect(readDataRootLockState(home)?.ownerToken).toBeTruthy();
    expect(() => resolveDataRootSelection(input())).toThrow(/lock/);
  });
  expect(readDataRootLockState(home)).toBeUndefined();
});

it("does not recreate a missing database referenced by the old saved location", () => {
  const root = join(home, "root");
  mkdirSync(join(root, "data", "daemon"), { recursive: true });
  const directory = join(home, "old-external-data");
  writeFileSync(join(root, "data", "daemon", "data-location.json"), JSON.stringify({ version: 1, location: { directory, storePath: join(directory, "sessions.db") } }));
  expect(() => resolveDataRootSelection({ ...input(), explicitRoot: root })).toThrow(/database.*recover/i);
  expect(existsSync(directory)).toBe(false);
});

it("parses host roots without consuming literal prompt arguments", () => {
  const root = join(home, "with space");
  expect(parseDataRootArgument([`--data-root=${root}`, "serve", "--register"])).toEqual({ explicitRoot: root, argv: ["serve", "--register"] });
  expect(parseDataRootArgument(["--", "--data-root=literal prompt"])).toEqual({ argv: ["--", "--data-root=literal prompt"] });
  expect(() => parseDataRootArgument(["--data-root"])).toThrow(/--data-root/);
});

it.each(["--data-root", "--data-root=/some/path"])("preserves another CLI option's literal value %s", value => {
  const argv = ["--system-prompt", value, "-p", "hi"];
  expect(parseDataRootArgument(argv)).toEqual({ argv });
});
