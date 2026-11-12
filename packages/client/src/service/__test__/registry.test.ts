import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registryFile } from "../registry.js";
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, userInfo: vi.fn(actual.userInfo) };
});

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "sdk-root-")); });
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(userInfo).mockReset(); rmSync(home, { recursive: true, force: true }); });
it("uses the saved root with an explicit env without consulting the global root", () => {
  vi.stubEnv("VYKOR_CONFIG_DIR", join(home, "global"));
  const root = join(home, "saved");
  mkdirSync(join(root, "data", "session-runtime"), { recursive: true });
  writeFileSync(join(root, "data", "session-runtime", "sessions.db"), "existing database");
  writeFileSync(join(home, ".vykor-root.json"), JSON.stringify({ version: 1, dataRoot: root }));
  expect(registryFile({ HOME: home, USERPROFILE: home })).toBe(join(root, "data", "daemon", "registry.json"));
  expect(registryFile({ HOME: home, USERPROFILE: home, VYKOR_CONFIG_DIR: join(home, "explicit") })).toBe(join(home, "explicit", "data", "daemon", "registry.json"));
});
it("uses account home for an explicit empty env, independent of global HOME and USERPROFILE", () => {
  const account = join(home, "account");
  mkdirSync(account);
  vi.mocked(userInfo).mockReturnValue({ homedir: account, username: "test", uid: 1, gid: 1, shell: null });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  writeFileSync(join(home, ".vykor-root.json"), "corrupt global selector");
  expect(registryFile({})).toBe(join(account, ".vykor", "data", "daemon", "registry.json"));
});
it("rejects missing saved roots and pending migrations during discovery", () => {
  writeFileSync(join(home, ".vykor-root.json"), JSON.stringify({ version: 1, dataRoot: join(home, "missing") }));
  expect(() => registryFile({ HOME: home, USERPROFILE: home })).toThrow(/recover/);
  writeFileSync(join(home, ".vykor-root.json"), JSON.stringify({ version: 1, dataRoot: home, pendingMigration: { id: "migration", journalPath: join(home, "journal") } }));
  expect(() => registryFile({ HOME: home, USERPROFILE: home })).toThrow(/migration.*recover/);
});
