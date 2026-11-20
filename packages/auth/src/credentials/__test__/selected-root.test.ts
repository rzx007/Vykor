import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { initializeDataRoot, readDataRootLockState } from "@vykor/host-config/paths";
import { CredentialStorage } from "../credential-storage.js";

it("reopens credentials in the initialized root and closes pending writes", async () => {
  const base = await mkdtemp(join(tmpdir(), "vykor-selected-credentials-"));
  const root = join(base, "root"), home = join(base, "home"); await mkdir(home);
  try {
    await initializeDataRoot({ explicitRoot: root, homeDir: home, env: {} });
    vi.stubEnv("VYKOR_CONFIG_DIR", join(base, "late-env"));
    const store = new CredentialStorage();
    await store.storeApiKey("test", "temporary-value");
    await store.close();
    const reopened = new CredentialStorage();
    expect(await reopened.loadApiKey("test")).toBe("temporary-value");
    expect(JSON.parse(await readFile(join(root, "credentials.json"), "utf8"))).toEqual({ test: { api_key: "temporary-value" } });
    await reopened.close();
    await expect(store.storeApiKey("test", "late-value")).rejects.toThrow(/closed/i);
    expect(await readdir(home)).toEqual([".vykor-root.json.lock"]);
    expect(readDataRootLockState(home)).toBeUndefined();
    expect(await readdir(base)).toEqual(expect.arrayContaining(["home", "root"]));
    expect(await readdir(base)).not.toContain("late-env");
  } finally { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); }
});
