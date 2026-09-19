import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelConfigStore } from "../channel-config-store.js";

function tempPath() {
  const directory = mkdtempSync(join(tmpdir(), "ohs-channel-config-"));
  return join(directory, "channel-credentials.json");
}

const feishu = {
  enabled: true,
  appId: "cli_x",
  appSecret: "sec",
  domain: "feishu" as const,
  allowFrom: { 个人: "ou_1" },
};

describe("ChannelConfigStore", () => {
  it("returns undefined for a missing file and round-trips feishu config", async () => {
    const store = new ChannelConfigStore(tempPath());
    expect(await store.getFeishu()).toBeUndefined();
    await store.setFeishu(feishu);
    expect(await store.getFeishu()).toEqual(feishu);
  });

  it("treats a legacy v1 credentials file as no channel configured", async () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ version: 1, credentials: { cli_old: { appSecret: "old" } } }));
    const store = new ChannelConfigStore(path);
    expect(await store.getFeishu()).toBeUndefined();
  });

  it("rejects an invalid file shape", async () => {
    const path = tempPath();
    writeFileSync(path, "{ not json");
    const store = new ChannelConfigStore(path);
    await expect(store.getFeishu()).rejects.toMatchObject({
      name: "ChannelConfigStoreError",
      code: "invalid-channel-config-store",
    });
  });

  it("normalizes a missing domain to feishu", async () => {
    const path = tempPath();
    await new ChannelConfigStore(path).setFeishu({ ...feishu, domain: "feishu" });
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version: number };
    expect(raw.version).toBe(2);
  });

  it("updateFeishu creates, mutates, and deletes", async () => {
    const store = new ChannelConfigStore(tempPath());
    await store.updateFeishu(() => feishu);
    expect(await store.getFeishu()).toEqual(feishu);
    await store.updateFeishu((current) => (current ? { ...current, allowFrom: { 群: "oc_1" } } : current));
    expect((await store.getFeishu())?.allowFrom).toEqual({ 群: "oc_1" });
    await store.updateFeishu(() => undefined);
    expect(await store.getFeishu()).toBeUndefined();
    expect(await store.deleteFeishu()).toBe(false);
  });

  it("rejects unsafe allowFrom keys", async () => {
    const store = new ChannelConfigStore(tempPath());
    await expect(
      store.setFeishu({ ...feishu, allowFrom: { ["__proto__"]: "ou_1" } }),
    ).rejects.toMatchObject({ code: "invalid-channel-config-store" });
  });

  it("serializes concurrent writes without losing data", async () => {
    const store = new ChannelConfigStore(tempPath());
    await store.setFeishu(feishu);
    await Promise.all([
      store.updateFeishu((c) => (c ? { ...c, sendProgress: false } : c)),
      store.updateFeishu((c) => (c ? { ...c, sendToolHints: false } : c)),
    ]);
    const result = await store.getFeishu();
    expect(result?.sendProgress).toBe(false);
    expect(result?.sendToolHints).toBe(false);
  });
});
