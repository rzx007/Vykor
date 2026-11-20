import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { vi } from "vitest";
import * as fs from "node:fs/promises";
import * as api from "../data-root-selection.js";
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "root-lock-recover-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
const deadPid = async (): Promise<number> => new Promise(resolve => { const child = spawn(process.execPath, ["-e", ""], { windowsHide: true }); child.once("exit", () => resolve(child.pid!)); });
const deadLock = async () => { const owner = { pid: await deadPid(), ownerToken: randomUUID() }; mkdirSync(join(home, ".vykor-root.json.lock/active"), { recursive: true }); writeFileSync(join(home, ".vykor-root.json.lock/active/owner.json"), JSON.stringify(owner)); return owner; };
it("serializes two recoverers through retained token claims without stealing the new live owner", async () => {
  const owner = await deadLock(); expect(api).toHaveProperty("withDataRootRecoveryLock");
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const first = (api as any).withDataRootRecoveryLock(home, async () => { entered(); await gate; }); await ready;
  let secondEntered = false;
  const second = (api as any).withDataRootRecoveryLock(home, async () => { secondEntered = true; }, { timeoutMs: 25, pollIntervalMs: 1 });
  try { await expect(second).rejects.toThrow(/busy/); expect(secondEntered).toBe(false); expect(JSON.parse(readFileSync(join(home, `.vykor-root.json.lock/claims/${owner.ownerToken}/owner.json`), "utf8"))).toEqual(owner); }
  finally { release(); await first; }
  await (api as any).withDataRootRecoveryLock(home, async () => undefined);
  expect(api.resolveDataRootSelection({ homeDir: home, env: {} }).dataRoot).toBe(join(home, ".vykor"));
});
it("recovers another valid dead owner after a prior recovery claimed its predecessor", async () => {
  const old = await deadLock(); expect(api).toHaveProperty("withDataRootRecoveryLock");
  await (api as any).withDataRootRecoveryLock(home, async () => undefined);
  const next = await deadLock(); await (api as any).withDataRootRecoveryLock(home, async () => undefined);
  for (const token of [old.ownerToken, next.ownerToken]) expect(existsSync(join(home, `.vykor-root.json.lock/claims/${token}/owner.json`))).toBe(true);
});
it.each(["", '{"pid":1,"ownerToken":"../escape"}']) ("preserves unfinished or malformed ownership without guessing", async body => {
  mkdirSync(join(home, ".vykor-root.json.lock/active"), { recursive: true }); writeFileSync(join(home, ".vykor-root.json.lock/active/owner.json"), body);
  expect(api).toHaveProperty("withDataRootRecoveryLock"); await expect((api as any).withDataRootRecoveryLock(home, async () => undefined)).rejects.toThrow(/owner/);
  expect(readFileSync(join(home, ".vykor-root.json.lock/active/owner.json"), "utf8")).toBe(body);
});
it("makes simultaneous dead-token claimers unable to move a replacement live lease", async () => {
  const old = await deadLock(), original = fs.rename;
  let claims = 0, claimed!: () => void, race!: () => void, entered!: () => void, release!: () => void;
  const bothReady = new Promise<void>(resolve => { claimed = resolve; }), raceGate = new Promise<void>(resolve => { race = resolve; });
  const firstInside = new Promise<void>(resolve => { entered = resolve; }), insideGate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to).endsWith(old.ownerToken)) { if (++claims === 2) claimed(); await raceGate; }
    return original(from, to);
  });
  let inside = 0, maximum = 0;
  const operation = async () => { inside++; maximum = Math.max(maximum, inside); entered(); await insideGate; inside--; };
  const first = api.withDataRootRecoveryLock(home, operation, { timeoutMs: 100, pollIntervalMs: 1 });
  const second = api.withDataRootRecoveryLock(home, operation, { timeoutMs: 100, pollIntervalMs: 1 });
  const outcomes = Promise.allSettled([first, second]); await bothReady; race(); await firstInside;
  expect(api.readDataRootLockState(home)?.pid).toBe(process.pid); release(); await outcomes;
  expect(maximum).toBe(1); expect(JSON.parse(readFileSync(join(home, `.vykor-root.json.lock/claims/${old.ownerToken}/owner.json`), "utf8"))).toEqual(old);
});
it("recovers after the previous recovery stopped immediately after claiming the dead lease", async () => {
  const old = await deadLock(), original = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { await original(from, to); if (String(to).endsWith(old.ownerToken)) throw new Error("recovery interrupted"); });
  await expect(api.withDataRootRecoveryLock(home, async () => undefined)).rejects.toThrow("recovery interrupted"); vi.restoreAllMocks();
  await api.withDataRootRecoveryLock(home, async () => undefined);
  expect(existsSync(join(home, `.vykor-root.json.lock/claims/${old.ownerToken}/owner.json`))).toBe(true);
});
it("never clears a committed-target pending pointer when recovering only a dead startup lease", async () => {
  await deadLock(); const selector = { version: 1, dataRoot: join(home, "new-target"), pendingMigration: { id: "committing", journalPath: join(home, "migration.json") } };
  writeFileSync(join(home, ".vykor-root.json"), JSON.stringify(selector));
  await api.withDataRootRecoveryLock(home, async () => undefined);
  expect(api.readDataRootSelector(home)).toEqual(selector); expect(() => api.resolveDataRootSelection({ homeDir: home, env: {} })).toThrow(/pending.*recover/i); expect(existsSync(selector.dataRoot)).toBe(false);
});
