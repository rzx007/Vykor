import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsConflictError } from "@vykor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeSecrets, runtimeSecretsRevision, saveRuntimeSecrets } from "./runtime-secrets.js";

let directory = "";
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "vk-runtime-secrets-")); vi.stubEnv("VYKOR_CONFIG_DIR", directory); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe("runtime secret isolation and atomic edits", () => {
  it("keeps global and project values isolated and returns only the requested names", async () => {
    await saveRuntimeSecrets("global", { TOKEN: "global-token", OTHER: "global-other" });
    await saveRuntimeSecrets(join(directory, "project-a"), { TOKEN: "project-a-token" });
    await saveRuntimeSecrets(join(directory, "project-b"), { TOKEN: "project-b-token" });
    expect(await loadRuntimeSecrets("global", ["TOKEN"])).toEqual({ TOKEN: "global-token" });
    expect(await loadRuntimeSecrets(join(directory, "project-a"), ["TOKEN", "OTHER"])).toEqual({ TOKEN: "project-a-token" });
    expect(await loadRuntimeSecrets(join(directory, "project-b"), ["TOKEN"])).toEqual({ TOKEN: "project-b-token" });
    expect(await loadRuntimeSecrets("not-configured", ["TOKEN"])).toEqual({});
  });

  it("checks expected secret values as a group and does not partly apply a stale edit", async () => {
    await saveRuntimeSecrets("global", { TOKEN: "old", KEEP: "unchanged" });
    const before = await readFile(join(directory, "runtime-environment-secrets.json"), "utf8");
    await expect(saveRuntimeSecrets("global", { TOKEN: "next", KEEP: null }, { TOKEN: "stale", KEEP: "unchanged" })).rejects.toBeInstanceOf(SettingsConflictError);
    expect(await readFile(join(directory, "runtime-environment-secrets.json"), "utf8")).toBe(before);
    await saveRuntimeSecrets("global", { TOKEN: "next", KEEP: null }, { TOKEN: "old", KEEP: "unchanged" });
    expect(await loadRuntimeSecrets("global", ["TOKEN", "KEEP"])).toEqual({ TOKEN: "next" });
  });

  it("permits only one concurrent secret replacement with the same expected value", async () => {
    await saveRuntimeSecrets("global", { TOKEN: "initial" });
    const results = await Promise.allSettled([
      saveRuntimeSecrets("global", { TOKEN: "writer-a" }, { TOKEN: "initial" }),
      saveRuntimeSecrets("global", { TOKEN: "writer-b" }, { TOKEN: "initial" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(["writer-a", "writer-b"]).toContain((await loadRuntimeSecrets("global", ["TOKEN"])).TOKEN);
  });

  it("checks a read file revision without requiring a plaintext expected secret value", async () => {
    const initialRevision = await runtimeSecretsRevision();
    await saveRuntimeSecrets("global", { TOKEN: "initial-secret" }, undefined, initialRevision);
    const readRevision = await runtimeSecretsRevision();
    await saveRuntimeSecrets("global", { TOKEN: "first-secret" }, undefined, readRevision);
    expect(await runtimeSecretsRevision()).not.toBe(readRevision);
    await expect(saveRuntimeSecrets("global", { TOKEN: "second-secret" }, undefined, readRevision)).rejects.toBeInstanceOf(SettingsConflictError);
    expect(await loadRuntimeSecrets("global", ["TOKEN"])).toEqual({ TOKEN: "first-secret" });
  });

  it("validates every incoming variable before changing existing secret values", async () => {
    await saveRuntimeSecrets("global", { TOKEN: "keep" });
    await expect(saveRuntimeSecrets("global", { TOKEN: "replace", "INVALID=NAME": "invalid" })).rejects.toThrow("无效");
    expect(await loadRuntimeSecrets("global", ["TOKEN"])).toEqual({ TOKEN: "keep" });
    await expect(saveRuntimeSecrets("global", { TOKEN: "has\0null" })).rejects.toThrow("无效");
    expect(await loadRuntimeSecrets("global", ["TOKEN"])).toEqual({ TOKEN: "keep" });
  });

  it("rejects damaged secret storage instead of treating it as empty and overwriting it", async () => {
    const path = join(directory, "runtime-environment-secrets.json");
    await writeFile(path, "broken-json");
    await expect(loadRuntimeSecrets("global", ["TOKEN"])).rejects.toThrow();
    await expect(saveRuntimeSecrets("global", { TOKEN: "replacement" })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("broken-json");
  });
});
