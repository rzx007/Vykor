import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ChannelCredentialStore } from "../channel-credential-store.js";

function tempStore() {
  const directory = mkdtempSync(join(tmpdir(), "ohs-channel-cred-"));
  return { path: join(directory, "channel-credentials.json"), directory };
}

describe("ChannelCredentialStore", () => {
  it("returns undefined for a missing file and round-trips secrets", async () => {
    const { path } = tempStore();
    const store = new ChannelCredentialStore(path);
    expect(await store.get("cli_a")).toBeUndefined();
    await store.set("cli_a", "secret-a");
    expect(await store.get("cli_a")).toBe("secret-a");
    await store.set("cli_a", "secret-b");
    expect(await store.get("cli_a")).toBe("secret-b");
    expect(await store.delete("cli_a")).toBe(true);
    expect(await store.get("cli_a")).toBeUndefined();
    expect(await store.delete("cli_a")).toBe(false);
  });

  it("throws a clear error for an invalid file", async () => {
    const { path } = tempStore();
    writeFileSync(path, "{ not json");
    const store = new ChannelCredentialStore(path);
    await expect(store.get("cli_a")).rejects.toMatchObject({
      name: "ChannelCredentialStoreError",
      code: "invalid-channel-credential-store",
    });
  });

  it("serializes concurrent writes without losing entries", async () => {
    const { path } = tempStore();
    const store = new ChannelCredentialStore(path);
    await Promise.all([
      store.set("cli_a", "a"),
      store.set("cli_b", "b"),
      store.set("cli_c", "c"),
    ]);
    expect(await store.get("cli_a")).toBe("a");
    expect(await store.get("cli_b")).toBe("b");
    expect(await store.get("cli_c")).toBe("c");
  });
});
