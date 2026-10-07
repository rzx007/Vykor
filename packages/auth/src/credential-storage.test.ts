import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialStorage } from "./credential-storage.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "vykor-credential-test-"));
  directories.push(directory);
  const path = join(directory, "credentials.json");
  return { directory, path, storage: new CredentialStorage(path) };
}
describe("atomic credential groups", () => {
  it("updates and deletes a group while retaining other values and providers", async () => {
    const { path, directory, storage } = await fixture();
    await storage.storeCredential("other", "api_key", "other-secret");
    await storage.updateCredentials("scope", { KEEP: "kept", REMOVE: "old" });
    await storage.updateCredentials("scope", { NEW: "new", REMOVE: null });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ other: { api_key: "other-secret" }, scope: { KEEP: "kept", NEW: "new" } });
    expect(await readdir(directory)).toEqual(["credentials.json"]);
  });
  it("treats prototype-shaped provider and key names as ordinary stored keys", async () => {
    const { storage } = await fixture();
    expect(await storage.loadCredential("constructor", "name")).toBeUndefined();
    await storage.updateCredentials("__proto__", JSON.parse('{"__proto__":"secret","constructor":"another"}'));
    expect(await storage.loadCredential("__proto__", "__proto__")).toBe("secret");
    expect(await storage.loadCredential("__proto__", "constructor")).toBe("another");
  });
  it("refuses corrupt credentials without overwriting the file", async () => {
    const { storage, path } = await fixture();
    await writeFile(path, "broken", "utf8");
    await expect(storage.storeApiKey("provider", "secret")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("broken");
  });
});
